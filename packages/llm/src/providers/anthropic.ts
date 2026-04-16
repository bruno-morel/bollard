import Anthropic from "@anthropic-ai/sdk"
import { BollardError } from "@bollard/engine/src/errors.js"
import type {
  LLMContentBlock,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
} from "../types.js"

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

function toAnthropicMessageParams(request: LLMRequest): Anthropic.MessageParam[] {
  return request.messages.map((m) => ({
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
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic"
  private readonly client: Anthropic

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey })
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    try {
      const messages = toAnthropicMessageParams(request)

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

  async *chatStream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    try {
      const messages = toAnthropicMessageParams(request)
      const stream = this.client.messages.stream({
        model: request.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages,
        temperature: request.temperature,
        ...(request.tools?.length
          ? {
              tools: request.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
              })),
            }
          : {}),
      })

      for await (const event of stream) {
        if (event.type === "content_block_start") {
          const block = event.content_block
          if (block.type === "tool_use") {
            yield {
              type: "tool_use_start",
              toolName: block.name,
              toolUseId: block.id,
            }
          }
        } else if (event.type === "content_block_delta") {
          const delta = event.delta
          if (delta.type === "text_delta") {
            yield { type: "text_delta", text: delta.text }
          } else if (delta.type === "input_json_delta") {
            yield {
              type: "tool_input_delta",
              toolUseId: "",
              partialJson: delta.partial_json,
            }
          }
        } else if (event.type === "content_block_stop") {
          yield { type: "content_block_stop", index: event.index }
        } else if (event.type === "message_delta") {
          const sr = event.delta.stop_reason
          yield {
            type: "message_delta",
            stopReason: sr ? mapStopReason(sr) : "end_turn",
            usage: { outputTokens: event.usage.output_tokens },
          }
        }
      }

      const finalMessage = await stream.finalMessage()
      const { input_tokens: inputTokens, output_tokens: outputTokens } = finalMessage.usage
      yield {
        type: "message_complete",
        response: {
          content: finalMessage.content.map(mapContentBlock),
          stopReason: mapStopReason(finalMessage.stop_reason),
          usage: { inputTokens, outputTokens },
          costUsd: estimateCost(request.model, inputTokens, outputTokens),
        },
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
          message: `Anthropic stream error: ${err.message}`,
          cause: err,
        })
      }
      throw new BollardError({
        code: "LLM_PROVIDER_ERROR",
        message: `Anthropic stream error: ${String(err)}`,
      })
    }
  }
}
