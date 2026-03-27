import type { Blueprint, BlueprintNode, NodeResult } from "./blueprint.js"
import type { BollardConfig, PipelineContext } from "./context.js"
import { createContext } from "./context.js"
import type { BollardErrorCode } from "./errors.js"
import { BollardError } from "./errors.js"

export interface RunResult {
  status: "success" | "failure" | "handed_to_human"
  runId: string
  totalCostUsd: number
  totalDurationMs: number
  nodeResults: Record<string, NodeResult>
  error?: { code: BollardErrorCode; message: string }
}

function executeNode(node: BlueprintNode, ctx: PipelineContext): Promise<NodeResult> {
  switch (node.type) {
    case "deterministic": {
      if (!node.execute) {
        throw new BollardError({
          code: "NODE_EXECUTION_FAILED",
          message: `Deterministic node "${node.id}" has no execute function`,
          context: { nodeId: node.id },
        })
      }
      return node.execute(ctx)
    }
    case "agentic":
      // TODO Stage 1: wire to LLMClient
      return Promise.resolve({
        status: "ok" as const,
        data: "agentic node placeholder",
        cost_usd: 0,
        duration_ms: 0,
      })
    case "human_gate":
      return Promise.resolve({
        status: "ok" as const,
        data: "auto-approved (Stage 0)",
      })
    case "risk_gate":
      return Promise.resolve({
        status: "ok" as const,
        data: "risk-gate auto-approved (Stage 0)",
      })
  }
}

function checkPostconditions(node: BlueprintNode, ctx: PipelineContext): void {
  if (!node.postconditions) return
  for (const check of node.postconditions) {
    if (!check(ctx)) {
      throw new BollardError({
        code: "POSTCONDITION_FAILED",
        message: `Postcondition failed for node "${node.id}"`,
        context: { nodeId: node.id },
      })
    }
  }
}

export async function runBlueprint(
  blueprint: Blueprint,
  task: string,
  config: BollardConfig,
): Promise<RunResult> {
  const ctx = createContext(task, blueprint.id, config)
  let status: RunResult["status"] = "success"
  let error: RunResult["error"] | undefined

  try {
    for (const node of blueprint.nodes) {
      const elapsed = Date.now() - ctx.startedAt
      if (elapsed > blueprint.maxDurationMinutes * 60_000) {
        throw new BollardError({
          code: "TIME_LIMIT_EXCEEDED",
          message: `Time limit of ${blueprint.maxDurationMinutes}m exceeded`,
          context: { elapsedMs: elapsed, limitMinutes: blueprint.maxDurationMinutes },
        })
      }

      if (ctx.costTracker.exceeded()) {
        throw new BollardError({
          code: "COST_LIMIT_EXCEEDED",
          message: `Cost limit of $${config.agent.max_cost_usd} exceeded`,
          context: { totalCost: ctx.costTracker.total(), limit: config.agent.max_cost_usd },
        })
      }

      ctx.currentNode = node.id
      const maxAttempts = (node.maxRetries ?? 0) + 1
      let lastResult: NodeResult | undefined

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        lastResult = await executeNode(node, ctx)
        if (lastResult.cost_usd) {
          ctx.costTracker.add(lastResult.cost_usd)
        }
        if (lastResult.status !== "fail") break
      }

      const result = lastResult as NodeResult

      if (result.status === "fail") {
        const policy = node.onFailure ?? "stop"
        if (policy === "skip") {
          ctx.log.warn(`Node "${node.id}" failed, skipping per onFailure policy`, {
            nodeId: node.id,
          })
          ctx.results[node.id] = result
          continue
        }
        if (policy === "hand_to_human") {
          status = "handed_to_human"
          ctx.results[node.id] = result
          error = { code: "NODE_EXECUTION_FAILED", message: result.error ?? "Node failed" }
          break
        }
        status = "failure"
        ctx.results[node.id] = result
        error = { code: "NODE_EXECUTION_FAILED", message: result.error ?? "Node failed" }
        break
      }

      checkPostconditions(node, ctx)
      ctx.results[node.id] = result
    }
  } catch (err: unknown) {
    status = "failure"
    if (BollardError.is(err)) {
      error = { code: err.code, message: err.message }
    } else {
      error = { code: "NODE_EXECUTION_FAILED", message: String(err) }
    }
  }

  const totalDurationMs = Date.now() - ctx.startedAt

  const base = {
    runId: ctx.runId,
    totalCostUsd: ctx.costTracker.total(),
    totalDurationMs,
    nodeResults: ctx.results,
    status,
  }

  if (error !== undefined) {
    return { ...base, error }
  }
  return base
}
