import { describe, it, expect } from "vitest"
import { AnthropicProvider } from "../../src/providers/anthropic.js"

describe("AnthropicProvider (adversarial, no network)", () => {
  it("exposes stable provider name", () => {
    const provider = new AnthropicProvider("test-key")
    expect(provider.name).toBe("anthropic")
  })

  it("implements chat and optional chatStream", () => {
    const provider = new AnthropicProvider("test-key")
    expect(typeof provider.chat).toBe("function")
    expect(provider.chatStream === undefined || typeof provider.chatStream === "function").toBe(true)
  })
})
