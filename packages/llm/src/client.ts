import type { BollardConfig } from "@bollard/engine/src/context.js"
import { BollardError } from "@bollard/engine/src/errors.js"
import { MockProvider } from "./mock.js"
import { AnthropicProvider } from "./providers/anthropic.js"
import { GoogleProvider } from "./providers/google.js"
import { LocalProvider } from "./providers/local.js"
import { OpenAIProvider } from "./providers/openai.js"
import type { LLMProvider, LLMResponse } from "./types.js"

export class LLMClient {
  private readonly providers = new Map<string, LLMProvider>()

  constructor(
    private readonly config: BollardConfig,
    private readonly mockResponses?: LLMResponse[],
  ) {}

  forAgent(agentRole: string): { provider: LLMProvider; model: string } {
    const override = this.config.llm.agents?.[agentRole]
    const resolved = override ?? this.config.llm.default
    const provider = this.resolveProvider(resolved.provider)
    return { provider, model: resolved.model }
  }

  private resolveProvider(name: string): LLMProvider {
    const cached = this.providers.get(name)
    if (cached) return cached

    let provider: LLMProvider
    switch (name) {
      case "anthropic": {
        const apiKey = process.env["ANTHROPIC_API_KEY"]
        if (!apiKey) {
          throw new BollardError({
            code: "CONFIG_INVALID",
            message: "ANTHROPIC_API_KEY environment variable is not set",
          })
        }
        provider = new AnthropicProvider(apiKey)
        break
      }
      case "openai": {
        const openaiKey = process.env["OPENAI_API_KEY"]
        if (!openaiKey) {
          throw new BollardError({
            code: "CONFIG_INVALID",
            message: "OPENAI_API_KEY environment variable is not set",
          })
        }
        provider = new OpenAIProvider(openaiKey)
        break
      }
      case "google": {
        const googleKey = process.env["GOOGLE_API_KEY"]
        if (!googleKey) {
          throw new BollardError({
            code: "CONFIG_INVALID",
            message: "GOOGLE_API_KEY environment variable is not set",
          })
        }
        provider = new GoogleProvider(googleKey)
        break
      }
      case "mock":
        provider = new MockProvider(this.mockResponses ?? [])
        break
      case "local": {
        provider = new LocalProvider(this.config.localModels)
        break
      }
      default:
        throw new BollardError({
          code: "PROVIDER_NOT_FOUND",
          message: `Unknown LLM provider: "${name}"`,
          context: { provider: name },
        })
    }

    this.providers.set(name, provider)
    return provider
  }
}
