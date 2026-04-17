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

export interface Blueprint {
  id: string
  name: string
  nodes: BlueprintNode[]
  maxCostUsd: number
  maxDurationMinutes: number
}
