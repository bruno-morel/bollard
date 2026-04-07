import type { EvalCase } from "@bollard/engine/src/eval-runner.js"
import { boundaryTesterEvalCases } from "./evals/boundary-tester/cases.js"
import { coderEvalCases } from "./evals/coder/cases.js"
import { contractTesterEvalCases } from "./evals/contract-tester/cases.js"
import { plannerEvalCases } from "./evals/planner/cases.js"

const EVAL_SETS: Record<string, EvalCase[]> = {
  planner: plannerEvalCases,
  coder: coderEvalCases,
  "boundary-tester": boundaryTesterEvalCases,
  "contract-tester": contractTesterEvalCases,
}

const ALL_CASES_UNIQUE: EvalCase[] = (() => {
  const seen = new Set<string>()
  const out: EvalCase[] = []
  for (const list of [
    plannerEvalCases,
    coderEvalCases,
    boundaryTesterEvalCases,
    contractTesterEvalCases,
  ]) {
    for (const c of list) {
      if (!seen.has(c.id)) {
        seen.add(c.id)
        out.push(c)
      }
    }
  }
  return out
})()

export function loadEvalCases(agentFilter?: string): EvalCase[] {
  if (agentFilter === "tester") {
    return boundaryTesterEvalCases
  }
  if (agentFilter && agentFilter in EVAL_SETS) {
    return EVAL_SETS[agentFilter] ?? []
  }
  if (!agentFilter || agentFilter === "" || !(agentFilter in EVAL_SETS)) {
    return ALL_CASES_UNIQUE
  }
  return ALL_CASES_UNIQUE
}

export function availableAgents(): string[] {
  return ["planner", "coder", "boundary-tester", "contract-tester", "tester"].sort()
}
