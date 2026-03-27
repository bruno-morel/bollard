import type { BollardConfig } from "@bollard/engine/src/context.js"
import { BollardError } from "@bollard/engine/src/errors.js"
import { MockProvider } from "./mock.js"
import { AnthropicProvider } from "./providers/anthropic.js"
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
      case "anthropic":
        provider = new AnthropicProvider(process.env["ANTHROPIC_API_KEY"]!)
        break
      case "mock":
        provider = new MockProvider(this.mockResponses ?? [])
        break
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
