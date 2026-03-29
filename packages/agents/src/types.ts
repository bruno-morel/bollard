import type { PipelineContext } from "@bollard/engine/src/context.js"

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
}
