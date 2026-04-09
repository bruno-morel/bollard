import { execFile } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import type { LanguageId, ToolchainProfile } from "@bollard/detect/src/types.js"

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
  run(workDir: string, profile: ToolchainProfile): Promise<MutationTestResult>
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

export class StrykerProvider implements MutationTestingProvider {
  readonly language: LanguageId = "typescript"

  async run(workDir: string, profile: ToolchainProfile): Promise<MutationTestResult> {
    const startMs = Date.now()
    const reportPath = join(workDir, "reports", "mutation", "mutation.json")

    const config = {
      testRunner: "vitest",
      vitest: {
        configFile: deriveVitestConfigFile(profile),
      },
      mutate: deriveMutatePatterns(profile),
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

const PROVIDERS: Record<string, MutationTestingProvider> = {
  typescript: new StrykerProvider(),
  javascript: new StrykerProvider(),
}

export async function runMutationTesting(
  workDir: string,
  profile: ToolchainProfile,
): Promise<MutationTestResult> {
  if (!profile.mutation?.enabled) {
    return { ...ZERO_RESULT }
  }

  const provider = PROVIDERS[profile.language]
  if (!provider) {
    process.stderr.write(`bollard: mutation testing not available for ${profile.language}\n`)
    return { ...ZERO_RESULT }
  }

  return provider.run(workDir, profile)
}
