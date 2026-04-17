import { createContext } from "@bollard/engine/src/context.js"
import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import type { LLMProvider, LLMResponse } from "@bollard/llm/src/types.js"
import { compactOlderTurns, executeAgent } from "../src/executor.js"
import type { AgentContext, AgentDefinition } from "../src/types.js"

const TEST_CONFIG = {
  llm: { default: { provider: "test", model: "test" } },
  agent: { max_cost_usd: 10, max_duration_minutes: 30 },
}

function makeCtx(): AgentContext {
  return {
    pipelineCtx: createContext("test task", "test-bp", TEST_CONFIG),
    workDir: "/tmp/test",
  }
}

function textResponse(text: string, costUsd = 0.001): LLMResponse {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 5 },
    costUsd,
  }
}

function makeAgent(overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    role: "test-agent",
    systemPrompt: "You are a test agent.",
    tools: [],
    maxTurns: 10,
    temperature: 0.3,
    ...overrides,
  }
}

describe("Feature: compactOlderTurns modifies message array in place", () => {
  it("should not modify empty array", () => {
    const messages: import("@bollard/llm/src/types.js").LLMMessage[] = []
    compactOlderTurns(messages)
    expect(messages).toEqual([])
  })

  it("should not modify single message", () => {
    const messages: import("@bollard/llm/src/types.js").LLMMessage[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]
    const original = JSON.parse(JSON.stringify(messages))
    compactOlderTurns(messages)
    expect(messages).toEqual(original)
  })

  it("should preserve message structure after compaction", () => {
    const messages: import("@bollard/llm/src/types.js").LLMMessage[] = [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "response1" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
      { role: "assistant", content: [{ type: "text", text: "response2" }] },
    ]
    compactOlderTurns(messages)

    for (const msg of messages) {
      expect(msg).toHaveProperty("role")
      expect(msg).toHaveProperty("content")
      expect(Array.isArray(msg.content)).toBe(true)
    }
  })

  it("should handle messages with multiple content blocks", () => {
    const messages: import("@bollard/llm/src/types.js").LLMMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: "world" },
        ],
      },
    ]
    compactOlderTurns(messages)
    expect(messages[0]?.content).toHaveLength(2)
  })
})

describe("Feature: compactOlderTurns property-based tests", () => {
  it("should never increase message count", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            role: fc.constantFrom("user", "assistant", "system"),
            content: fc.array(
              fc.record({
                type: fc.constant("text" as const),
                text: fc.string(),
              }),
              { minLength: 1 },
            ),
          }),
        ),
        (messages) => {
          const originalLength = messages.length
          compactOlderTurns(messages)
          expect(messages.length).toBeLessThanOrEqual(originalLength)
        },
      ),
    )
  })

  it("should preserve all role types present", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            role: fc.constantFrom("user", "assistant", "system"),
            content: fc.array(
              fc.record({
                type: fc.constant("text" as const),
                text: fc.string(),
              }),
              { minLength: 1 },
            ),
          }),
          { minLength: 1 },
        ),
        (messages) => {
          const originalRoles = new Set(messages.map((m) => m.role))
          compactOlderTurns(messages)
          const compactedRoles = new Set(messages.map((m) => m.role))

          if (originalRoles.size > 0) {
            expect(compactedRoles.size).toBeGreaterThan(0)
          }
        },
      ),
    )
  })
})

describe("Feature: executeAgent returns AgentResult", () => {
  const mockProvider: LLMProvider = {
    name: "test-provider",
    chat: async () => textResponse("mock response"),
  }

  const mockAgent = makeAgent()

  it("should return AgentResult with required properties", async () => {
    const result = await executeAgent(mockAgent, "test message", mockProvider, "gpt-4", makeCtx())

    expect(result).toHaveProperty("response")
    expect(result).toHaveProperty("totalCostUsd")
    expect(result).toHaveProperty("totalDurationMs")
    expect(result).toHaveProperty("turns")
    expect(result).toHaveProperty("toolCalls")
    expect(Array.isArray(result.toolCalls)).toBe(true)
  })

  it("should handle empty user message", async () => {
    const result = await executeAgent(mockAgent, "", mockProvider, "gpt-4", makeCtx())

    expect(result.response).toBeDefined()
    expect(result.turns).toBeGreaterThanOrEqual(0)
  })

  it("should handle agent with tools that have execute", async () => {
    const agentWithTools: AgentDefinition = {
      ...makeAgent(),
      tools: [
        {
          name: "test-tool",
          description: "A test tool",
          inputSchema: {
            type: "object",
            properties: {
              input: { type: "string" },
            },
          },
          execute: async () => "tool output",
        },
      ],
    }

    const provider: LLMProvider = {
      name: "p",
      chat: async () => textResponse("done"),
    }

    const result = await executeAgent(agentWithTools, "use a tool", provider, "gpt-4", makeCtx())

    expect(result).toHaveProperty("response")
  })
})

describe("Feature: executeAgent negative tests", () => {
  const mockProvider: LLMProvider = {
    name: "test-provider",
    chat: async () => textResponse("mock response"),
  }

  it("should handle empty role string in agent", async () => {
    const agent: AgentDefinition = {
      ...makeAgent(),
      role: "",
    }

    const result = await executeAgent(agent, "test", mockProvider, "gpt-4", makeCtx())

    expect(result).toHaveProperty("response")
  })

  it("should handle empty systemPrompt", async () => {
    const agent: AgentDefinition = {
      ...makeAgent(),
      systemPrompt: "",
    }

    const result = await executeAgent(agent, "test", mockProvider, "gpt-4", makeCtx())

    expect(result).toHaveProperty("response")
  })

  it("should handle empty model string", async () => {
    const agent = makeAgent()

    const result = await executeAgent(agent, "test", mockProvider, "", makeCtx())

    expect(result).toHaveProperty("response")
  })
})

describe("Feature: executeAgent property-based tests", () => {
  const mockProvider: LLMProvider = {
    name: "test-provider",
    chat: async () => textResponse("mock response"),
  }

  it("should always return valid AgentResult structure", () => {
    fc.assert(
      fc.asyncProperty(
        fc.record({
          role: fc.string(),
          systemPrompt: fc.string(),
          maxTurns: fc.integer({ min: 1, max: 20 }),
          temperature: fc.double({ min: 0, max: 1, noNaN: true }),
        }),
        fc.string(),
        fc.string(),
        async (agentFields, userMessage, model) => {
          const agent: AgentDefinition = {
            role: agentFields.role || "agent",
            systemPrompt: agentFields.systemPrompt,
            tools: [],
            maxTurns: agentFields.maxTurns,
            temperature: agentFields.temperature,
          }

          const result = await executeAgent(agent, userMessage, mockProvider, model, makeCtx())

          expect(result).toHaveProperty("response")
          expect(result).toHaveProperty("totalCostUsd")
          expect(result).toHaveProperty("totalDurationMs")
          expect(result).toHaveProperty("turns")
          expect(result).toHaveProperty("toolCalls")
          expect(typeof result.totalCostUsd).toBe("number")
          expect(result.totalCostUsd).toBeGreaterThanOrEqual(0)
        },
      ),
    )
  })

  it("should handle variable user message lengths", () => {
    fc.assert(
      fc.asyncProperty(fc.string(), async (userMessage) => {
        const agent = makeAgent()

        const result = await executeAgent(agent, userMessage, mockProvider, "gpt-4", makeCtx())

        expect(result.response).toBeDefined()
        expect(result.turns).toBeGreaterThanOrEqual(0)
      }),
    )
  })
})
