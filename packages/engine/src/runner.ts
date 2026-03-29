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

export type AgenticHandler = (node: BlueprintNode, ctx: PipelineContext) => Promise<NodeResult>

export type HumanGateHandler = (node: BlueprintNode, ctx: PipelineContext) => Promise<NodeResult>

export interface ProgressEvent {
  type: "node_start" | "node_complete" | "node_retry"
  nodeId: string
  nodeName: string
  nodeType: string
  step: number
  totalSteps: number
  status?: "ok" | "fail" | "block"
  attempt?: number
  maxAttempts?: number
  costUsd?: number
  durationMs?: number
}

export type ProgressCallback = (event: ProgressEvent) => void

function executeNode(
  node: BlueprintNode,
  ctx: PipelineContext,
  agenticHandler?: AgenticHandler,
  humanGateHandler?: HumanGateHandler,
): Promise<NodeResult> {
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
    case "agentic": {
      if (agenticHandler) {
        return agenticHandler(node, ctx)
      }
      return Promise.resolve({
        status: "ok" as const,
        data: "agentic node placeholder (no LLM client provided)",
        cost_usd: 0,
        duration_ms: 0,
      })
    }
    case "human_gate": {
      if (humanGateHandler) {
        return humanGateHandler(node, ctx)
      }
      return Promise.resolve({
        status: "ok" as const,
        data: "auto-approved (Stage 0)",
      })
    }
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
  agenticHandler?: AgenticHandler,
  humanGateHandler?: HumanGateHandler,
  onProgress?: ProgressCallback,
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
      const stepIndex = blueprint.nodes.indexOf(node)
      const maxAttempts = (node.maxRetries ?? 0) + 1
      let lastResult: NodeResult | undefined

      onProgress?.({
        type: "node_start",
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        step: stepIndex + 1,
        totalSteps: blueprint.nodes.length,
      })

      const nodeStartMs = Date.now()

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
          onProgress?.({
            type: "node_retry",
            nodeId: node.id,
            nodeName: node.name,
            nodeType: node.type,
            step: stepIndex + 1,
            totalSteps: blueprint.nodes.length,
            attempt: attempt + 1,
            maxAttempts,
          })
        }
        lastResult = await executeNode(node, ctx, agenticHandler, humanGateHandler)
        if (lastResult.cost_usd) {
          ctx.costTracker.add(lastResult.cost_usd)
        }
        if (lastResult.status !== "fail") break
      }

      const result = lastResult as NodeResult

      onProgress?.({
        type: "node_complete",
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        step: stepIndex + 1,
        totalSteps: blueprint.nodes.length,
        status: result.status,
        ...(result.cost_usd !== undefined ? { costUsd: result.cost_usd } : {}),
        durationMs: Date.now() - nodeStartMs,
      })

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
          error = {
            code: (result.error?.code ?? "NODE_EXECUTION_FAILED") as BollardErrorCode,
            message: result.error?.message ?? "Node failed",
          }
          break
        }
        status = "failure"
        ctx.results[node.id] = result
        error = {
          code: (result.error?.code ?? "NODE_EXECUTION_FAILED") as BollardErrorCode,
          message: result.error?.message ?? "Node failed",
        }
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
