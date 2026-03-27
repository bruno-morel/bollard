export interface LLMProvider {
  name: string
  chat(request: LLMRequest): Promise<LLMResponse>
}

export interface LLMRequest {
  system: string
  messages: LLMMessage[]
  tools?: LLMTool[]
  maxTokens: number
  temperature: number
  model: string
}

export interface LLMMessage {
  role: "user" | "assistant"
  content: string | LLMContentBlock[]
}

export interface LLMContentBlock {
  type: "text" | "tool_use" | "tool_result"
  text?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolUseId?: string
}

export interface LLMResponse {
  content: LLMContentBlock[]
  stopReason: "end_turn" | "tool_use" | "max_tokens"
  usage: { inputTokens: number; outputTokens: number }
  costUsd: number
}

export interface LLMTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}
