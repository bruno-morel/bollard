import { BollardError } from "@bollard/engine/src/errors.js"
import { GoogleGenerativeAI } from "@google/generative-ai"
import type {
  Content,
  FunctionDeclaration,
  FunctionDeclarationSchema,
  GenerateContentResponse,
  GenerativeModel,
  Part,
} from "@google/generative-ai"
import type {
  LLMContentBlock,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
} from "../types.js"

// Pricing per 1M tokens (USD) — update periodically as pricing changes
const PRICING: Record<string, { input: number; output: number }> = {
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-2.5-pro-preview-05-06": { input: 1.25, output: 10 },
}

const DEFAULT_PRICING = { input: 0.1, output: 0.4 }

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICING[model] ?? DEFAULT_PRICING
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000
}

function mapGoogleStopReason(
  finishReason: string | undefined,
  hasToolCalls: boolean,
): LLMResponse["stopReason"] {
  if (hasToolCalls) return "tool_use"
  if (finishReason === "MAX_TOKENS") return "max_tokens"
  return "end_turn"
}

function mapGoogleError(err: unknown): never {
  if (BollardError.is(err)) throw err

  if (err instanceof Error) {
    const message = err.message.toLowerCase()
    if (message.includes("rate limit") || message.includes("quota")) {
      throw new BollardError({
        code: "LLM_RATE_LIMIT",
        message: `Google rate limit: ${err.message}`,
        cause: err,
      })
    }
    if (
      message.includes("api key") ||
      message.includes("authentication") ||
      message.includes("unauthorized")
    ) {
      throw new BollardError({
        code: "LLM_AUTH",
        message: `Google auth error: ${err.message}`,
        cause: err,
      })
    }
    if (message.includes("timeout") || message.includes("timed out")) {
      throw new BollardError({
        code: "LLM_TIMEOUT",
        message: `Google timeout: ${err.message}`,
        cause: err,
      })
    }
    throw new BollardError({
      code: "LLM_PROVIDER_ERROR",
      message: `Google error: ${err.message}`,
      cause: err,
    })
  }
  throw new BollardError({
    code: "LLM_PROVIDER_ERROR",
    message: `Google error: ${String(err)}`,
  })
}

/** Tools config for Google model (exported for tests). */
export function buildGoogleToolsConfig(
  request: LLMRequest,
): { functionDeclarations: FunctionDeclaration[] }[] | undefined {
  if (!request.tools?.length) return undefined
  return [
    {
      functionDeclarations: request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as unknown as FunctionDeclarationSchema,
      })),
    },
  ]
}

/** Message contents for chat / stream (exported for tests). */
export function buildGoogleContents(request: LLMRequest): Content[] {
  const contents: Content[] = []

  for (const msg of request.messages) {
    const role = msg.role === "assistant" ? "model" : "user"

    if (typeof msg.content === "string") {
      contents.push({ role, parts: [{ text: msg.content }] })
      continue
    }

    const parts: Part[] = []
    for (const block of msg.content) {
      if (block.type === "text") {
        parts.push({ text: block.text ?? "" })
      } else if (block.type === "tool_use") {
        parts.push({
          functionCall: {
            name: block.toolName ?? "",
            args: (block.toolInput ?? {}) as Record<string, string>,
          },
        })
      } else if (block.type === "tool_result") {
        parts.push({
          functionResponse: {
            name: block.toolName ?? block.toolUseId ?? "",
            response: { result: block.text ?? "" },
          },
        })
      }
    }

    if (parts.length > 0) {
      contents.push({ role, parts })
    }
  }

  return contents
}

export function getGoogleModel(client: GoogleGenerativeAI, request: LLMRequest): GenerativeModel {
  const tools = buildGoogleToolsConfig(request)
  return client.getGenerativeModel({
    model: request.model,
    systemInstruction: request.system,
    generationConfig: {
      maxOutputTokens: request.maxTokens,
      temperature: request.temperature,
    },
    ...(tools ? { tools } : {}),
  })
}

/** Maps Google streaming chunks to Bollard stream events (exported for tests). */
export async function* googleChunksToStreamEvents(
  modelId: string,
  chunks: AsyncIterable<GenerateContentResponse>,
): AsyncIterable<LLMStreamEvent> {
  let textBuffer = ""
  const toolRecords: { toolUseId: string; toolName: string; toolInput: Record<string, unknown> }[] =
    []
  let blockIndex = 0
  let sawCandidate = false
  let lastFinishReason: string | undefined
  let promptTokens = 0
  let outputTokens = 0

  for await (const chunk of chunks) {
    if (chunk.usageMetadata) {
      promptTokens = chunk.usageMetadata.promptTokenCount ?? promptTokens
      outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens
    }

    const candidate = chunk.candidates?.[0]
    if (!candidate) continue

    sawCandidate = true

    for (const part of candidate.content?.parts ?? []) {
      if ("text" in part && part.text) {
        textBuffer += part.text
        yield { type: "text_delta", text: part.text }
      }
      if ("functionCall" in part && part.functionCall) {
        const fc = part.functionCall
        const toolUseId = `google-${fc.name}-${Date.now()}-${blockIndex}`
        const argsObj = (fc.args ?? {}) as Record<string, unknown>
        const json = JSON.stringify(argsObj)
        yield { type: "tool_use_start", toolName: fc.name, toolUseId }
        yield { type: "tool_input_delta", toolUseId, partialJson: json }
        yield { type: "content_block_stop", index: blockIndex }
        blockIndex++
        toolRecords.push({
          toolUseId,
          toolName: fc.name,
          toolInput: argsObj,
        })
      }
    }

    if (candidate.finishReason) {
      lastFinishReason = candidate.finishReason
      const hasToolCalls = toolRecords.length > 0
      yield {
        type: "message_delta",
        stopReason: mapGoogleStopReason(candidate.finishReason, hasToolCalls),
        usage: { outputTokens },
      }
    }
  }

  if (!sawCandidate) {
    throw new BollardError({
      code: "LLM_INVALID_RESPONSE",
      message: "Google stream yielded no candidates",
    })
  }

  const content: LLMContentBlock[] = []
  if (textBuffer) {
    content.push({ type: "text", text: textBuffer })
  }
  for (const t of toolRecords) {
    content.push({
      type: "tool_use",
      toolName: t.toolName,
      toolInput: t.toolInput,
      toolUseId: t.toolUseId,
    })
  }

  const hasToolCalls = toolRecords.length > 0
  yield {
    type: "message_complete",
    response: {
      content,
      stopReason: mapGoogleStopReason(lastFinishReason, hasToolCalls),
      usage: { inputTokens: promptTokens, outputTokens },
      costUsd: estimateCost(modelId, promptTokens, outputTokens),
    },
  }
}

export class GoogleProvider implements LLMProvider {
  readonly name = "google"
  private readonly client: GoogleGenerativeAI

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey)
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    try {
      const model = getGoogleModel(this.client, request)
      const contents = buildGoogleContents(request)

      const result = await model.generateContent({ contents })
      const response = result.response
      const candidate = response.candidates?.[0]

      if (!candidate) {
        throw new BollardError({
          code: "LLM_INVALID_RESPONSE",
          message: "Google returned no candidates",
        })
      }

      const content: LLMContentBlock[] = []
      let hasToolCalls = false

      for (const part of candidate.content?.parts ?? []) {
        if ("text" in part && part.text) {
          content.push({ type: "text", text: part.text })
        }
        if ("functionCall" in part && part.functionCall) {
          hasToolCalls = true
          content.push({
            type: "tool_use",
            toolName: part.functionCall.name,
            toolInput: (part.functionCall.args ?? {}) as Record<string, unknown>,
            toolUseId: `google-${part.functionCall.name}-${Date.now()}`,
          })
        }
      }

      const inputTokens = response.usageMetadata?.promptTokenCount ?? 0
      const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0

      let stopReason: LLMResponse["stopReason"] = "end_turn"
      if (hasToolCalls) stopReason = "tool_use"
      else if (candidate.finishReason === "MAX_TOKENS") stopReason = "max_tokens"

      return {
        content,
        stopReason,
        usage: { inputTokens, outputTokens },
        costUsd: estimateCost(request.model, inputTokens, outputTokens),
      }
    } catch (err: unknown) {
      mapGoogleError(err)
    }
  }

  async *chatStream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const model = getGoogleModel(this.client, request)
    const contents = buildGoogleContents(request)

    let stream: AsyncGenerator<GenerateContentResponse>
    try {
      const result = await model.generateContentStream({ contents })
      stream = result.stream
    } catch (err: unknown) {
      mapGoogleError(err)
    }

    try {
      yield* googleChunksToStreamEvents(request.model, stream)
    } catch (err: unknown) {
      mapGoogleError(err)
    }
  }
}
