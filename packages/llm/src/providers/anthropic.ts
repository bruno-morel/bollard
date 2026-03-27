import type { LLMProvider, LLMRequest, LLMResponse } from "../types.js"

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic"

  async chat(_request: LLMRequest): Promise<LLMResponse> {
    return {
      content: [],
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
    }
  }
}
