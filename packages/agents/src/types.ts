import type { PipelineContext } from "@bollard/engine/src/context.js"

export type AgentProgressEvent =
  | { type: "turn_start"; turn: number; maxTurns: number; role: string }
  | {
      type: "turn_end"
      turn: number
      maxTurns: number
      role: string
      durationMs: number
      costUsd: number
      inputTokens: number
      outputTokens: number
      toolCallsThisTurn: number
      stopReason: string
    }
  | { type: "tool_call_start"; turn: number; tool: string; input: Record<string, unknown> }
  | {
      type: "tool_call_end"
      turn: number
      tool: string
      durationMs: number
      ok: boolean
      error?: string
    }

export type AgentProgressCallback = (event: AgentProgressEvent) => void

export interface AgentTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute(input: Record<string, unknown>, ctx: AgentContext): Promise<string>
}

export interface AgentContext {
  pipelineCtx: PipelineContext
  workDir: string
  allowedCommands?: string[]
  progress?: AgentProgressCallback
}

export interface AgentDefinition {
  role: string
  systemPrompt: string
  tools: AgentTool[]
  maxTurns: number
  temperature: number
  maxTokens?: number
}

export interface AgentResult {
  response: string
  data?: Record<string, unknown>
  totalCostUsd: number
  totalDurationMs: number
  turns: number
  toolCalls: { tool: string; input: Record<string, unknown>; output: string }[]
}

export interface ExecutorOptions {
  postCompletionHook?: (text: string) => Promise<string | null>
  maxVerificationRetries?: number
  /** When set, skip post-completion verification once `turns` reaches this value (0-based turn counter inside the executor). */
  deferPostCompletionVerifyFromTurn?: number
}
