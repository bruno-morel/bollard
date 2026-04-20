import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import type { LanguageId, ToolchainProfile } from "@bollard/detect/src/types.js"
import { BollardError } from "@bollard/engine/src/errors.js"

const execFileAsync = promisify(execFile)

export interface MutationTestResult {
  score: number
  killed: number
  survived: number
  noCoverage: number
  timeout: number
  totalMutants: number
  duration_ms: number
  reportPath?: string
}

export interface MutationTestingProvider {
  readonly language: LanguageId
  run(
    workDir: string,
    profile: ToolchainProfile,
    mutateFiles?: string[],
  ): Promise<MutationTestResult>
}

const ZERO_RESULT: MutationTestResult = {
  score: 0,
  killed: 0,
  survived: 0,
  noCoverage: 0,
  timeout: 0,
  totalMutants: 0,
  duration_ms: 0,
}

interface StrykerMutant {
  id: string
  mutatorName: string
  status: string
}

interface StrykerFileEntry {
  language: string
  source: string
  mutants: StrykerMutant[]
}

interface StrykerReport {
  schemaVersion: string
  thresholds: { high: number; low: number }
  files: Record<string, StrykerFileEntry>
}

const COUNTED_STATUSES = new Set(["Killed", "Survived", "NoCoverage", "Timeout"])

export function parseStrykerReport(reportJson: string): MutationTestResult {
  let report: StrykerReport
  try {
    report = JSON.parse(reportJson) as StrykerReport
  } catch {
    return { ...ZERO_RESULT }
  }

  if (!report.files || typeof report.files !== "object") {
    return { ...ZERO_RESULT }
  }

  let killed = 0
  let survived = 0
  let noCoverage = 0
  let timeout = 0

  for (const file of Object.values(report.files)) {
    if (!Array.isArray(file.mutants)) continue
    for (const mutant of file.mutants) {
      if (!COUNTED_STATUSES.has(mutant.status)) continue
      switch (mutant.status) {
        case "Killed":
          killed++
          break
        case "Survived":
          survived++
          break
        case "NoCoverage":
          noCoverage++
          break
        case "Timeout":
          timeout++
          break
      }
    }
  }

  const totalMutants = killed + survived + noCoverage + timeout
  const score = totalMutants > 0 ? ((killed + timeout) / totalMutants) * 100 : 0

  return {
    score,
    killed,
    survived,
    noCoverage,
    timeout,
    totalMutants,
    duration_ms: 0,
  }
}

const TEST_FILE_PATTERN = /\.test\.|\.spec\.|__tests__/

function deriveVitestConfigFile(profile: ToolchainProfile): string {
  const testArgs = profile.checks.test?.args
  if (testArgs) {
    for (let i = 0; i < testArgs.length; i++) {
      const next = testArgs[i + 1]
      if ((testArgs[i] === "-c" || testArgs[i] === "--config") && next) {
        return next
      }
    }
  }
  return "vitest.config.ts"
}

function deriveMutatePatterns(profile: ToolchainProfile): string[] {
  const source = profile.sourcePatterns
  if (source.length === 0) {
    return ["src/**/*.ts", "!src/**/*.test.ts"]
  }

  const mutate: string[] = []
  for (const pattern of source) {
    if (TEST_FILE_PATTERN.test(pattern)) continue
    mutate.push(pattern)
  }

  for (const pattern of mutate) {
    const ext = pattern.match(/\*(\.\w+)$/)
    if (ext) {
      mutate.push(`!**/*.test${ext[1]}`)
      mutate.push(`!**/*.spec${ext[1]}`)
      mutate.push("!**/__tests__/**")
      break
    }
  }

  return mutate
}

/** Maps a source glob pattern to a directory path for mutmut --paths-to-mutate. */
export function patternToDirectoryPath(pattern: string): string {
  const starIdx = pattern.indexOf("**")
  if (starIdx === -1) {
    const base = pattern.replace(/\/[^/]*\*.*$/, "").replace(/\/+$/, "")
    return base.length > 0 ? base : "."
  }
  const prefix = pattern.slice(0, starIdx).replace(/\/+$/, "")
  return prefix.length > 0 ? prefix : "."
}

/** Derive comma-separated directory paths from Python source patterns (excludes test globs). */
export function derivePythonPathsForMutmut(profile: ToolchainProfile): string {
  const dirs = new Set<string>()
  for (const pattern of profile.sourcePatterns) {
    if (TEST_FILE_PATTERN.test(pattern)) continue
    dirs.add(patternToDirectoryPath(pattern))
  }
  if (dirs.size === 0) {
    return "src"
  }
  return [...dirs].sort().join(",")
}

/** Parse `mutmut results` stdout/stderr for killed/survived counts. */
export function parseMutmutResultsOutput(text: string): {
  killed: number
  survived: number
  totalMutants: number
} {
  const killedMatch = text.match(/Killed mutants\s*\((\d+)\s+of\s+(\d+)\)/i)
  const survivedMatch = text.match(/Survived mutants\s*\((\d+)\s+of\s+(\d+)\)/i)

  let killed = 0
  let survived = 0
  let totalMutants = 0

  if (killedMatch && survivedMatch) {
    killed = Number.parseInt(killedMatch[1] ?? "0", 10)
    survived = Number.parseInt(survivedMatch[1] ?? "0", 10)
    const tk = Number.parseInt(killedMatch[2] ?? "0", 10)
    const ts = Number.parseInt(survivedMatch[2] ?? "0", 10)
    totalMutants = tk > 0 ? tk : ts
    if (totalMutants === 0) {
      totalMutants = killed + survived
    }
    return { killed, survived, totalMutants }
  }

  if (killedMatch) {
    killed = Number.parseInt(killedMatch[1] ?? "0", 10)
    totalMutants = Number.parseInt(killedMatch[2] ?? "0", 10)
    survived = Math.max(0, totalMutants - killed)
    return { killed, survived, totalMutants }
  }

  if (survivedMatch) {
    survived = Number.parseInt(survivedMatch[1] ?? "0", 10)
    totalMutants = Number.parseInt(survivedMatch[2] ?? "0", 10)
    killed = Math.max(0, totalMutants - survived)
    return { killed, survived, totalMutants }
  }

  return { killed: 0, survived: 0, totalMutants: 0 }
}

function isExecNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  )
}

export class MutmutProvider implements MutationTestingProvider {
  readonly language: LanguageId = "python"

  async run(
    workDir: string,
    profile: ToolchainProfile,
    mutateFiles?: string[],
  ): Promise<MutationTestResult> {
    const startMs = Date.now()
    const pathsArg =
      mutateFiles && mutateFiles.length > 0
        ? mutateFiles.join(",")
        : derivePythonPathsForMutmut(profile)
    const timeout = profile.mutation?.timeoutMs ?? 300_000

    try {
      await execFileAsync("mutmut", ["run", "--paths-to-mutate", pathsArg, "--no-progress"], {
        cwd: workDir,
        maxBuffer: 10 * 1024 * 1024,
        timeout,
      })
    } catch (err: unknown) {
      if (isExecNotFound(err)) {
        throw new BollardError({
          code: "NODE_EXECUTION_FAILED",
          message:
            "mutmut not found on PATH — install with: pip install mutmut (or add to your Python environment)",
          ...(err instanceof Error ? { cause: err } : {}),
        })
      }
      process.stderr.write(
        `bollard: mutmut run failed: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      return { ...ZERO_RESULT, duration_ms: Date.now() - startMs }
    }

    let resultsText = ""
    try {
      const { stdout, stderr } = await execFileAsync("mutmut", ["results"], {
        cwd: workDir,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60_000,
      })
      resultsText = `${stdout}\n${stderr}`
    } catch (err: unknown) {
      if (isExecNotFound(err)) {
        throw new BollardError({
          code: "NODE_EXECUTION_FAILED",
          message:
            "mutmut not found on PATH — install with: pip install mutmut (or add to your Python environment)",
          ...(err instanceof Error ? { cause: err } : {}),
        })
      }
      process.stderr.write(
        `bollard: mutmut results failed: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      return { ...ZERO_RESULT, duration_ms: Date.now() - startMs }
    }

    const { killed, survived, totalMutants } = parseMutmutResultsOutput(resultsText)
    const score = totalMutants > 0 ? (killed / totalMutants) * 100 : 0

    return {
      score,
      killed,
      survived,
      noCoverage: 0,
      timeout: 0,
      totalMutants,
      duration_ms: Date.now() - startMs,
    }
  }
}

interface CargoMutantOutcome {
  scenario?: string
  summary?: string
}

/** Parse cargo-mutants `mutants.out/outcomes.json` into mutation counts. */
export function parseCargoMutantsOutcomes(jsonText: string): {
  killed: number
  survived: number
  timeout: number
  totalMutants: number
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText) as unknown
  } catch {
    return { killed: 0, survived: 0, timeout: 0, totalMutants: 0 }
  }

  const rows: CargoMutantOutcome[] = Array.isArray(parsed)
    ? (parsed as CargoMutantOutcome[])
    : parsed !== null &&
        typeof parsed === "object" &&
        Array.isArray((parsed as Record<string, unknown>)["outcomes"])
      ? ((parsed as Record<string, unknown>)["outcomes"] as CargoMutantOutcome[])
      : []

  let killed = 0
  let survived = 0
  let timeout = 0

  for (const row of rows) {
    const s = row.summary ?? ""
    if (s === "Success" || s === "CaughtMutant") {
      killed++
    } else if (s === "MissedMutant") {
      survived++
    } else if (s === "Timeout") {
      timeout++
    }
  }

  const totalMutants = killed + survived + timeout
  return { killed, survived, timeout, totalMutants }
}

export class CargoMutantsProvider implements MutationTestingProvider {
  readonly language: LanguageId = "rust"

  async run(
    workDir: string,
    profile: ToolchainProfile,
    mutateFiles?: string[],
  ): Promise<MutationTestResult> {
    const startMs = Date.now()
    const timeout = profile.mutation?.timeoutMs ?? 300_000
    const outcomesPath = join(workDir, "mutants.out", "outcomes.json")

    const args = ["mutants", "--json", "--no-shuffle"]
    if (mutateFiles && mutateFiles.length > 0) {
      for (const f of mutateFiles) {
        args.push("--file", f)
      }
    }

    try {
      await execFileAsync("cargo", args, {
        cwd: workDir,
        maxBuffer: 10 * 1024 * 1024,
        timeout,
      })
    } catch (err: unknown) {
      if (isExecNotFound(err)) {
        throw new BollardError({
          code: "NODE_EXECUTION_FAILED",
          message: "cargo not found on PATH — Rust toolchain required for cargo-mutants",
          ...(err instanceof Error ? { cause: err } : {}),
        })
      }
      const stderr =
        err && typeof err === "object" && "stderr" in err
          ? String((err as { stderr: string | Buffer }).stderr)
          : ""
      const combined = `${err instanceof Error ? err.message : String(err)}\n${stderr}`
      if (
        /no such command:\s*`?mutants`?/i.test(combined) ||
        /unknown command\s+['"]?mutants['"]?/i.test(combined)
      ) {
        throw new BollardError({
          code: "NODE_EXECUTION_FAILED",
          message: "cargo-mutants not found — install with: cargo install cargo-mutants",
          ...(err instanceof Error ? { cause: err } : {}),
        })
      }
      process.stderr.write(
        `bollard: cargo mutants failed: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      return { ...ZERO_RESULT, duration_ms: Date.now() - startMs }
    }

    let jsonText: string
    try {
      jsonText = await readFile(outcomesPath, "utf-8")
    } catch (err: unknown) {
      process.stderr.write(
        `bollard: cargo-mutants outcomes not found at ${outcomesPath}: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      return { ...ZERO_RESULT, duration_ms: Date.now() - startMs }
    }

    const {
      killed,
      survived,
      timeout: timeoutCount,
      totalMutants,
    } = parseCargoMutantsOutcomes(jsonText)
    const score = totalMutants > 0 ? ((killed + timeoutCount) / totalMutants) * 100 : 0

    return {
      score,
      killed,
      survived,
      noCoverage: 0,
      timeout: timeoutCount,
      totalMutants,
      duration_ms: Date.now() - startMs,
      reportPath: outcomesPath,
    }
  }
}

export class StrykerProvider implements MutationTestingProvider {
  readonly language: LanguageId = "typescript"

  async run(
    workDir: string,
    profile: ToolchainProfile,
    mutateFiles?: string[],
  ): Promise<MutationTestResult> {
    const startMs = Date.now()
    const reportPath = join(workDir, "reports", "mutation", "mutation.json")

    const mutatePatterns =
      mutateFiles && mutateFiles.length > 0 ? mutateFiles : deriveMutatePatterns(profile)

    const config = {
      testRunner: "vitest",
      vitest: {
        configFile: deriveVitestConfigFile(profile),
      },
      mutate: mutatePatterns,
      reporters: ["json", "clear-text"],
      jsonReporter: { fileName: "reports/mutation/mutation.json" },
      thresholds: { high: profile.mutation?.threshold ?? 80, low: 60, break: null },
      concurrency: profile.mutation?.concurrency ?? 2,
      timeoutMS: profile.mutation?.timeoutMs ?? 300_000,
    }

    try {
      await writeFile(
        join(workDir, "stryker.config.json"),
        JSON.stringify(config, null, 2),
        "utf-8",
      )
    } catch (err: unknown) {
      process.stderr.write(
        `bollard: failed to write stryker config: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      return { ...ZERO_RESULT, duration_ms: Date.now() - startMs }
    }

    try {
      await execFileAsync("pnpm", ["exec", "stryker", "run"], {
        cwd: workDir,
        maxBuffer: 10 * 1024 * 1024,
        timeout: profile.mutation?.timeoutMs ?? 300_000,
      })
    } catch (err: unknown) {
      process.stderr.write(
        `bollard: stryker execution failed: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      return { ...ZERO_RESULT, duration_ms: Date.now() - startMs }
    }

    let reportJson: string
    try {
      reportJson = await readFile(reportPath, "utf-8")
    } catch (err: unknown) {
      process.stderr.write(
        `bollard: stryker report not found at ${reportPath}: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      return { ...ZERO_RESULT, duration_ms: Date.now() - startMs }
    }

    const result = parseStrykerReport(reportJson)
    return {
      ...result,
      duration_ms: Date.now() - startMs,
      ...(reportPath ? { reportPath } : {}),
    }
  }
}

/** Map source paths to FQCNs for PIT `-DtargetClasses`. */
export function derivePitTargetClasses(
  mutateFiles: string[] | undefined,
  _profile: ToolchainProfile,
): string {
  if (!mutateFiles || mutateFiles.length === 0) {
    return "*"
  }
  const classes: string[] = []
  for (const f of mutateFiles) {
    const norm = f.replace(/\\/g, "/")
    const m = norm.match(/src\/main\/(?:java|kotlin)\/(.+)\.(java|kt)$/)
    if (m?.[1]) {
      classes.push(m[1].replace(/\//g, "."))
    }
  }
  return classes.length > 0 ? classes.join(",") : "*"
}

/** Parse PIT `mutations.xml` (regex-based, no XML dependency). */
export function parsePitReport(xmlText: string): MutationTestResult {
  let killed = 0
  let survived = 0
  let noCoverage = 0
  let timeout = 0
  const re = /status="(KILLED|SURVIVED|NO_COVERAGE|TIMED_OUT|RUN_ERROR)"/gi
  let m: RegExpExecArray | null
  while (true) {
    m = re.exec(xmlText)
    if (m === null) break
    const s = m[1]?.toUpperCase()
    if (s === "KILLED") killed++
    else if (s === "SURVIVED") survived++
    else if (s === "NO_COVERAGE") noCoverage++
    else if (s === "TIMED_OUT" || s === "RUN_ERROR") timeout++
  }
  const totalMutants = killed + survived + noCoverage + timeout
  const score = totalMutants > 0 ? ((killed + timeout) / totalMutants) * 100 : 0
  return {
    score,
    killed,
    survived,
    noCoverage,
    timeout,
    totalMutants,
    duration_ms: 0,
  }
}

async function findPitMutationsXml(workDir: string): Promise<string | undefined> {
  const candidates = [
    join(workDir, "target/pit-reports/mutations.xml"),
    join(workDir, "build/reports/pitest/mutations.xml"),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  try {
    const pitRoot = join(workDir, "target/pit-reports")
    const entries = await readdir(pitRoot, { withFileTypes: true })
    for (const e of entries) {
      if (e.isDirectory()) {
        const p = join(pitRoot, e.name, "mutations.xml")
        if (existsSync(p)) return p
      }
    }
  } catch {
    /* no pit reports */
  }
  return undefined
}

export class PitestProvider implements MutationTestingProvider {
  readonly language: LanguageId = "java"

  async run(
    workDir: string,
    profile: ToolchainProfile,
    mutateFiles?: string[],
  ): Promise<MutationTestResult> {
    const startMs = Date.now()
    const isGradle = profile.packageManager === "gradle"
    const targetClasses = derivePitTargetClasses(mutateFiles, profile)
    const timeout = profile.mutation?.timeoutMs ?? 600_000

    if (isGradle) {
      const gradlew = join(workDir, "gradlew")
      const cmd = existsSync(gradlew) ? "./gradlew" : "gradle"
      try {
        await execFileAsync(
          cmd,
          [
            "pitest",
            `-DtargetClasses=${targetClasses}`,
            "-DoutputFormats=XML",
            "-DtimestampedReports=false",
          ],
          {
            cwd: workDir,
            maxBuffer: 10 * 1024 * 1024,
            timeout,
          },
        )
      } catch (err: unknown) {
        if (isExecNotFound(err)) {
          throw new BollardError({
            code: "NODE_EXECUTION_FAILED",
            message:
              "gradle/gradlew not found — add Gradle wrapper or use dev-full image with Gradle on PATH",
            ...(err instanceof Error ? { cause: err } : {}),
          })
        }
        process.stderr.write(
          `bollard: pitest (gradle) failed: ${err instanceof Error ? err.message : String(err)}\n`,
        )
        return { ...ZERO_RESULT, duration_ms: Date.now() - startMs }
      }
    } else {
      try {
        await execFileAsync(
          "mvn",
          [
            "org.pitest:pitest-maven:mutationCoverage",
            `-DtargetClasses=${targetClasses}`,
            "-DoutputFormats=XML",
            "-DtimestampedReports=false",
            "-q",
          ],
          {
            cwd: workDir,
            maxBuffer: 10 * 1024 * 1024,
            timeout,
          },
        )
      } catch (err: unknown) {
        if (isExecNotFound(err)) {
          throw new BollardError({
            code: "NODE_EXECUTION_FAILED",
            message: "mvn not found — install Maven or use the dev-full image",
            ...(err instanceof Error ? { cause: err } : {}),
          })
        }
        process.stderr.write(
          `bollard: pitest (maven) failed: ${err instanceof Error ? err.message : String(err)}\n`,
        )
        return { ...ZERO_RESULT, duration_ms: Date.now() - startMs }
      }
    }

    const reportPath = await findPitMutationsXml(workDir)
    if (!reportPath) {
      process.stderr.write("bollard: PIT mutations.xml not found after pitest run\n")
      return { ...ZERO_RESULT, duration_ms: Date.now() - startMs }
    }
    let xmlText: string
    try {
      xmlText = await readFile(reportPath, "utf-8")
    } catch (err: unknown) {
      process.stderr.write(
        `bollard: failed to read PIT report: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      return { ...ZERO_RESULT, duration_ms: Date.now() - startMs }
    }
    const result = parsePitReport(xmlText)
    return {
      ...result,
      duration_ms: Date.now() - startMs,
      reportPath,
    }
  }
}

const strykerSingleton = new StrykerProvider()
const mutmutSingleton = new MutmutProvider()
const cargoMutantsSingleton = new CargoMutantsProvider()
const pitestSingleton = new PitestProvider()

export function getMutationProvider(language: LanguageId): MutationTestingProvider | undefined {
  switch (language) {
    case "typescript":
    case "javascript":
      return strykerSingleton
    case "python":
      return mutmutSingleton
    case "rust":
      return cargoMutantsSingleton
    case "java":
    case "kotlin":
      return pitestSingleton
    default:
      return undefined
  }
}

export async function runMutationTesting(
  workDir: string,
  profile: ToolchainProfile,
  mutateFiles?: string[],
): Promise<MutationTestResult> {
  if (!profile.mutation?.enabled) {
    return { ...ZERO_RESULT }
  }

  const provider = getMutationProvider(profile.language)
  if (!provider) {
    process.stderr.write(`bollard: mutation testing not available for ${profile.language}\n`)
    return { ...ZERO_RESULT }
  }

  return provider.run(workDir, profile, mutateFiles)
}
