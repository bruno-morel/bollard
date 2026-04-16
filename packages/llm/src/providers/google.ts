import { BollardError } from "@bollard/engine/src/errors.js"
import { GoogleGenerativeAI } from "@google/generative-ai"
import type {
  Content,
  FunctionDeclaration,
  FunctionDeclarationSchema,
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

export class GoogleProvider implements LLMProvider {
  readonly name = "google"
  private readonly client: GoogleGenerativeAI

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey)
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    try {
      const tools: { functionDeclarations: FunctionDeclaration[] }[] = []
      if (request.tools?.length) {
        tools.push({
          functionDeclarations: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema as unknown as FunctionDeclarationSchema,
          })),
        })
      }

      const model = this.client.getGenerativeModel({
        model: request.model,
        systemInstruction: request.system,
        generationConfig: {
          maxOutputTokens: request.maxTokens,
          temperature: request.temperature,
        },
        ...(tools.length > 0 ? { tools } : {}),
      })

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
  }

  chatStream(_request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<LLMStreamEvent> {
        return {
          next: async () => {
            throw new BollardError({
              code: "PROVIDER_NOT_FOUND",
              message:
                "Google streaming not yet implemented — use chat() or switch to Anthropic provider",
            })
          },
        }
      },
    }
  }
}
