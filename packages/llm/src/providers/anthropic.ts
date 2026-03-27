import Anthropic from "@anthropic-ai/sdk"
import { BollardError } from "@bollard/engine/src/errors.js"
import type { LLMContentBlock, LLMProvider, LLMRequest, LLMResponse } from "../types.js"

const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-haiku-3-5-20241022": { input: 1, output: 5 },
  "claude-opus-4-20250514": { input: 15, output: 75 },
}

const DEFAULT_PRICING = { input: 3, output: 15 }

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICING[model] ?? DEFAULT_PRICING
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000
}

function mapContentBlock(block: Anthropic.ContentBlock): LLMContentBlock {
  if (block.type === "text") {
    return { type: "text", text: block.text }
  }
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      toolName: block.name,
      toolInput: block.input as Record<string, unknown>,
      toolUseId: block.id,
    }
  }
  return { type: "text", text: "" }
}

function mapStopReason(reason: Anthropic.Message["stop_reason"]): LLMResponse["stopReason"] {
  if (reason === "tool_use") return "tool_use"
  if (reason === "max_tokens") return "max_tokens"
  return "end_turn"
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic"
  private readonly client: Anthropic

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey })
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    try {
      const messages: Anthropic.MessageParam[] = request.messages.map((m) => ({
        role: m.role,
        content:
          typeof m.content === "string"
            ? m.content
            : m.content.map((b) => {
                if (b.type === "tool_result") {
                  return {
                    type: "tool_result" as const,
                    tool_use_id: b.toolUseId ?? "",
                    content: b.text ?? "",
                  }
                }
                if (b.type === "tool_use") {
                  return {
                    type: "tool_use" as const,
                    id: b.toolUseId ?? "",
                    name: b.toolName ?? "",
                    input: b.toolInput ?? {},
                  }
                }
                return { type: "text" as const, text: b.text ?? "" }
              }),
      }))

      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: request.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages,
        temperature: request.temperature,
      }

      if (request.tools?.length) {
        params.tools = request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
        }))
      }

      const response = await this.client.messages.create(params)

      const content = response.content.map(mapContentBlock)
      const { input_tokens: inputTokens, output_tokens: outputTokens } = response.usage

      return {
        content,
        stopReason: mapStopReason(response.stop_reason),
        usage: { inputTokens, outputTokens },
        costUsd: estimateCost(request.model, inputTokens, outputTokens),
      }
    } catch (err: unknown) {
      if (BollardError.is(err)) throw err

      if (err instanceof Anthropic.RateLimitError) {
        throw new BollardError({
          code: "LLM_RATE_LIMIT",
          message: `Anthropic rate limit: ${err.message}`,
          cause: err,
        })
      }
      if (err instanceof Anthropic.AuthenticationError) {
        throw new BollardError({
          code: "LLM_AUTH",
          message: `Anthropic auth error: ${err.message}`,
          cause: err,
        })
      }
      if (err instanceof Anthropic.APIConnectionTimeoutError) {
        throw new BollardError({
          code: "LLM_TIMEOUT",
          message: `Anthropic timeout: ${err.message}`,
          cause: err,
        })
      }
      if (err instanceof Error) {
        throw new BollardError({
          code: "LLM_PROVIDER_ERROR",
          message: `Anthropic error: ${err.message}`,
          cause: err,
        })
      }
      throw new BollardError({
        code: "LLM_PROVIDER_ERROR",
        message: `Anthropic error: ${String(err)}`,
      })
    }
  }
}
