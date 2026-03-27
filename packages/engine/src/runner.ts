import type { Blueprint, NodeResult } from "./blueprint.js"
import type { BollardConfig } from "./context.js"
import type { BollardErrorCode } from "./errors.js"

export interface RunResult {
  status: "success" | "failure" | "handed_to_human"
  runId: string
  totalCostUsd: number
  totalDurationMs: number
  nodeResults: Record<string, NodeResult>
  error?: { code: BollardErrorCode; message: string }
}

export async function runBlueprint(
  _blueprint: Blueprint,
  _task: string,
  _config: BollardConfig,
): Promise<RunResult> {
  return {
    status: "success",
    runId: "",
    totalCostUsd: 0,
    totalDurationMs: 0,
    nodeResults: {},
  }
}
