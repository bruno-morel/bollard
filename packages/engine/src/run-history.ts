import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { LanguageId, PackageManagerId } from "@bollard/detect/src/types.js"
import * as lockfile from "proper-lockfile"
import type { NodeType } from "./blueprint.js"
import type { BollardErrorCode } from "./errors.js"
import type { SqliteIndex } from "./run-history-db.js"

export const RUN_HISTORY_SCHEMA_VERSION = 1 as const

export interface NodeSummary {
  id: string
  name: string
  type: NodeType
  status: "ok" | "fail" | "block"
  costUsd?: number
  durationMs?: number
  turns?: number
  model?: string
  error?: { code: string; message: string }
}

export interface ScopeResult {
  scope: "boundary" | "contract" | "behavioral"
  enabled: boolean
  claimsProposed?: number
  claimsGrounded?: number
  claimsDropped?: number
  testFile?: string
  testsPassed?: number
  testsFailed?: number
  testFingerprints?: string[]
}

export interface RunRecord {
  type: "run"
  schemaVersion: typeof RUN_HISTORY_SCHEMA_VERSION
  runId: string
  blueprintId: string
  task: string
  timestamp: number
  status: "success" | "failure" | "handed_to_human"
  error?: { code: BollardErrorCode; message: string }
  totalCostUsd: number
  totalDurationMs: number
  nodes: NodeSummary[]
  testCount: { passed: number; skipped: number; failed: number }
  mutationScore?: number
  toolchainProfile?: { language: LanguageId; packageManager?: PackageManagerId }
  gitBranch?: string
  gitSha?: string
  scopes: ScopeResult[]
  probeCount?: number
}

export type VerifyRecordSource = "cli" | "mcp" | "watch" | "hook"

export interface VerifyRecord {
  type: "verify"
  schemaVersion: typeof RUN_HISTORY_SCHEMA_VERSION
  runId: string
  timestamp: number
  workDir: string
  source: VerifyRecordSource
  checks: Array<{ name: string; passed: boolean; durationMs: number }>
  allPassed: boolean
  totalDurationMs: number
  language?: LanguageId
  gitSha?: string
}

export type HistoryRecord = RunRecord | VerifyRecord

/** Per-scope calibration: how often scope test failures correlated with overall run failures. */
export interface ScopeCalibrationEntry {
  scope: "boundary" | "contract" | "behavioral"
  /** Number of runs where this scope was enabled and had ≥ 1 test failure */
  runsWithFailures: number
  /** Of those, how many also had overall run status: "failure" */
  runsAlsoFailed: number
  /** runsAlsoFailed / runsWithFailures — undefined when runsWithFailures === 0 */
  correlationRate?: number
  /** Number of runs where scope was enabled */
  totalEnabledRuns: number
  /** Average grounding rate across enabled runs: claimsGrounded / claimsProposed */
  avgGroundingRate?: number
}

export interface RiskAuditReport {
  /** Minimum runs needed before producing calibration data */
  minRunsRequired: number
  /** Actual run count used */
  runCount: number
  /** Insufficient data when runCount < minRunsRequired */
  hasData: boolean
  scopes: ScopeCalibrationEntry[]
}

/** Per-concern yield: how often each concern lens produces grounded claims */
export interface ConcernYieldEntry {
  concern: "correctness" | "security" | "performance" | "resilience"
  /** Number of runs where this concern was weighed (not "off") */
  activeRuns: number
  /** Average grounding rate on runs where concern was active */
  avgGroundingRate?: number
  /** Suggested weight adjustment: "increase" | "decrease" | "keep" */
  suggestion: "increase" | "decrease" | "keep"
}

export interface ConcernYieldReport {
  hasData: boolean
  runCount: number
  concerns: ConcernYieldEntry[]
}

export interface HistoryFilter {
  since?: number
  until?: number
  /** Matches RunRecord.status, or verify success/failure via allPassed */
  status?: RunRecord["status"]
  blueprintId?: string
  limit?: number
  offset?: number
}

/** Optional time window for aggregate `summary()` (pipeline runs only). */
export interface SummaryFilter {
  since?: number
  until?: number
}

export interface RunComparison {
  runA: RunRecord
  runB: RunRecord
  delta: {
    costUsd: number
    durationMs: number
    testCountDelta: number
    mutationScoreDelta?: number
    newFailingNodes: string[]
    newPassingNodes: string[]
    scopeChanges: Array<{
      scope: string
      field: string
      from: number
      to: number
    }>
  }
}

export interface RunSummary {
  totalRuns: number
  successRate: number
  avgCostUsd: number
  avgDurationMs: number
  avgTestCount: number
  avgMutationScore?: number
  costTrend: "increasing" | "stable" | "decreasing"
  byBlueprint: Record<
    string,
    {
      runs: number
      successRate: number
      avgCostUsd: number
    }
  >
}

export interface RunHistoryStore {
  record(record: HistoryRecord): Promise<void>
  query(filter?: HistoryFilter): Promise<HistoryRecord[]>
  findByRunId(runId: string): Promise<HistoryRecord | undefined>
  compare(runIdA: string, runIdB: string): Promise<RunComparison>
  summary(filter?: SummaryFilter): Promise<RunSummary>
  rebuild(): Promise<{ runCount: number; durationMs: number }>
}

function totalTestCount(t: RunRecord["testCount"]): number {
  return t.passed + t.skipped + t.failed
}

function nodeStatusMap(nodes: NodeSummary[]): Map<string, "ok" | "fail" | "block"> {
  return new Map(nodes.map((n) => [n.id, n.status]))
}

function scopeNumericFields(s: ScopeResult): Record<string, number> {
  const out: Record<string, number> = {}
  if (s.claimsProposed !== undefined) out["claimsProposed"] = s.claimsProposed
  if (s.claimsGrounded !== undefined) out["claimsGrounded"] = s.claimsGrounded
  if (s.claimsDropped !== undefined) out["claimsDropped"] = s.claimsDropped
  if (s.testsPassed !== undefined) out["testsPassed"] = s.testsPassed
  if (s.testsFailed !== undefined) out["testsFailed"] = s.testsFailed
  return out
}

export function parseHistoryLine(line: string): HistoryRecord | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed) as unknown
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const o = parsed as Record<string, unknown>
  const schemaVersion = o["schemaVersion"]
  if (schemaVersion !== RUN_HISTORY_SCHEMA_VERSION) return null
  const typ = o["type"]
  if (typ === "run" || typ === "verify") {
    return parsed as HistoryRecord
  }
  return null
}

function matchesFilter(r: HistoryRecord, f?: HistoryFilter): boolean {
  if (!f) return true
  if (f.since !== undefined) {
    if (r.timestamp < f.since) return false
  }
  if (f.until !== undefined) {
    if (r.timestamp > f.until) return false
  }
  if (f.status !== undefined) {
    if (r.type === "run") {
      if (r.status !== f.status) return false
    } else {
      if (f.status === "handed_to_human") return false
      const ok = r.allPassed
      if (f.status === "success" && !ok) return false
      if (f.status === "failure" && ok) return false
    }
  }
  if (f.blueprintId !== undefined) {
    if (r.type !== "run" || r.blueprintId !== f.blueprintId) return false
  }
  return true
}

export function computeCostTrend(costs: number[]): "increasing" | "stable" | "decreasing" {
  if (costs.length < 2) return "stable"
  const mid = Math.floor(costs.length / 2)
  const firstHalf = costs.slice(0, mid)
  const secondHalf = costs.slice(mid)
  const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length
  const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length
  const threshold = 0.1
  const change = (avgSecond - avgFirst) / (avgFirst || 1)
  if (change > threshold) return "increasing"
  if (change < -threshold) return "decreasing"
  return "stable"
}

const ADVERSARIAL_SCOPES = ["boundary", "contract", "behavioral"] as const

type AdversarialScope = (typeof ADVERSARIAL_SCOPES)[number]

function findScopeResult(run: RunRecord, scope: AdversarialScope): ScopeResult | undefined {
  return run.scopes.find((s) => s.scope === scope)
}

function scopeGroundingRate(scopeResult: ScopeResult): number | undefined {
  const proposed = scopeResult.claimsProposed
  const grounded = scopeResult.claimsGrounded
  if (proposed === undefined || grounded === undefined || proposed <= 0) return undefined
  return grounded / proposed
}

function hasValidClaimData(scopeResult: ScopeResult): boolean {
  return scopeGroundingRate(scopeResult) !== undefined
}

function yieldSuggestion(rate: number): ConcernYieldEntry["suggestion"] {
  if (rate < 0.3) return "decrease"
  if (rate > 0.7) return "increase"
  return "keep"
}

const SCOPE_TO_CONCERN: Record<AdversarialScope, ConcernYieldEntry["concern"]> = {
  boundary: "correctness",
  contract: "security",
  behavioral: "resilience",
}

export function computeScopeCalibration(runs: RunRecord[], minRuns = 5): RiskAuditReport {
  const scopes: ScopeCalibrationEntry[] = ADVERSARIAL_SCOPES.map((scope) => {
    const enabledRuns = runs.filter((run) => {
      const sr = findScopeResult(run, scope)
      return sr?.enabled === true
    })
    const runsWithFailures = enabledRuns.filter((run) => {
      const sr = findScopeResult(run, scope)
      return (sr?.testsFailed ?? 0) > 0
    })
    const runsAlsoFailed = runsWithFailures.filter((run) => run.status === "failure")
    const groundingRates = enabledRuns
      .map((run) => findScopeResult(run, scope))
      .filter((sr): sr is ScopeResult => sr !== undefined)
      .map((sr) => scopeGroundingRate(sr))
      .filter((r): r is number => r !== undefined)
    const avgGroundingRate =
      groundingRates.length > 0
        ? groundingRates.reduce((a, b) => a + b, 0) / groundingRates.length
        : undefined

    const entry: ScopeCalibrationEntry = {
      scope,
      runsWithFailures: runsWithFailures.length,
      runsAlsoFailed: runsAlsoFailed.length,
      totalEnabledRuns: enabledRuns.length,
    }
    if (runsWithFailures.length > 0) {
      entry.correlationRate = runsAlsoFailed.length / runsWithFailures.length
    }
    if (avgGroundingRate !== undefined) {
      entry.avgGroundingRate = avgGroundingRate
    }
    return entry
  })

  return {
    minRunsRequired: minRuns,
    runCount: runs.length,
    hasData: runs.length >= minRuns,
    scopes,
  }
}

export function computeConcernYield(runs: RunRecord[], minRuns = 5): ConcernYieldReport {
  const runsWithClaimData = runs.filter((run) =>
    run.scopes.some((sr) => sr.enabled === true && hasValidClaimData(sr)),
  )

  const concerns: ConcernYieldEntry[] = []
  for (const scope of ADVERSARIAL_SCOPES) {
    const qualifyingRuns = runs.filter((run) => {
      const sr = findScopeResult(run, scope)
      return sr?.enabled === true && hasValidClaimData(sr)
    })
    if (qualifyingRuns.length === 0) continue

    const rates = qualifyingRuns
      .map((run) => findScopeResult(run, scope))
      .filter((sr): sr is ScopeResult => sr !== undefined)
      .map((sr) => scopeGroundingRate(sr))
      .filter((r): r is number => r !== undefined)

    if (rates.length === 0) continue

    const avgGroundingRate = rates.reduce((a, b) => a + b, 0) / rates.length
    if (!Number.isFinite(avgGroundingRate)) continue

    concerns.push({
      concern: SCOPE_TO_CONCERN[scope],
      activeRuns: qualifyingRuns.length,
      avgGroundingRate,
      suggestion: yieldSuggestion(avgGroundingRate),
    })
  }

  return {
    hasData: runsWithClaimData.length >= minRuns,
    runCount: runsWithClaimData.length,
    concerns,
  }
}

function computeSummaryFromRecords(records: HistoryRecord[], filter?: SummaryFilter): RunSummary {
  const since = filter?.since
  const until = filter?.until
  const runs = records.filter((r): r is RunRecord => {
    if (r.type !== "run") return false
    if (since !== undefined && r.timestamp < since) return false
    if (until !== undefined && r.timestamp > until) return false
    return true
  })
  if (runs.length === 0) {
    return {
      totalRuns: 0,
      successRate: 0,
      avgCostUsd: 0,
      avgDurationMs: 0,
      avgTestCount: 0,
      costTrend: "stable",
      byBlueprint: {},
    }
  }
  const successes = runs.filter((r) => r.status === "success").length
  const avgCost = runs.reduce((s, r) => s + r.totalCostUsd, 0) / runs.length
  const avgDuration = runs.reduce((s, r) => s + r.totalDurationMs, 0) / runs.length
  const avgTests =
    runs.reduce((s, r) => s + r.testCount.passed + r.testCount.skipped + r.testCount.failed, 0) /
    runs.length
  const mutScores = runs
    .filter((r) => r.mutationScore !== undefined)
    .map((r) => r.mutationScore as number)
  const avgMutation =
    mutScores.length > 0 ? mutScores.reduce((a, b) => a + b, 0) / mutScores.length : undefined

  const last5 = [...runs].sort((a, b) => a.timestamp - b.timestamp).slice(-5)
  const costTrend = computeCostTrend(last5.map((r) => r.totalCostUsd))

  const byBlueprint: RunSummary["byBlueprint"] = {}
  for (const r of runs) {
    const key = r.blueprintId
    if (!byBlueprint[key]) {
      byBlueprint[key] = { runs: 0, successRate: 0, avgCostUsd: 0 }
    }
    const bp = byBlueprint[key]
    if (bp) {
      bp.runs++
      if (r.status === "success") bp.successRate++
      bp.avgCostUsd += r.totalCostUsd
    }
  }
  for (const bp of Object.values(byBlueprint)) {
    bp.successRate = bp.runs > 0 ? bp.successRate / bp.runs : 0
    bp.avgCostUsd = bp.runs > 0 ? bp.avgCostUsd / bp.runs : 0
  }

  const base: RunSummary = {
    totalRuns: runs.length,
    successRate: successes / runs.length,
    avgCostUsd: avgCost,
    avgDurationMs: avgDuration,
    avgTestCount: avgTests,
    costTrend,
    byBlueprint,
  }
  return avgMutation !== undefined ? { ...base, avgMutationScore: avgMutation } : base
}

export class FileRunHistoryStore implements RunHistoryStore {
  private readonly jsonlPath: string
  private readonly dbPath: string
  private writeQueue: Promise<void> = Promise.resolve()
  private sqliteIndex: SqliteIndex | null = null
  private sqliteLoadAttempted = false

  constructor(workDir: string) {
    this.jsonlPath = join(workDir, ".bollard", "runs", "history.jsonl")
    this.dbPath = join(workDir, ".bollard", "runs", "history.db")
  }

  private async loadSqliteIndex(): Promise<SqliteIndex | null> {
    if (this.sqliteLoadAttempted) return this.sqliteIndex
    this.sqliteLoadAttempted = true
    try {
      await mkdir(dirname(this.dbPath), { recursive: true })
      const mod = await import("./run-history-db.js")
      this.sqliteIndex = mod.createSqliteIndex(this.dbPath)
      return this.sqliteIndex
    } catch {
      return null
    }
  }

  private async ensureDbCurrent(): Promise<SqliteIndex | null> {
    const idx = await this.loadSqliteIndex()
    if (!idx) return null
    const allRecords = await this.readAllRecords()
    const dbCount = idx.recordCount()
    if (allRecords.length > dbCount) {
      idx.rebuild(allRecords)
    }
    return idx
  }

  private async readAllRecords(): Promise<HistoryRecord[]> {
    let text: string
    try {
      text = await readFile(this.jsonlPath, "utf-8")
    } catch (err: unknown) {
      const code =
        err && typeof err === "object" && "code" in err ? (err as { code: string }).code : ""
      if (code === "ENOENT") return []
      throw err
    }
    const out: HistoryRecord[] = []
    for (const line of text.split("\n")) {
      const rec = parseHistoryLine(line)
      if (rec) out.push(rec)
    }
    return out
  }

  private async appendLocked(record: HistoryRecord): Promise<void> {
    const dir = dirname(this.jsonlPath)
    await mkdir(dir, { recursive: true })
    await appendFile(this.jsonlPath, "", "utf-8")
    const line = `${JSON.stringify(record)}\n`
    const release = await lockfile.lock(this.jsonlPath, {
      retries: { retries: 5, minTimeout: 20, maxTimeout: 80 },
    })
    try {
      await appendFile(this.jsonlPath, line, "utf-8")
    } finally {
      await release()
    }
  }

  async record(record: HistoryRecord): Promise<void> {
    const write = this.writeQueue.then(() => this.appendLocked(record))
    this.writeQueue = write.catch(() => undefined)
    await write
    const idx = this.sqliteIndex
    if (idx) {
      try {
        idx.insert(record)
      } catch {
        // Derived index out of sync — next read will rebuild from JSONL
      }
    }
  }

  async query(filter?: HistoryFilter): Promise<HistoryRecord[]> {
    const idx = await this.ensureDbCurrent()
    if (idx) {
      return idx.query(filter)
    }
    const all = await this.readAllRecords()
    const matched = all.filter((r) => matchesFilter(r, filter))
    const newestFirst = [...matched].reverse()
    const offset = filter?.offset ?? 0
    const limit = filter?.limit ?? 50
    if (limit <= 0) return []
    return newestFirst.slice(offset, offset + limit)
  }

  async findByRunId(runId: string): Promise<HistoryRecord | undefined> {
    const idx = await this.ensureDbCurrent()
    if (idx) {
      const found = idx.findByRunId(runId)
      if (found !== undefined) return found
    }
    const all = await this.readAllRecords()
    return all.find((r) => r.runId === runId)
  }

  async summary(filter?: SummaryFilter): Promise<RunSummary> {
    const idx = await this.ensureDbCurrent()
    if (idx) {
      return idx.summary(filter)
    }
    const all = await this.readAllRecords()
    return computeSummaryFromRecords(all, filter)
  }

  async rebuild(): Promise<{ runCount: number; durationMs: number }> {
    const idx = await this.loadSqliteIndex()
    if (!idx) {
      return { runCount: 0, durationMs: 0 }
    }
    const all = await this.readAllRecords()
    return idx.rebuild(all)
  }

  async compare(runIdA: string, runIdB: string): Promise<RunComparison> {
    const all = await this.readAllRecords()
    const find = (id: string): HistoryRecord | undefined =>
      all.find((r) => (r.type === "run" || r.type === "verify") && r.runId === id)
    const a = find(runIdA)
    const b = find(runIdB)
    if (a?.type !== "run") {
      throw new Error(`Run history compare: "${runIdA}" is not a pipeline run record`)
    }
    if (b?.type !== "run") {
      throw new Error(`Run history compare: "${runIdB}" is not a pipeline run record`)
    }
    const runA = a
    const runB = b
    const mapA = nodeStatusMap(runA.nodes)
    const mapB = nodeStatusMap(runB.nodes)
    const newFailingNodes: string[] = []
    const newPassingNodes: string[] = []
    for (const [id, stB] of mapB) {
      const stA = mapA.get(id)
      const wasOk = stA === "ok"
      const isOk = stB === "ok"
      if (!wasOk && isOk) newPassingNodes.push(id)
      if (wasOk && !isOk) newFailingNodes.push(id)
    }
    const scopeChanges: RunComparison["delta"]["scopeChanges"] = []
    const scopeBy = (scopes: ScopeResult[], sc: ScopeResult["scope"]) =>
      scopes.find((s) => s.scope === sc)
    for (const scope of ["boundary", "contract", "behavioral"] as const) {
      const sa = scopeBy(runA.scopes, scope)
      const sb = scopeBy(runB.scopes, scope)
      if (!sa || !sb) continue
      const fa = scopeNumericFields(sa)
      const fb = scopeNumericFields(sb)
      const keys = new Set([...Object.keys(fa), ...Object.keys(fb)])
      for (const field of keys) {
        const from = fa[field] ?? 0
        const to = fb[field] ?? 0
        if (from !== to) {
          scopeChanges.push({ scope, field, from, to })
        }
      }
    }
    const ta = totalTestCount(runA.testCount)
    const tb = totalTestCount(runB.testCount)
    const deltaBase = {
      costUsd: runB.totalCostUsd - runA.totalCostUsd,
      durationMs: runB.totalDurationMs - runA.totalDurationMs,
      testCountDelta: tb - ta,
      newFailingNodes,
      newPassingNodes,
      scopeChanges,
    }
    const delta =
      runA.mutationScore !== undefined && runB.mutationScore !== undefined
        ? {
            ...deltaBase,
            mutationScoreDelta: runB.mutationScore - runA.mutationScore,
          }
        : deltaBase

    return {
      runA,
      runB,
      delta,
    }
  }
}
