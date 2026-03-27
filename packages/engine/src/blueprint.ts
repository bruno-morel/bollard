export type NodeType = "deterministic" | "agentic" | "risk_gate" | "human_gate"

export interface ProbeAssertion {
  type: "status" | "latency" | "json_field"
  expected: unknown
  path?: string
  maxMs?: number
}

export interface ProbeDefinition {
  id: string
  name: string
  endpoint: string
  method: "GET" | "POST"
  assertions: ProbeAssertion[]
  intervalSeconds: number
}

export interface NodeResult {
  status: "ok" | "fail" | "block"
  data?: unknown
  cost_usd?: number
  duration_ms?: number
  error?: string
  probes?: ProbeDefinition[]
}

export interface BlueprintNode {
  id: string
  name: string
  type: NodeType
  execute?: (ctx: unknown) => Promise<NodeResult>
  agent?: string
  postconditions?: ((ctx: unknown) => boolean)[]
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
