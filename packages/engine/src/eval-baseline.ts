import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export interface AgentEvalScore {
  agent: string
  caseCount: number
  passRate: number
  thresholdPct: number
  /** Model that produced this score. Absent on baselines tagged before Phase 4b. */
  model?: string
}

export interface EvalBaseline {
  tag: string
  timestamp: number
  model: string
  scores: AgentEvalScore[]
  notes?: string
}

export interface EvalBaselineComparison {
  baseline: EvalBaseline
  current: AgentEvalScore[]
  regressions: AgentEvalScore[]
  verdict: "pass" | "fail" | "no_baseline"
}

export async function readEvalBaseline(baselineFile: string): Promise<EvalBaseline | null> {
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
    throw new Error("eval-baseline: invalid JSON object")
  }
  return parsed as EvalBaseline
}

export async function writeEvalBaseline(
  baselineFile: string,
  baseline: EvalBaseline,
): Promise<void> {
  await mkdir(dirname(baselineFile), { recursive: true })
  await writeFile(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`, "utf-8")
}

export function compareToEvalBaseline(
  baseline: EvalBaseline,
  current: AgentEvalScore[],
): EvalBaselineComparison {
  const regressions: AgentEvalScore[] = []
  const currentByAgent = new Map(current.map((s) => [s.agent, s]))

  for (const baselineScore of baseline.scores) {
    const currentScore = currentByAgent.get(baselineScore.agent)
    if (!currentScore) continue

    const dropPct = (baselineScore.passRate - currentScore.passRate) * 100
    if (dropPct > baselineScore.thresholdPct) {
      regressions.push(currentScore)
    }
  }

  return {
    baseline,
    current,
    regressions,
    verdict: regressions.length > 0 ? "fail" : "pass",
  }
}
