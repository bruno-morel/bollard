import { BollardError } from "@bollard/engine/src/errors.js"
import OpenAI from "openai"
import type {
  LLMContentBlock,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
} from "../types.js"

// Pricing per 1M tokens (USD) — update periodically as pricing changes
const PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "o3-mini": { input: 1.1, output: 4.4 },
}

const DEFAULT_PRICING = { input: 2.5, output: 10 }

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICING[model] ?? DEFAULT_PRICING
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000
}

function mapStopReason(
  reason: string | null | undefined,
  hasToolCalls: boolean,
): LLMResponse["stopReason"] {
  if (hasToolCalls) return "tool_use"
  if (reason === "length") return "max_tokens"
  return "end_turn"
}

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai"
  private readonly client: OpenAI

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey })
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    try {
      const messages: OpenAI.ChatCompletionMessageParam[] = []

      messages.push({ role: "system", content: request.system })

      for (const msg of request.messages) {
        if (typeof msg.content === "string") {
          messages.push({ role: msg.role, content: msg.content })
          continue
        }

        if (msg.role === "assistant") {
          const textParts = msg.content.filter((b) => b.type === "text")
          const toolParts = msg.content.filter((b) => b.type === "tool_use")

          const textContent = textParts.map((b) => b.text ?? "").join("")
          const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
            role: "assistant",
            ...(textContent ? { content: textContent } : { content: null }),
          }

          if (toolParts.length > 0) {
            assistantMsg.tool_calls = toolParts.map((b) => ({
              id: b.toolUseId ?? "",
              type: "function" as const,
              function: {
                name: b.toolName ?? "",
                arguments: JSON.stringify(b.toolInput ?? {}),
              },
            }))
          }
          messages.push(assistantMsg)
          continue
        }

        for (const block of msg.content) {
          if (block.type === "tool_result") {
            messages.push({
              role: "tool",
              tool_call_id: block.toolUseId ?? "",
              content: block.text ?? "",
            })
          } else if (block.type === "text") {
            messages.push({ role: "user", content: block.text ?? "" })
          }
        }
      }

      const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
        model: request.model,
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        messages,
      }

      if (request.tools?.length) {
        params.tools = request.tools.map((t) => ({
          type: "function" as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          },
        }))
      }

      const response = await this.client.chat.completions.create(params)
      const choice = response.choices[0]
      if (!choice) {
        throw new BollardError({
          code: "LLM_INVALID_RESPONSE",
          message: "OpenAI returned no choices",
        })
      }

      const content: LLMContentBlock[] = []
      if (choice.message.content) {
        content.push({ type: "text", text: choice.message.content })
      }
      if (choice.message.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          let toolInput: Record<string, unknown> = {}
          try {
            toolInput = JSON.parse(tc.function.arguments) as Record<string, unknown>
          } catch {
            toolInput = { raw: tc.function.arguments }
          }
          content.push({
            type: "tool_use",
            toolName: tc.function.name,
            toolInput,
            toolUseId: tc.id,
          })
        }
      }

      const inputTokens = response.usage?.prompt_tokens ?? 0
      const outputTokens = response.usage?.completion_tokens ?? 0
      const hasToolCalls = (choice.message.tool_calls?.length ?? 0) > 0

      return {
        content,
        stopReason: mapStopReason(choice.finish_reason, hasToolCalls),
        usage: { inputTokens, outputTokens },
        costUsd: estimateCost(request.model, inputTokens, outputTokens),
      }
    } catch (err: unknown) {
      if (BollardError.is(err)) throw err

      if (err instanceof OpenAI.RateLimitError) {
        throw new BollardError({
          code: "LLM_RATE_LIMIT",
          message: `OpenAI rate limit: ${err.message}`,
          cause: err,
        })
      }
      if (err instanceof OpenAI.AuthenticationError) {
        throw new BollardError({
          code: "LLM_AUTH",
          message: `OpenAI auth error: ${err.message}`,
          cause: err,
        })
      }
      if (err instanceof OpenAI.APIConnectionTimeoutError) {
        throw new BollardError({
          code: "LLM_TIMEOUT",
          message: `OpenAI timeout: ${err.message}`,
          cause: err,
        })
      }
      if (err instanceof Error) {
        throw new BollardError({
          code: "LLM_PROVIDER_ERROR",
          message: `OpenAI error: ${err.message}`,
          cause: err,
        })
      }
      throw new BollardError({
        code: "LLM_PROVIDER_ERROR",
        message: `OpenAI error: ${String(err)}`,
      })
    }
  }

  chatStream(_request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<LLMStreamEvent> {
        return {
          next: async () => {
            throw new BollardError({
              code: "PROVIDER_NOT_FOUND",
              message:
                "OpenAI streaming not yet implemented — use chat() or switch to Anthropic provider",
            })
          },
        }
      },
    }
  }
}
