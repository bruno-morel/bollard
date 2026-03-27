import type { BollardConfig } from "@bollard/engine/src/context.js"
import { BollardError } from "@bollard/engine/src/errors.js"
import { describe, expect, it } from "vitest"
import { LLMClient } from "../src/client.js"
import { MockProvider } from "../src/mock.js"
import { AnthropicProvider } from "../src/providers/anthropic.js"
import type { LLMResponse } from "../src/types.js"

function makeResponse(text: string): LLMResponse {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
  }
}

const MOCK_REQUEST = {
  system: "test",
  messages: [{ role: "user" as const, content: "hello" }],
  maxTokens: 10,
  temperature: 0,
  model: "test",
}

function mockConfig(overrides?: Partial<BollardConfig>): BollardConfig {
  return {
    llm: { default: { provider: "mock", model: "test-model" } },
    agent: { max_cost_usd: 10, max_duration_minutes: 30 },
    ...overrides,
  }
}

describe("MockProvider", () => {
  it("returns canned responses in order", async () => {
    const provider = new MockProvider([makeResponse("first"), makeResponse("second")])

    const r1 = await provider.chat(MOCK_REQUEST)
    const r2 = await provider.chat(MOCK_REQUEST)

    expect(r1.content[0]?.text).toBe("first")
    expect(r2.content[0]?.text).toBe("second")
  })

  it("throws BollardError when responses are exhausted", async () => {
    const provider = new MockProvider([makeResponse("only")])
    await provider.chat(MOCK_REQUEST)

    try {
      await provider.chat(MOCK_REQUEST)
      expect.unreachable("should have thrown")
    } catch (err) {
      expect(BollardError.hasCode(err, "LLM_PROVIDER_ERROR")).toBe(true)
    }
  })
})

describe("LLMClient", () => {
  it("resolves default provider for any agent role", () => {
    const client = new LLMClient(mockConfig())
    const { provider, model } = client.forAgent("anything")

    expect(provider.name).toBe("mock")
    expect(model).toBe("test-model")
  })

  it("resolves per-agent override when configured", () => {
    const config = mockConfig({
      llm: {
        default: { provider: "mock", model: "default-model" },
        agents: { coder: { provider: "mock", model: "coder-model" } },
      },
    })
    const client = new LLMClient(config)
    const { model } = client.forAgent("coder")

    expect(model).toBe("coder-model")
  })

  it("falls back to default when agent role has no override", () => {
    const config = mockConfig({
      llm: {
        default: { provider: "mock", model: "default-model" },
        agents: { coder: { provider: "mock", model: "coder-model" } },
      },
    })
    const client = new LLMClient(config)
    const { model } = client.forAgent("planner")

    expect(model).toBe("default-model")
  })

  it("caches provider instances across forAgent calls", () => {
    const client = new LLMClient(mockConfig())
    const { provider: p1 } = client.forAgent("a")
    const { provider: p2 } = client.forAgent("b")

    expect(p1).toBe(p2)
  })

  it("throws PROVIDER_NOT_FOUND for unknown provider", () => {
    const config = mockConfig({
      llm: { default: { provider: "nonexistent", model: "x" } },
    })
    const client = new LLMClient(config)

    expect(() => client.forAgent("any")).toThrow(BollardError)
    try {
      client.forAgent("any")
    } catch (err) {
      expect(BollardError.hasCode(err, "PROVIDER_NOT_FOUND")).toBe(true)
    }
  })
})

describe.skipIf(!process.env["ANTHROPIC_API_KEY"])("AnthropicProvider (live)", () => {
  it("sends a message and gets a response", async () => {
    const apiKey = process.env["ANTHROPIC_API_KEY"] ?? ""
    const provider = new AnthropicProvider(apiKey)
    const response = await provider.chat({
      system: "You are a test assistant. Reply with exactly: BOLLARD_TEST_OK",
      messages: [{ role: "user", content: "Reply now." }],
      maxTokens: 50,
      temperature: 0,
      model: "claude-haiku-3-5-20241022",
    })

    expect(response.content.length).toBeGreaterThan(0)
    expect(response.usage.outputTokens).toBeGreaterThan(0)
    expect(response.costUsd).toBeGreaterThan(0)
  })
})
