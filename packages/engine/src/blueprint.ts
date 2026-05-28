import type { PipelineContext } from "./context.js"

export type NodeType = "deterministic" | "agentic" | "risk_gate" | "human_gate"

export interface ProbeAssertion {
  type: "status" | "latency" | "json_field" | "body_contains" | "body_matches" | "header"
  expected: unknown
  path?: string
  maxMs?: number
  /** HTTP header name when type is "header" */
  name?: string
}

export interface ProbeDefinition {
  id: string
  name: string
  endpoint: string
  method: "GET" | "POST"
  body?: unknown
  headers?: Record<string, string>
  assertions: ProbeAssertion[]
  intervalSeconds: number
  riskTier: "low" | "medium" | "high" | "critical"
  sourceRunId?: string
  sourceClaimId?: string
}

export interface NodeResultError {
  code: string
  message: string
}

export interface NodeResult {
  status: "ok" | "fail" | "block"
  data?: unknown
  cost_usd?: number
  duration_ms?: number
  turns?: number
  error?: NodeResultError
  probes?: ProbeDefinition[]
}

export interface BlueprintNode {
  id: string
  name: string
  type: NodeType
  execute?: (ctx: PipelineContext) => Promise<NodeResult>
  agent?: string
  postconditions?: ((ctx: PipelineContext) => boolean)[]
  onFailure?: "stop" | "retry" | "skip" | "hand_to_human"
  maxRetries?: number
}

export interface BlueprintBranch {
  /** Stable identifier used in progress events and result keys. */
  id: string
  /** Human-readable label shown in CLI progress (e.g. "boundary scope"). */
  name: string
  nodes: BlueprintNode[]
}

export interface BlueprintNodeGroup {
  /** Discriminator — runner checks this to choose parallel path. */
  kind: "parallel"
  id: string
  name: string
  branches: BlueprintBranch[]
  /**
   * What to do if any branch fails.
   * "skip" — log warn, continue pipeline (matches existing onFailure: "skip" convention).
   * "stop" — propagate failure upward (default).
   */
  onBranchFailure?: "stop" | "skip"
}

/** Union of sequential node and parallel group — what the blueprint nodes array contains. */
export type BlueprintEntry = BlueprintNode | BlueprintNodeGroup

export function isParallelGroup(entry: BlueprintEntry): entry is BlueprintNodeGroup {
  return (entry as BlueprintNodeGroup).kind === "parallel"
}

export function flattenBlueprintNodes(entries: BlueprintEntry[]): BlueprintNode[] {
  const out: BlueprintNode[] = []
  for (const entry of entries) {
    if (isParallelGroup(entry)) {
      for (const branch of entry.branches) {
        out.push(...branch.nodes)
      }
    } else {
      out.push(entry)
    }
  }
  return out
}

/** Each top-level entry (node or parallel group) counts as one pipeline step. */
export function countBlueprintSteps(entries: BlueprintEntry[]): number {
  return entries.length
}

export interface Blueprint {
  id: string
  name: string
  nodes: BlueprintEntry[]
  maxCostUsd: number
  maxDurationMinutes: number
}
