import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { basename, dirname, relative, resolve } from "node:path"
import { promisify } from "node:util"
import type { LanguageId, MetricsConfig, ToolchainProfile } from "@bollard/detect/src/types.js"
import { DEFAULT_METRICS_CONFIG } from "@bollard/detect/src/types.js"
import type { ProbeDefinition } from "@bollard/engine/src/blueprint.js"
import type { EndpointEntry } from "./behavioral-extractor.js"

const execFileAsync = promisify(execFile)

export interface FileCoverage {
  file: string
  lines: number
  coveredLines: number
  pct: number
}

export interface CoverageDelta {
  tool: "v8" | "go-cover" | "tarpaulin" | "pytest-cov" | "none"
  changedFiles: FileCoverage[]
  overallPct: number | null
  note?: string
}

export interface ComplexityHotspot {
  file: string
  functionName: string
  decisionPoints: number
  added: boolean
}

export interface ComplexityReport {
  hotspots: ComplexityHotspot[]
  maxDecisionPoints: number
  filesAnalysed: number
}

export interface SastFinding {
  pattern: string
  file: string
  line: number
  match: string
  severity: "high" | "medium" | "low"
  source: "rg" | "semgrep"
}

export interface SastReport {
  findings: SastFinding[]
  patternsChecked: number
  filesScanned: number
  tool: "semgrep" | "rg"
}

export interface ChurnScore {
  file: string
  commitCount: number
  churnRisk: "low" | "medium" | "high"
}

export interface CveDetail {
  package: string
  severity: string
  title: string
  url?: string
}

export interface AuditDetail {
  tool: "pnpm-audit" | "cargo-audit" | "pip-audit" | "none"
  criticalCount: number
  highCount: number
  details: CveDetail[]
}

export interface ProbePerf {
  probeId: string
  endpoint: string
  sampleCount: number
  avgMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  maxMs: number
  failRate: number
  trend: "improving" | "stable" | "degrading" | "insufficient-data"
}

export interface ProbePerfReport {
  probes: ProbePerf[]
  windowMs: number
  source: "file-metrics-store" | "k6" | "none"
}

interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

interface ProbeMetricResult {
  probeId: string
  timestamp: number
  status: "pass" | "fail"
  assertions: unknown[]
  latencyMs: number
}

type SastSeverity = SastFinding["severity"]

const SAST_PATTERNS: ReadonlyArray<{
  name: string
  pattern: string
  severity: SastSeverity
  langs: readonly LanguageId[]
}> = [
  {
    name: "eval-misuse",
    pattern: String.raw`\beval\s*\(`,
    severity: "high",
    langs: ["typescript", "javascript", "python"],
  },
  {
    name: "sql-concat",
    pattern: String.raw`(query|sql|SQL)\s*[+]=?\s*["'\`]`,
    severity: "high",
    langs: ["typescript", "javascript", "python", "java", "kotlin"],
  },
  {
    name: "shell-exec",
    pattern: String.raw`\b(execSync|child_process|os\.system|subprocess\.call)\b`,
    severity: "high",
    langs: ["typescript", "javascript", "python"],
  },
  {
    name: "path-traversal",
    pattern: String.raw`\.\./|path\.join\([^)]*req\b`,
    severity: "high",
    langs: ["typescript", "javascript"],
  },
  {
    name: "hardcoded-secret",
    pattern: String.raw`(password|secret|api_key|token)\s*=\s*["'][^"']{8,}["']`,
    severity: "high",
    langs: ["typescript", "javascript", "python", "java", "kotlin", "go", "rust"],
  },
  {
    name: "hardcoded-jwt",
    pattern: String.raw`eyJ[A-Za-z0-9_-]{20,}`,
    severity: "medium",
    langs: ["typescript", "javascript", "python", "java", "kotlin"],
  },
  {
    name: "prototype-pollution",
    pattern: String.raw`\.__proto__\s*=|\[["']__proto__["']\]`,
    severity: "high",
    langs: ["typescript", "javascript"],
  },
  {
    name: "regex-dos",
    pattern: String.raw`new RegExp\([^)]*\+`,
    severity: "medium",
    langs: ["typescript", "javascript"],
  },
  {
    name: "unsafe-deserialize",
    pattern: String.raw`\bpickle\.loads?\b|\byaml\.load\b`,
    severity: "high",
    langs: ["python"],
  },
  {
    name: "go-unchecked-err",
    pattern: String.raw`^\s*[a-zA-Z_]+,\s*_\s*:?=`,
    severity: "low",
    langs: ["go"],
  },
  {
    name: "rust-unwrap",
    pattern: String.raw`\.unwrap\(\)`,
    severity: "low",
    langs: ["rust"],
  },
  {
    name: "java-sql-concat",
    pattern: String.raw`Statement.*execute.*\+`,
    severity: "high",
    langs: ["java", "kotlin"],
  },
  {
    name: "java-xxe",
    pattern: String.raw`DocumentBuilderFactory|SAXParserFactory`,
    severity: "medium",
    langs: ["java", "kotlin"],
  },
]

const EMPTY_COVERAGE: CoverageDelta = {
  tool: "none",
  changedFiles: [],
  overallPct: null,
  note: "coverage unavailable",
}

const EMPTY_AUDIT: AuditDetail = {
  tool: "none",
  criticalCount: 0,
  highCount: 0,
  details: [],
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  moderate: 2,
  low: 1,
  info: 0,
}

async function runCommand(
  cmd: string,
  args: string[],
  workDir: string,
  timeoutMs: number,
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: workDir,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    })
    return { stdout, stderr, exitCode: 0 }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number }
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: typeof e.code === "number" ? e.code : 1,
    }
  }
}

export async function commandOnPath(cmd: string, workDir: string): Promise<boolean> {
  const result = await runCommand("which", [cmd], workDir, 5_000)
  return result.exitCode === 0
}

function relPath(workDir: string, file: string): string {
  const resolved = resolve(workDir, file)
  return relative(workDir, resolved).replaceAll("\\", "/")
}

function metricsConfig(profile: ToolchainProfile): MetricsConfig {
  return profile.metrics ?? DEFAULT_METRICS_CONFIG
}

function isChangedSource(file: string, changedFiles: string[]): boolean {
  return changedFiles.includes(file) || changedFiles.some((changed) => file.endsWith(changed))
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function parseJsonMaybe(raw: string): unknown {
  if (!raw.trim()) return undefined
  return JSON.parse(raw)
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function normaliseSeverity(value: unknown): SastSeverity {
  const raw = String(value ?? "").toLowerCase()
  if (raw === "error" || raw === "critical" || raw === "high") return "high"
  if (raw === "warning" || raw === "medium" || raw === "moderate") return "medium"
  return "low"
}

function truncate(value: string, length = 200): string {
  return value.length <= length ? value : `${value.slice(0, length)}...`
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)
  return sorted[idx] ?? 0
}

function average(nums: number[]): number {
  if (nums.length === 0) return 0
  return nums.reduce((sum, n) => sum + n, 0) / nums.length
}

function determineTrend(rows: ProbeMetricResult[]): ProbePerf["trend"] {
  if (rows.length < 10) return "insufficient-data"
  const sliceSize = Math.max(1, Math.floor(rows.length * 0.2))
  const first = rows.slice(0, sliceSize).map((r) => r.latencyMs)
  const last = rows.slice(-sliceSize).map((r) => r.latencyMs)
  const firstAvg = average(first)
  const lastAvg = average(last)
  if (firstAvg <= 0) return "insufficient-data"
  const delta = (lastAvg - firstAvg) / firstAvg
  if (delta > 0.15) return "degrading"
  if (delta < -0.15) return "improving"
  return "stable"
}

export function extractAddedLineKeys(diff: string): Set<string> {
  const keys = new Set<string>()
  let currentFile = ""
  let newLine = 0

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice("+++ b/".length)
      continue
    }
    if (line.startsWith("diff --git ")) {
      currentFile = ""
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      newLine = Number(hunk[1] ?? "0")
      continue
    }
    if (!currentFile || line.startsWith("---")) continue
    if (line.startsWith("+") && !line.startsWith("+++")) {
      keys.add(`${currentFile}:${newLine}`)
      newLine++
      continue
    }
    if (line.startsWith("-")) continue
    newLine++
  }

  return keys
}

function functionNameFromText(value: string): string | undefined {
  const trimmed = value.trim()
  const patterns = [
    /\bfunction\s+([A-Za-z_$][\w$]*)/,
    /\b(?:async\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/,
    /\bdef\s+([A-Za-z_]\w*)/,
    /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
    /\bpub\s+fn\s+([A-Za-z_]\w*)/,
    /\bfn\s+([A-Za-z_]\w*)/,
    /\bclass\s+([A-Za-z_$][\w$]*)/,
    /\b(?:public|private|protected)?\s*(?:static\s+)?[\w<>,\s[\]]+\s+([A-Za-z_]\w*)\s*\(/,
    /\bfun\s+([A-Za-z_]\w*)/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(trimmed)
    if (match?.[1]) return match[1]
  }
  return undefined
}

function decisionPoints(line: string): number {
  const keywordMatches = line.match(/\b(else\s+if|if|for|while|switch|case|catch)\b/g) ?? []
  const andOrMatches = line.match(/&&|\|\|/g) ?? []
  const ternaryMatches = line.match(/\?(?!\?)/g) ?? []
  return keywordMatches.length + andOrMatches.length + ternaryMatches.length
}

export function extractComplexityFromDiff(
  diff: string,
  hotspotThreshold = DEFAULT_METRICS_CONFIG.complexity.hotspotThreshold,
): ComplexityReport {
  const byFunction = new Map<string, ComplexityHotspot>()
  const files = new Set<string>()
  let currentFile = ""
  let currentFunction = "(module)"

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice("+++ b/".length)
      currentFunction = "(module)"
      files.add(currentFile)
      continue
    }

    const hunk = /^@@.*@@\s*(.*)$/.exec(line)
    if (hunk) {
      const fn = functionNameFromText(hunk[1] ?? "")
      if (fn) currentFunction = fn
      continue
    }

    if (!currentFile || line.startsWith("---")) continue
    const content = line.startsWith("+") || line.startsWith("-") ? line.slice(1) : line.slice(1)
    const fn = functionNameFromText(content)
    if (fn) currentFunction = fn
    if (!line.startsWith("+") || line.startsWith("+++")) continue

    const count = decisionPoints(content)
    if (count === 0) continue

    const key = `${currentFile}:${currentFunction}`
    const existing = byFunction.get(key)
    byFunction.set(key, {
      file: currentFile,
      functionName: currentFunction,
      decisionPoints: (existing?.decisionPoints ?? 0) + count,
      added: true,
    })
  }

  const hotspots = [...byFunction.values()]
    .filter((h) => h.decisionPoints >= hotspotThreshold)
    .sort((a, b) => b.decisionPoints - a.decisionPoints)

  return {
    hotspots,
    maxDecisionPoints: hotspots[0]?.decisionPoints ?? 0,
    filesAnalysed: files.size,
  }
}

async function findImportingTests(
  workDir: string,
  changedFiles: string[],
  profile: ToolchainProfile,
): Promise<string[]> {
  if (changedFiles.length === 0) return []
  const tests = new Set<string>()
  for (const file of changedFiles) {
    const stem = basename(file).replace(/\.[^.]+$/, "")
    const result = await runCommand(
      "rg",
      ["--files-with-matches", stem, ...profile.testPatterns],
      workDir,
      10_000,
    )
    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trim()
      if (trimmed.length > 0) tests.add(trimmed)
    }
  }
  return [...tests]
}

async function parseV8Coverage(workDir: string, changedFiles: string[]): Promise<CoverageDelta> {
  const coveragePath = resolve(workDir, "coverage", "coverage-summary.json")
  if (!existsSync(coveragePath)) return EMPTY_COVERAGE
  const content = await readFile(coveragePath, "utf-8")
  const parsed = objectRecord(JSON.parse(content))
  if (!parsed) return EMPTY_COVERAGE
  const total = objectRecord(parsed["total"])
  const totalLines = objectRecord(total?.["lines"])
  const changed: FileCoverage[] = []
  for (const [path, value] of Object.entries(parsed)) {
    if (path === "total") continue
    const rel = relPath(workDir, path)
    if (!isChangedSource(rel, changedFiles)) continue
    const entry = objectRecord(value)
    const lines = objectRecord(entry?.["lines"])
    const totalCount = numberValue(lines?.["total"]) ?? 0
    const covered = numberValue(lines?.["covered"]) ?? 0
    const pct = numberValue(lines?.["pct"]) ?? (totalCount === 0 ? 0 : (covered / totalCount) * 100)
    changed.push({ file: rel, lines: totalCount, coveredLines: covered, pct: round(pct) })
  }
  return {
    tool: "v8",
    changedFiles: changed,
    overallPct: numberValue(totalLines?.["pct"]) ?? null,
  }
}

export async function extractCoverageDelta(
  workDir: string,
  changedFiles: string[],
  profile: ToolchainProfile,
): Promise<CoverageDelta> {
  if (!metricsConfig(profile).coverage.enabled) return EMPTY_COVERAGE
  try {
    switch (profile.language) {
      case "typescript":
      case "javascript": {
        if (!existsSync(resolve(workDir, "node_modules", "@vitest", "coverage-v8"))) {
          return { ...EMPTY_COVERAGE, note: "@vitest/coverage-v8 unavailable" }
        }
        const tests = await findImportingTests(workDir, changedFiles, profile)
        if (tests.length === 0) {
          return { ...EMPTY_COVERAGE, note: "no importing tests found for changed files" }
        }
        await runCommand(
          "pnpm",
          [
            "exec",
            "vitest",
            "run",
            "--coverage",
            "--reporter=json",
            "--coverage.reporter=json",
            ...tests,
          ],
          workDir,
          60_000,
        )
        return await parseV8Coverage(workDir, changedFiles)
      }
      case "go": {
        const out = resolve(workDir, ".bollard", "cover.out")
        await mkdir(dirname(out), { recursive: true })
        const test = await runCommand(
          "go",
          ["test", "-coverprofile=.bollard/cover.out", "./..."],
          workDir,
          60_000,
        )
        if (test.exitCode !== 0)
          return { ...EMPTY_COVERAGE, tool: "none", note: "go test coverage failed" }
        const cover = await runCommand("go", ["tool", "cover", `-func=${out}`], workDir, 60_000)
        return parseGoCoverage(cover.stdout, changedFiles)
      }
      case "rust": {
        if (!(await commandOnPath("cargo-tarpaulin", workDir))) {
          return { ...EMPTY_COVERAGE, note: "cargo-tarpaulin unavailable" }
        }
        await runCommand(
          "cargo",
          ["tarpaulin", "--out", "Json", "--output-dir", ".bollard"],
          workDir,
          90_000,
        )
        return await parseTarpaulinCoverage(workDir, changedFiles)
      }
      case "python": {
        const hasCov = await runCommand("python3", ["-c", "import pytest_cov"], workDir, 5_000)
        if (hasCov.exitCode !== 0) return { ...EMPTY_COVERAGE, note: "pytest-cov unavailable" }
        await runCommand(
          "python3",
          ["-m", "pytest", "--cov", "--cov-report=json:.bollard/coverage.json"],
          workDir,
          60_000,
        )
        return await parsePythonCoverage(workDir, changedFiles)
      }
      default:
        return EMPTY_COVERAGE
    }
  } catch {
    return EMPTY_COVERAGE
  }
}

function parseGoCoverage(stdout: string, changedFiles: string[]): CoverageDelta {
  const changed: FileCoverage[] = []
  let overallPct: number | null = null
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith("total:")) {
      const pct = /(\d+(?:\.\d+)?)%$/.exec(trimmed)
      overallPct = pct?.[1] ? Number(pct[1]) : null
      continue
    }
    const parts = trimmed.split(/\s+/)
    const filePart = parts[0]?.split(":")[0]
    const pctPart = parts.at(-1)
    if (!filePart || !pctPart) continue
    const rel = filePart.replace(/^.*?\//, "")
    if (!isChangedSource(rel, changedFiles)) continue
    const pct = Number(pctPart.replace("%", ""))
    changed.push({ file: rel, lines: 0, coveredLines: 0, pct: Number.isFinite(pct) ? pct : 0 })
  }
  return { tool: "go-cover", changedFiles: changed, overallPct }
}

async function parseTarpaulinCoverage(
  workDir: string,
  changedFiles: string[],
): Promise<CoverageDelta> {
  const raw = await readFile(resolve(workDir, ".bollard", "tarpaulin-report.json"), "utf-8")
  const parsed = objectRecord(JSON.parse(raw))
  const files = objectRecord(parsed?.["files"])
  const changed: FileCoverage[] = []
  if (files) {
    for (const [file, value] of Object.entries(files)) {
      const rel = relPath(workDir, file)
      if (!isChangedSource(rel, changedFiles)) continue
      const entry = objectRecord(value)
      const covered = numberValue(entry?.["covered"]) ?? 0
      const coverable = numberValue(entry?.["coverable"]) ?? numberValue(entry?.["lines"]) ?? 0
      const pct = coverable === 0 ? 0 : (covered / coverable) * 100
      changed.push({ file: rel, lines: coverable, coveredLines: covered, pct: round(pct) })
    }
  }
  return {
    tool: "tarpaulin",
    changedFiles: changed,
    overallPct: numberValue(parsed?.["coverage"]) ?? null,
  }
}

async function parsePythonCoverage(
  workDir: string,
  changedFiles: string[],
): Promise<CoverageDelta> {
  const raw = await readFile(resolve(workDir, ".bollard", "coverage.json"), "utf-8")
  const parsed = objectRecord(JSON.parse(raw))
  const totals = objectRecord(parsed?.["totals"])
  const files = objectRecord(parsed?.["files"])
  const changed: FileCoverage[] = []
  if (files) {
    for (const [file, value] of Object.entries(files)) {
      const rel = relPath(workDir, file)
      if (!isChangedSource(rel, changedFiles)) continue
      const summary = objectRecord(objectRecord(value)?.["summary"])
      const lines = numberValue(summary?.["num_statements"]) ?? 0
      const covered = numberValue(summary?.["covered_lines"]) ?? 0
      const pct =
        numberValue(summary?.["percent_covered"]) ?? (lines === 0 ? 0 : (covered / lines) * 100)
      changed.push({ file: rel, lines, coveredLines: covered, pct: round(pct) })
    }
  }
  return {
    tool: "pytest-cov",
    changedFiles: changed,
    overallPct: numberValue(totals?.["percent_covered"]) ?? null,
  }
}

export async function buildSastFindings(
  workDir: string,
  diff: string,
  changedFiles: string[],
  profile: ToolchainProfile,
): Promise<SastReport> {
  if (!metricsConfig(profile).sast.enabled) {
    return { findings: [], patternsChecked: 0, filesScanned: changedFiles.length, tool: "rg" }
  }

  const addedLineKeys = extractAddedLineKeys(diff)
  const files = changedFiles.filter((file) => existsSync(resolve(workDir, file)))

  if (files.length > 0 && (await commandOnPath("semgrep", workDir))) {
    const report = await runSemgrep(workDir, files, addedLineKeys)
    if (report) return report
  }

  const activePatterns = SAST_PATTERNS.filter((p) => p.langs.includes(profile.language))
  const findings: SastFinding[] = []
  const seen = new Set<string>()

  for (const pattern of activePatterns) {
    for (const file of files) {
      const result = await runCommand(
        "rg",
        ["--json", "-n", "-e", pattern.pattern, "--", file],
        workDir,
        15_000,
      )
      for (const line of result.stdout.split("\n")) {
        if (!line.trim()) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        const obj = objectRecord(parsed)
        if (obj?.["type"] !== "match") continue
        const data = objectRecord(obj["data"])
        const path = stringValue(objectRecord(data?.["path"])?.["text"]) ?? file
        const lineNumber = numberValue(data?.["line_number"]) ?? 0
        const key = `${path}:${lineNumber}`
        if (addedLineKeys.size > 0 && !addedLineKeys.has(key)) continue
        if (seen.has(key)) continue
        seen.add(key)
        const match = stringValue(objectRecord(data?.["lines"])?.["text"]) ?? ""
        findings.push({
          pattern: pattern.name,
          file: path,
          line: lineNumber,
          match: truncate(match.trim()),
          severity: pattern.severity,
          source: "rg",
        })
      }
    }
  }

  return {
    findings,
    patternsChecked: activePatterns.length,
    filesScanned: files.length,
    tool: "rg",
  }
}

export function buildSastFindingsFromContent(
  file: string,
  content: string,
  language: LanguageId,
  addedLines?: Set<number>,
): SastFinding[] {
  const activePatterns = SAST_PATTERNS.filter((p) => p.langs.includes(language))
  const findings: SastFinding[] = []
  const seen = new Set<string>()
  const lines = content.split("\n")

  lines.forEach((line, index) => {
    const lineNumber = index + 1
    if (addedLines !== undefined && !addedLines.has(lineNumber)) return
    for (const pattern of activePatterns) {
      if (!new RegExp(pattern.pattern).test(line)) continue
      const key = `${file}:${lineNumber}`
      if (seen.has(key)) return
      seen.add(key)
      findings.push({
        pattern: pattern.name,
        file,
        line: lineNumber,
        match: truncate(line.trim()),
        severity: pattern.severity,
        source: "rg",
      })
    }
  })

  return findings
}

async function runSemgrep(
  workDir: string,
  files: string[],
  addedLineKeys: Set<string>,
): Promise<SastReport | undefined> {
  const result = await runCommand(
    "semgrep",
    ["--config", "p/owasp-top-ten", "--config", "p/secrets", "--json", ...files],
    workDir,
    30_000,
  )
  if (!result.stdout.trim()) return undefined
  try {
    const parsed = objectRecord(JSON.parse(result.stdout))
    const results = Array.isArray(parsed?.["results"]) ? (parsed["results"] as unknown[]) : []
    const findings: SastFinding[] = []
    const seen = new Set<string>()
    for (const item of results) {
      const obj = objectRecord(item)
      if (!obj) continue
      const path = stringValue(obj["path"]) ?? ""
      const start = objectRecord(obj["start"])
      const line = numberValue(start?.["line"]) ?? 0
      const key = `${path}:${line}`
      if (addedLineKeys.size > 0 && !addedLineKeys.has(key)) continue
      if (seen.has(key)) continue
      seen.add(key)
      const extra = objectRecord(obj["extra"])
      findings.push({
        pattern: stringValue(obj["check_id"]) ?? "semgrep",
        file: path,
        line,
        match: truncate(stringValue(extra?.["lines"]) ?? stringValue(extra?.["message"]) ?? ""),
        severity: normaliseSeverity(extra?.["severity"]),
        source: "semgrep",
      })
    }
    return {
      findings,
      patternsChecked: 2,
      filesScanned: files.length,
      tool: "semgrep",
    }
  } catch {
    return undefined
  }
}

export async function computeChurnScores(
  workDir: string,
  changedFiles: string[],
  highThreshold = DEFAULT_METRICS_CONFIG.churn.highThreshold,
): Promise<ChurnScore[]> {
  const out: ChurnScore[] = []
  for (const file of changedFiles) {
    const result = await runCommand(
      "git",
      ["log", "--follow", "--oneline", "--", file],
      workDir,
      15_000,
    )
    out.push(computeChurnScore(file, result.stdout, highThreshold))
  }
  return out
}

export function computeChurnScore(
  file: string,
  gitLogOutput: string,
  highThreshold = DEFAULT_METRICS_CONFIG.churn.highThreshold,
): ChurnScore {
  const commitCount = gitLogOutput.split("\n").filter((line) => line.trim().length > 0).length
  const churnRisk = commitCount < 10 ? "low" : commitCount < highThreshold ? "medium" : "high"
  return { file, commitCount, churnRisk }
}

export async function extractCveDetail(
  workDir: string,
  profile: ToolchainProfile,
): Promise<AuditDetail> {
  try {
    if (
      profile.packageManager === "pnpm" ||
      profile.packageManager === "npm" ||
      profile.packageManager === "yarn"
    ) {
      const result = await runCommand("pnpm", ["audit", "--json"], workDir, 30_000)
      return parsePnpmAuditJson(result.stdout)
    }
    if (profile.language === "rust" && (await commandOnPath("cargo", workDir))) {
      const result = await runCommand("cargo", ["audit", "--json"], workDir, 30_000)
      return parseCargoAuditJson(result.stdout)
    }
    if (profile.language === "python" && (await commandOnPath("pip-audit", workDir))) {
      const result = await runCommand("pip-audit", ["--format=json"], workDir, 30_000)
      return parsePipAuditJson(result.stdout)
    }
    return EMPTY_AUDIT
  } catch {
    return EMPTY_AUDIT
  }
}

export function parsePnpmAuditJson(raw: string): AuditDetail {
  const parsed = objectRecord(parseJsonMaybe(raw))
  if (!parsed) return EMPTY_AUDIT
  const details: CveDetail[] = []
  const advisories = objectRecord(parsed["advisories"])
  if (advisories) {
    for (const advisory of Object.values(advisories)) {
      const obj = objectRecord(advisory)
      if (!obj) continue
      const detail: CveDetail = {
        package: stringValue(obj["module_name"]) ?? stringValue(obj["package"]) ?? "unknown",
        severity: stringValue(obj["severity"]) ?? "unknown",
        title: stringValue(obj["title"]) ?? stringValue(obj["overview"]) ?? "unknown vulnerability",
      }
      const url = stringValue(obj["url"]) ?? stringValue(obj["references"])
      if (url !== undefined) detail.url = url
      details.push(detail)
    }
  }
  const vulnerabilities = objectRecord(parsed["vulnerabilities"])
  if (vulnerabilities) {
    for (const [pkg, vuln] of Object.entries(vulnerabilities)) {
      const obj = objectRecord(vuln)
      if (!obj) continue
      details.push({
        package: pkg,
        severity: stringValue(obj["severity"]) ?? "unknown",
        title: stringValue(obj["title"]) ?? stringValue(obj["via"]) ?? "unknown vulnerability",
      })
    }
  }
  return buildAuditDetail("pnpm-audit", details)
}

export function parseCargoAuditJson(raw: string): AuditDetail {
  const parsed = objectRecord(parseJsonMaybe(raw))
  const vulnerabilities = objectRecord(parsed?.["vulnerabilities"])
  const list = Array.isArray(vulnerabilities?.["list"])
    ? (vulnerabilities["list"] as unknown[])
    : []
  const details: CveDetail[] = []
  for (const item of list) {
    const obj = objectRecord(item)
    const advisory = objectRecord(obj?.["advisory"])
    const packageInfo = objectRecord(obj?.["package"])
    if (!advisory) continue
    const detail: CveDetail = {
      package: stringValue(packageInfo?.["name"]) ?? "unknown",
      severity: stringValue(advisory["severity"]) ?? "unknown",
      title: stringValue(advisory["title"]) ?? "unknown vulnerability",
    }
    const url = stringValue(advisory["url"])
    if (url !== undefined) detail.url = url
    details.push(detail)
  }
  return buildAuditDetail("cargo-audit", details)
}

export function parsePipAuditJson(raw: string): AuditDetail {
  const parsed = objectRecord(parseJsonMaybe(raw))
  const dependencies = Array.isArray(parsed?.["dependencies"])
    ? (parsed["dependencies"] as unknown[])
    : []
  const details: CveDetail[] = []
  for (const dep of dependencies) {
    const depObj = objectRecord(dep)
    const vulns = Array.isArray(depObj?.["vulns"]) ? (depObj["vulns"] as unknown[]) : []
    for (const vuln of vulns) {
      const obj = objectRecord(vuln)
      if (!obj) continue
      const detail: CveDetail = {
        package: stringValue(depObj?.["name"]) ?? "unknown",
        severity: stringValue(obj["severity"]) ?? "unknown",
        title: stringValue(obj["description"]) ?? stringValue(obj["id"]) ?? "unknown vulnerability",
      }
      const url = stringValue(obj["fix_versions"])
      if (url !== undefined) detail.url = url
      details.push(detail)
    }
  }
  return buildAuditDetail("pip-audit", details)
}

function buildAuditDetail(tool: AuditDetail["tool"], details: CveDetail[]): AuditDetail {
  const sorted = [...details].sort(
    (a, b) =>
      (SEVERITY_RANK[b.severity.toLowerCase()] ?? 0) -
      (SEVERITY_RANK[a.severity.toLowerCase()] ?? 0),
  )
  return {
    tool,
    criticalCount: details.filter((d) => d.severity.toLowerCase() === "critical").length,
    highCount: details.filter((d) => d.severity.toLowerCase() === "high").length,
    details: sorted.slice(0, 5),
  }
}

export async function aggregateProbePerf(
  workDir: string,
  windowResults = DEFAULT_METRICS_CONFIG.probePerf.windowResults,
): Promise<ProbePerfReport> {
  const k6 = await readK6Perf(workDir)
  if (k6) return k6

  const metricsDir = resolve(workDir, ".bollard", "observe", "metrics")
  let files: string[]
  try {
    files = (await readdir(metricsDir)).filter((name) => name.endsWith(".jsonl")).sort()
  } catch {
    return { probes: [], windowMs: 24 * 60 * 60 * 1000, source: "none" }
  }

  const since = Date.now() - 24 * 60 * 60 * 1000
  const byProbe = new Map<string, ProbeMetricResult[]>()
  for (const file of files) {
    const raw = await readFile(resolve(metricsDir, file), "utf-8")
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line) as ProbeMetricResult
        if (row.timestamp < since) continue
        const bucket = byProbe.get(row.probeId) ?? []
        bucket.push(row)
        byProbe.set(row.probeId, bucket)
      } catch {
        /* ignore malformed metric line */
      }
    }
  }

  const endpointMap = await readProbeEndpointMap(workDir)
  const probes = [...byProbe.entries()].map(([probeId, rows]) =>
    summarizeProbeRows(probeId, endpointMap.get(probeId) ?? probeId, rows.slice(-windowResults)),
  )

  return {
    probes,
    windowMs: 24 * 60 * 60 * 1000,
    source: probes.length > 0 ? "file-metrics-store" : "none",
  }
}

async function readProbeEndpointMap(workDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const probesDir = resolve(workDir, ".bollard", "probes")
  let names: string[]
  try {
    names = (await readdir(probesDir)).filter((name) => name.endsWith(".json"))
  } catch {
    return out
  }
  for (const name of names) {
    try {
      const raw = await readFile(resolve(probesDir, name), "utf-8")
      const probe = JSON.parse(raw) as ProbeDefinition
      out.set(probe.id, probe.endpoint)
    } catch {
      /* ignore malformed probe definition */
    }
  }
  return out
}

function summarizeProbeRows(
  probeId: string,
  endpoint: string,
  rows: ProbeMetricResult[],
): ProbePerf {
  const sortedRows = [...rows].sort((a, b) => a.timestamp - b.timestamp)
  const latencies = sortedRows.map((r) => r.latencyMs).sort((a, b) => a - b)
  const failures = sortedRows.filter((r) => r.status === "fail").length
  return {
    probeId,
    endpoint,
    sampleCount: sortedRows.length,
    avgMs: round(average(latencies)),
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    maxMs: latencies.at(-1) ?? 0,
    failRate: sortedRows.length === 0 ? 0 : round(failures / sortedRows.length, 4),
    trend: determineTrend(sortedRows),
  }
}

async function readK6Perf(workDir: string): Promise<ProbePerfReport | undefined> {
  const path = resolve(workDir, ".bollard", "observe", "k6-latest.json")
  if (!existsSync(path)) return undefined
  try {
    const raw = await readFile(path, "utf-8")
    const report = parseK6Json(raw)
    return report.probes.length > 0 ? report : undefined
  } catch {
    return undefined
  }
}

export function parseK6Json(raw: string): ProbePerfReport {
  const lines = raw.split("\n").filter((line) => line.trim().length > 0)
  const probesByEndpoint = new Map<string, ProbeMetricResult[]>()

  for (const line of lines) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const obj = objectRecord(parsed)
    const metric = stringValue(obj?.["metric"])
    if (metric !== "http_req_duration") continue
    const data = objectRecord(obj?.["data"])
    const tags = objectRecord(data?.["tags"])
    const endpoint = stringValue(tags?.["url"]) ?? "k6"
    const value = numberValue(data?.["value"]) ?? 0
    const row: ProbeMetricResult = {
      probeId: endpoint,
      timestamp: numberValue(data?.["time"]) ?? Date.now(),
      status: "pass",
      assertions: [],
      latencyMs: value,
    }
    const rows = probesByEndpoint.get(endpoint) ?? []
    rows.push(row)
    probesByEndpoint.set(endpoint, rows)
  }

  const probes = [...probesByEndpoint.entries()].map(([endpoint, rows]) =>
    summarizeProbeRows(endpoint, endpoint, rows),
  )

  return {
    probes,
    windowMs: 0,
    source: probes.length > 0 ? "k6" : "none",
  }
}

export function generateK6Script(
  endpoints: EndpointEntry[],
  opts: { vus: number; durationSec: number },
): string {
  const uniqueEndpoints = endpoints.filter(
    (endpoint, index, arr) =>
      arr.findIndex((e) => e.method === endpoint.method && e.path === endpoint.path) === index,
  )
  const lines = [
    "import http from 'k6/http'",
    "import { check, sleep } from 'k6'",
    "",
    `export const options = { vus: ${opts.vus}, duration: '${opts.durationSec}s' }`,
    "const BASE = __ENV.BASE_URL || 'http://localhost:3000'",
    "",
    "export default function () {",
  ]
  uniqueEndpoints.forEach((endpoint, index) => {
    const method = endpoint.method.toUpperCase()
    const path = endpoint.path.startsWith("/") ? endpoint.path : `/${endpoint.path}`
    const varName = `r${index + 1}`
    const call =
      method === "POST"
        ? `http.post(\`\${BASE}${path}\`, JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } })`
        : `http.get(\`\${BASE}${path}\`)`
    lines.push(`  const ${varName} = ${call}`)
    lines.push(
      `  check(${varName}, { 'status 2xx ${method} ${path}': (r) => r.status >= 200 && r.status < 300 })`,
    )
    lines.push("  sleep(0.1)")
  })
  lines.push("}", "")
  return lines.join("\n")
}

export async function runK6LoadTest(
  workDir: string,
  endpoints: EndpointEntry[],
  opts: { vus: number; durationSec: number; baseUrl?: string },
): Promise<ProbePerfReport> {
  const scriptPath = resolve(workDir, ".bollard", "k6-behavioral.js")
  const outPath = resolve(workDir, ".bollard", "observe", "k6-latest.json")
  await mkdir(dirname(scriptPath), { recursive: true })
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(scriptPath, generateK6Script(endpoints, opts), "utf-8")

  await runCommand(
    "k6",
    [
      "run",
      "--out",
      `json=${outPath}`,
      "--env",
      `BASE_URL=${opts.baseUrl ?? "http://localhost:3000"}`,
      "--quiet",
      scriptPath,
    ],
    workDir,
    (opts.durationSec * 2 + 30) * 1000,
  )

  return (await readK6Perf(workDir)) ?? { probes: [], windowMs: 0, source: "none" }
}

export async function extractCodeMetricParts(
  workDir: string,
  diff: string,
  changedFiles: string[],
  profile: ToolchainProfile,
): Promise<{
  coverage: CoverageDelta
  complexity: ComplexityReport
  sast: SastReport
  churn: ChurnScore[]
  audit: AuditDetail
  probePerf: ProbePerfReport
}> {
  const cfg = metricsConfig(profile)
  const complexity = cfg.complexity.enabled
    ? extractComplexityFromDiff(diff, cfg.complexity.hotspotThreshold)
    : { hotspots: [], maxDecisionPoints: 0, filesAnalysed: 0 }
  const [coverage, sast, churn, audit, probePerf] = await Promise.all([
    extractCoverageDelta(workDir, changedFiles, profile),
    buildSastFindings(workDir, diff, changedFiles, profile),
    cfg.churn.enabled ? computeChurnScores(workDir, changedFiles, cfg.churn.highThreshold) : [],
    extractCveDetail(workDir, profile),
    cfg.probePerf.enabled
      ? aggregateProbePerf(workDir, cfg.probePerf.windowResults)
      : { probes: [], windowMs: 0, source: "none" as const },
  ])
  return { coverage, complexity, sast, churn, audit, probePerf }
}
