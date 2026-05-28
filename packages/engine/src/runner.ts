import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import type { Blueprint, BlueprintNode, BlueprintNodeGroup, NodeResult } from "./blueprint.js"
import { countBlueprintSteps, isParallelGroup } from "./blueprint.js"
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
  type: "node_start" | "node_complete" | "node_retry" | "group_start" | "group_complete"
  step: number
  totalSteps: number
  nodeId?: string
  nodeName?: string
  nodeType?: string
  status?: "ok" | "fail" | "block"
  attempt?: number
  maxAttempts?: number
  costUsd?: number
  durationMs?: number
  groupId?: string
  groupName?: string
  branchIds?: string[]
}

export type ProgressCallback = (event: ProgressEvent) => void

export type RunBlueprintCompleteCallback = (
  ctx: PipelineContext,
  result: RunResult,
  blueprint: Blueprint,
) => Promise<void>

interface RunNodeOutcome {
  continuePipeline: boolean
  pipelineStatus?: RunResult["status"]
  error?: RunResult["error"]
}

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

function assertTimeAndCostLimits(
  ctx: PipelineContext,
  blueprint: Blueprint,
  config: BollardConfig,
): void {
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
}

interface RunBlueprintNodeOptions {
  step: number
  totalSteps: number
  enableRetries: boolean
  setCurrentNode: boolean
  agenticHandler: AgenticHandler | undefined
  humanGateHandler: HumanGateHandler | undefined
  onProgress: ProgressCallback | undefined
  blueprint: Blueprint
  config: BollardConfig
}

async function runBlueprintNode(
  node: BlueprintNode,
  ctx: PipelineContext,
  options: RunBlueprintNodeOptions,
): Promise<RunNodeOutcome> {
  const {
    step,
    totalSteps,
    enableRetries,
    setCurrentNode,
    agenticHandler,
    humanGateHandler,
    onProgress,
    blueprint,
    config,
  } = options

  assertTimeAndCostLimits(ctx, blueprint, config)

  if (setCurrentNode) {
    ctx.currentNode = node.id
  }

  const maxAttempts = enableRetries ? (node.maxRetries ?? 0) + 1 : 1
  let lastResult: NodeResult | undefined

  onProgress?.({
    type: "node_start",
    nodeId: node.id,
    nodeName: node.name,
    nodeType: node.type,
    step,
    totalSteps,
  })

  const nodeStartMs = Date.now()

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      onProgress?.({
        type: "node_retry",
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        step,
        totalSteps,
        attempt: attempt + 1,
        maxAttempts,
      })
    }
    lastResult = await executeNode(node, ctx, agenticHandler, humanGateHandler)
    if (lastResult.cost_usd) {
      ctx.costTracker.add(lastResult.cost_usd)
    }
    if (ctx.costTracker.exceeded()) {
      throw new BollardError({
        code: "COST_LIMIT_EXCEEDED",
        message: `Cost limit of $${config.agent.max_cost_usd} exceeded after node "${node.id}"`,
        context: {
          totalCost: ctx.costTracker.total(),
          limit: config.agent.max_cost_usd,
          nodeId: node.id,
        },
      })
    }
    if (lastResult.status !== "fail") break
  }

  const result = lastResult as NodeResult

  onProgress?.({
    type: "node_complete",
    nodeId: node.id,
    nodeName: node.name,
    nodeType: node.type,
    step,
    totalSteps,
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
      return { continuePipeline: true }
    }
    if (policy === "hand_to_human") {
      ctx.results[node.id] = result
      return {
        continuePipeline: false,
        pipelineStatus: "handed_to_human",
        error: {
          code: (result.error?.code ?? "NODE_EXECUTION_FAILED") as BollardErrorCode,
          message: result.error?.message ?? "Node failed",
        },
      }
    }
    ctx.results[node.id] = result
    return {
      continuePipeline: false,
      pipelineStatus: "failure",
      error: {
        code: (result.error?.code ?? "NODE_EXECUTION_FAILED") as BollardErrorCode,
        message: result.error?.message ?? "Node failed",
      },
    }
  }

  checkPostconditions(node, ctx)
  ctx.results[node.id] = result
  return { continuePipeline: true }
}

async function executeParallelGroup(
  group: BlueprintNodeGroup,
  ctx: PipelineContext,
  blueprint: Blueprint,
  config: BollardConfig,
  agenticHandler: AgenticHandler | undefined,
  humanGateHandler: HumanGateHandler | undefined,
  onProgress: ProgressCallback | undefined,
  step: number,
  totalSteps: number,
): Promise<{ status: "ok" | "fail" }> {
  const allNodeIds = group.branches.flatMap((b) => b.nodes.map((n) => n.id))
  const seen = new Set<string>()
  for (const id of allNodeIds) {
    if (seen.has(id)) {
      throw new BollardError({
        code: "NODE_EXECUTION_FAILED",
        message: `Parallel group "${group.id}" has duplicate node ID "${id}" across branches`,
        context: { groupId: group.id, duplicateId: id },
      })
    }
    seen.add(id)
  }

  onProgress?.({
    type: "group_start",
    groupId: group.id,
    groupName: group.name,
    branchIds: group.branches.map((b) => b.id),
    step,
    totalSteps,
  })

  const groupStartMs = Date.now()

  const branchPromises = group.branches.map(async (branch) => {
    try {
      let branchFailed = false
      let branchError: RunResult["error"] | undefined
      let branchStatus: RunResult["status"] | undefined

      for (const node of branch.nodes) {
        const outcome = await runBlueprintNode(node, ctx, {
          step,
          totalSteps,
          enableRetries: false,
          setCurrentNode: false,
          agenticHandler,
          humanGateHandler,
          onProgress,
          blueprint,
          config,
        })

        if (!outcome.continuePipeline) {
          branchFailed = true
          branchError = outcome.error
          branchStatus = outcome.pipelineStatus
          break
        }
      }

      return { branchId: branch.id, branchFailed, branchError, branchStatus }
    } catch (err: unknown) {
      ctx.log.warn("parallel branch threw unexpectedly", {
        branchId: branch.id,
        error: err instanceof Error ? err.message : String(err),
      })
      return {
        branchId: branch.id,
        branchFailed: true,
        branchError: BollardError.is(err)
          ? { code: err.code, message: err.message }
          : { code: "NODE_EXECUTION_FAILED" as BollardErrorCode, message: String(err) },
        branchStatus: "failure" as const,
      }
    }
  })

  // Promise.allSettled (not Promise.all): a thrown/rejected branch must not cancel siblings.
  // All branches run to completion; onBranchFailure: "skip" is applied after inspecting outcomes.
  const settled = await Promise.allSettled(branchPromises)

  let anyFailed = false
  for (const s of settled) {
    if (s.status === "rejected") {
      anyFailed = true
      ctx.log.warn("parallel branch settlement rejected", { error: String(s.reason) })
      continue
    }
    if (s.value.branchFailed) {
      anyFailed = true
    }
  }

  const groupStatus = anyFailed ? "fail" : "ok"

  onProgress?.({
    type: "group_complete",
    groupId: group.id,
    groupName: group.name,
    branchIds: group.branches.map((b) => b.id),
    status: groupStatus,
    step,
    totalSteps,
    durationMs: Date.now() - groupStartMs,
  })

  return { status: groupStatus }
}

export async function runBlueprint(
  blueprint: Blueprint,
  task: string,
  config: BollardConfig,
  agenticHandler?: AgenticHandler,
  humanGateHandler?: HumanGateHandler,
  onProgress?: ProgressCallback,
  toolchainProfile?: ToolchainProfile,
  onRunComplete?: RunBlueprintCompleteCallback,
  skipChecks?: string[],
): Promise<RunResult> {
  const ctx = createContext(task, blueprint.id, config)
  if (toolchainProfile !== undefined) {
    ctx.toolchainProfile = toolchainProfile
  }
  if (skipChecks !== undefined) {
    ctx.skipChecks = skipChecks
  }
  let status: RunResult["status"] = "success"
  let error: RunResult["error"] | undefined

  const totalSteps = countBlueprintSteps(blueprint.nodes)

  try {
    for (let entryIndex = 0; entryIndex < blueprint.nodes.length; entryIndex++) {
      const entry = blueprint.nodes[entryIndex]
      if (entry === undefined) continue

      const step = entryIndex + 1

      assertTimeAndCostLimits(ctx, blueprint, config)

      if (isParallelGroup(entry)) {
        const groupResult = await executeParallelGroup(
          entry,
          ctx,
          blueprint,
          config,
          agenticHandler,
          humanGateHandler,
          onProgress,
          step,
          totalSteps,
        )

        if (groupResult.status === "fail") {
          const policy = entry.onBranchFailure ?? "stop"
          if (policy === "skip") {
            ctx.log.warn(`Parallel group "${entry.id}" had branch failures, skipping per policy`, {
              groupId: entry.id,
            })
            continue
          }
          status = "failure"
          error = {
            code: "NODE_EXECUTION_FAILED",
            message: `Parallel group "${entry.id}" had branch failures`,
          }
          break
        }
        continue
      }

      const outcome = await runBlueprintNode(entry, ctx, {
        step,
        totalSteps,
        enableRetries: true,
        setCurrentNode: true,
        agenticHandler,
        humanGateHandler,
        onProgress,
        blueprint,
        config,
      })

      if (!outcome.continuePipeline) {
        status = outcome.pipelineStatus ?? "failure"
        error = outcome.error
        break
      }
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

  const result: RunResult = error !== undefined ? { ...base, error } : base

  if (onRunComplete !== undefined) {
    try {
      await onRunComplete(ctx, result, blueprint)
    } catch (err: unknown) {
      ctx.log.warn("onRunComplete callback failed (run history may not be persisted)", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return result
}
