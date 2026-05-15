import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { HistoryRecord, RunHistoryStore, RunRecord } from "./run-history.js"

export interface CostBaseline {
  tag: string
  runId: string
  timestamp: number
  blueprintId: string
  totalCostUsd: number
  coderTurns?: number
  avgInputTokensPerTurn?: number
  thresholdPct: number
  notes?: string
}

export interface CostBaselineComparison {
  baseline: CostBaseline
  current: { avgCostUsd: number; runCount: number; since: number }
  regressionPct: number
  passed: boolean
  verdict: "pass" | "fail" | "insufficient_data"
}

const QUERY_LIMIT = 50_000

function warnCompare(message: string): void {
  process.stderr.write(`[cost-baseline] ${message}\n`)
}

export async function readBaseline(baselineFile: string): Promise<CostBaseline | null> {
  let text: string
  try {
    text = await readFile(baselineFile, "utf-8")
  } catch (err: unknown) {
    const code =
      err && typeof err === "object" && "code" in err ? (err as { code: string }).code : ""
    if (code === "ENOENT") return null
    throw err
  }
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== "object") {
    throw new Error("cost-baseline: invalid JSON object")
  }
  return parsed as CostBaseline
}

export async function writeBaseline(baselineFile: string, baseline: CostBaseline): Promise<void> {
  await mkdir(dirname(baselineFile), { recursive: true })
  await writeFile(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`, "utf-8")
}

function isSuccessfulRun(r: HistoryRecord, blueprintId: string): r is RunRecord {
  return r.type === "run" && r.blueprintId === blueprintId && r.status === "success"
}

export async function compareToBaseline(
  baseline: CostBaseline,
  store: RunHistoryStore,
): Promise<CostBaselineComparison> {
  const emptyCurrent = {
    avgCostUsd: 0,
    runCount: 0,
    since: baseline.timestamp,
  }
  const insufficient = (): CostBaselineComparison => ({
    baseline,
    current: emptyCurrent,
    regressionPct: 0,
    passed: true,
    verdict: "insufficient_data",
  })

  try {
    const rows = await store.query({
      blueprintId: baseline.blueprintId,
      since: baseline.timestamp,
      limit: QUERY_LIMIT,
      offset: 0,
    })
    const runs = rows.filter((r) => isSuccessfulRun(r, baseline.blueprintId))
    if (runs.length < 3) {
      const avgCostUsd =
        runs.length === 0 ? 0 : runs.reduce((s, r) => s + r.totalCostUsd, 0) / runs.length
      return {
        baseline,
        current: { avgCostUsd, runCount: runs.length, since: baseline.timestamp },
        regressionPct: 0,
        passed: true,
        verdict: "insufficient_data",
      }
    }
    const avgCostUsd = runs.reduce((s, r) => s + r.totalCostUsd, 0) / runs.length
    const denom = baseline.totalCostUsd > 0 ? baseline.totalCostUsd : 1
    const regressionPct = ((avgCostUsd - baseline.totalCostUsd) / denom) * 100
    const passed = regressionPct <= baseline.thresholdPct
    const verdict: "pass" | "fail" = passed ? "pass" : "fail"
    return {
      baseline,
      current: { avgCostUsd, runCount: runs.length, since: baseline.timestamp },
      regressionPct,
      passed,
      verdict,
    }
  } catch (err) {
    warnCompare(
      `compareToBaseline failed: ${err instanceof Error ? err.message : String(err)} — treating as insufficient_data`,
    )
    return insufficient()
  }
}
