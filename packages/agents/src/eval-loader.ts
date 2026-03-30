import type { EvalCase } from "@bollard/engine/src/eval-runner.js"
import { coderEvalCases } from "./evals/coder/cases.js"
import { plannerEvalCases } from "./evals/planner/cases.js"
import { testerEvalCases } from "./evals/tester/cases.js"

const EVAL_SETS: Record<string, EvalCase[]> = {
  planner: plannerEvalCases,
  coder: coderEvalCases,
  tester: testerEvalCases,
}

export function loadEvalCases(agentFilter?: string): EvalCase[] {
  if (agentFilter && agentFilter in EVAL_SETS) {
    return EVAL_SETS[agentFilter] ?? []
  }
  return Object.values(EVAL_SETS).flat()
}

export function availableAgents(): string[] {
  return Object.keys(EVAL_SETS)
}
