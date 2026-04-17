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

function mapOpenAIError(err: unknown): never {
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

/** Shared message list for chat + streaming (exported for tests). */
export function buildOpenAIMessages(request: LLMRequest): OpenAI.ChatCompletionMessageParam[] {
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

  return messages
}

type ToolStreamBuffer = {
  id: string
  name: string
  args: string
  announced: boolean
}

/** Maps OpenAI streaming chunks to Bollard stream events (exported for tests). */
export async function* openAIChunksToStreamEvents(
  model: string,
  chunks: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
): AsyncIterable<LLMStreamEvent> {
  const toolBuffers = new Map<number, ToolStreamBuffer>()
  let textBuffer = ""
  let finishReason: string | null | undefined
  let lastPromptTokens = 0
  let lastCompletionTokens = 0
  let blockIndex = 0

  for await (const chunk of chunks) {
    if (chunk.usage) {
      lastPromptTokens = chunk.usage.prompt_tokens ?? lastPromptTokens
      lastCompletionTokens = chunk.usage.completion_tokens ?? lastCompletionTokens
    }

    const choice = chunk.choices[0]
    if (!choice) continue

    const delta = choice.delta

    if (delta.content) {
      textBuffer += delta.content
      yield { type: "text_delta", text: delta.content }
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        let buf = toolBuffers.get(idx)
        if (!buf) {
          buf = { id: "", name: "", args: "", announced: false }
          toolBuffers.set(idx, buf)
        }
        if (tc.id) buf.id = tc.id
        if (tc.function?.name) {
          buf.name = tc.function.name
          if (!buf.announced) {
            buf.announced = true
            yield {
              type: "tool_use_start",
              toolName: buf.name,
              toolUseId: buf.id || `call_${idx}`,
            }
          }
        }
        if (tc.function?.arguments) {
          buf.args += tc.function.arguments
          yield {
            type: "tool_input_delta",
            toolUseId: buf.id || `call_${idx}`,
            partialJson: tc.function.arguments,
          }
        }
      }
    }

    if (choice.finish_reason) {
      finishReason = choice.finish_reason
      const sortedIdx = [...toolBuffers.keys()].sort((a, b) => a - b)
      for (const _ of sortedIdx) {
        yield { type: "content_block_stop", index: blockIndex }
        blockIndex++
      }
      const hasToolCalls = toolBuffers.size > 0
      yield {
        type: "message_delta",
        stopReason: mapStopReason(choice.finish_reason, hasToolCalls),
        usage: { outputTokens: lastCompletionTokens },
      }
    }
  }

  if (finishReason === undefined || finishReason === null) {
    throw new BollardError({
      code: "LLM_INVALID_RESPONSE",
      message: "OpenAI stream ended without finish_reason",
    })
  }

  const content: LLMContentBlock[] = []
  if (textBuffer) {
    content.push({ type: "text", text: textBuffer })
  }

  const sortedIdx = [...toolBuffers.keys()].sort((a, b) => a - b)
  for (const idx of sortedIdx) {
    const buf = toolBuffers.get(idx)
    if (!buf?.name) continue
    let toolInput: Record<string, unknown> = {}
    try {
      toolInput = JSON.parse(buf.args) as Record<string, unknown>
    } catch {
      toolInput = { raw: buf.args }
    }
    content.push({
      type: "tool_use",
      toolName: buf.name,
      toolInput,
      toolUseId: buf.id || `call_${idx}`,
    })
  }

  const hasToolCalls = content.some((b) => b.type === "tool_use")
  const inputTokens = lastPromptTokens
  const outputTokens = lastCompletionTokens

  yield {
    type: "message_complete",
    response: {
      content,
      stopReason: mapStopReason(finishReason, hasToolCalls),
      usage: { inputTokens, outputTokens },
      costUsd: estimateCost(model, inputTokens, outputTokens),
    },
  }
}

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai"
  private readonly client: OpenAI

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey })
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    try {
      const messages = buildOpenAIMessages(request)

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
      mapOpenAIError(err)
    }
  }

  async *chatStream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>
    try {
      const messages = buildOpenAIMessages(request)
      const params: OpenAI.ChatCompletionCreateParamsStreaming = {
        model: request.model,
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        messages,
        stream: true,
        stream_options: { include_usage: true },
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
      stream = await this.client.chat.completions.create(params)
    } catch (err: unknown) {
      mapOpenAIError(err)
    }

    try {
      yield* openAIChunksToStreamEvents(request.model, stream)
    } catch (err: unknown) {
      mapOpenAIError(err)
    }
  }
}
