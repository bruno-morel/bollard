import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import { compactOlderTurns, executeAgent } from "../src/executor.js"
import { BollardError } from "@bollard/engine/src/errors.js"
import type {
  LLMContentBlock,
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMTool,
} from "@bollard/llm/src/types.js"
import type { AgentContext, AgentDefinition, AgentResult, ExecutorOptions } from "../src/types.js"

describe("Feature: compactOlderTurns modifies message array in place", () => {
  it("should not modify empty array", () => {
    const messages: LLMMessage[] = []
    compactOlderTurns(messages)
    expect(messages).toEqual([])
  })

  it("should not modify single message", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] }
    ]
    const original = JSON.parse(JSON.stringify(messages))
    compactOlderTurns(messages)
    expect(messages).toEqual(original)
  })

  it("should preserve message structure after compaction", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "response1" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
      { role: "assistant", content: [{ type: "text", text: "response2" }] }
    ]
    compactOlderTurns(messages)
    
    // All remaining messages should have valid structure
    for (const msg of messages) {
      expect(msg).toHaveProperty("role")
      expect(msg).toHaveProperty("content")
      expect(Array.isArray(msg.content)).toBe(true)
    }
  })

  it("should handle messages with multiple content blocks", () => {
    const messages: LLMMessage[] = [
      { 
        role: "user", 
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: "world" }
        ] 
      }
    ]
    compactOlderTurns(messages)
    expect(messages[0].content).toHaveLength(2)
  })
})

describe("Feature: compactOlderTurns property-based tests", () => {
  it("should never increase message count", () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        role: fc.constantFrom("user", "assistant", "system"),
        content: fc.array(fc.record({
          type: fc.constant("text"),
          text: fc.string()
        }), { minLength: 1 })
      })),
      (messages) => {
        const originalLength = messages.length
        compactOlderTurns(messages)
        expect(messages.length).toBeLessThanOrEqual(originalLength)
      }
    ))
  })

  it("should preserve all role types present", () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        role: fc.constantFrom("user", "assistant", "system"),
        content: fc.array(fc.record({
          type: fc.constant("text"),
          text: fc.string()
        }), { minLength: 1 })
      }), { minLength: 1 }),
      (messages) => {
        const originalRoles = new Set(messages.map(m => m.role))
        compactOlderTurns(messages)
        const compactedRoles = new Set(messages.map(m => m.role))
        
        // If we had any messages, we should still have at least one role
        if (originalRoles.size > 0) {
          expect(compactedRoles.size).toBeGreaterThan(0)
        }
      }
    ))
  })
})

describe("Feature: executeAgent returns AgentResult", () => {
  const mockProvider: LLMProvider = {
    name: "test-provider",
    chat: async () => ({
      content: [{ type: "text", text: "mock response" }],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    })
  }

  const mockAgent: AgentDefinition = {
    name: "test-agent",
    role: "assistant",
    instructions: "You are a test agent",
    tools: []
  }

  const mockContext: AgentContext = {
    messages: [],
    variables: new Map()
  }

  it("should return AgentResult with required properties", async () => {
    const result = await executeAgent(
      mockAgent,
      "test message",
      mockProvider,
      "gpt-4",
      mockContext
    )

    expect(result).toHaveProperty("content")
    expect(result).toHaveProperty("usage")
    expect(result).toHaveProperty("messages")
    expect(Array.isArray(result.messages)).toBe(true)
  })

  it("should handle empty user message", async () => {
    const result = await executeAgent(
      mockAgent,
      "",
      mockProvider,
      "gpt-4",
      mockContext
    )

    expect(result).toHaveProperty("content")
    expect(result.messages.length).toBeGreaterThan(0)
  })

  it("should preserve context messages", async () => {
    const contextWithMessages: AgentContext = {
      messages: [
        { role: "user", content: [{ type: "text", text: "previous message" }] }
      ],
      variables: new Map()
    }

    const result = await executeAgent(
      mockAgent,
      "new message",
      mockProvider,
      "gpt-4",
      contextWithMessages
    )

    expect(result.messages.length).toBeGreaterThan(1)
  })

  it("should handle agent with tools", async () => {
    const agentWithTools: AgentDefinition = {
      ...mockAgent,
      tools: [
        {
          name: "test-tool",
          description: "A test tool",
          inputSchema: {
            type: "object",
            properties: {
              input: { type: "string" }
            }
          }
        }
      ]
    }

    const result = await executeAgent(
      agentWithTools,
      "use a tool",
      mockProvider,
      "gpt-4",
      mockContext
    )

    expect(result).toHaveProperty("content")
  })
})

describe("Feature: executeAgent negative tests", () => {
  const mockProvider: LLMProvider = {
    name: "test-provider",
    chat: async () => ({
      content: [{ type: "text", text: "mock response" }],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    })
  }

  const mockContext: AgentContext = {
    messages: [],
    variables: new Map()
  }

  it("should handle agent with empty name", async () => {
    const agent: AgentDefinition = {
      name: "",
      role: "assistant",
      instructions: "test",
      tools: []
    }

    // ASSUMPTION: function handles empty name gracefully
    const result = await executeAgent(
      agent,
      "test",
      mockProvider,
      "gpt-4",
      mockContext
    )

    expect(result).toHaveProperty("content")
  })

  it("should handle agent with empty instructions", async () => {
    const agent: AgentDefinition = {
      name: "test",
      role: "assistant",
      instructions: "",
      tools: []
    }

    const result = await executeAgent(
      agent,
      "test",
      mockProvider,
      "gpt-4",
      mockContext
    )

    expect(result).toHaveProperty("content")
  })

  it("should handle empty model string", async () => {
    const agent: AgentDefinition = {
      name: "test",
      role: "assistant",
      instructions: "test",
      tools: []
    }

    // ASSUMPTION: function handles empty model gracefully
    const result = await executeAgent(
      agent,
      "test",
      mockProvider,
      "",
      mockContext
    )

    expect(result).toHaveProperty("content")
  })

  it("should handle context with empty variables map", async () => {
    const agent: AgentDefinition = {
      name: "test",
      role: "assistant",
      instructions: "test",
      tools: []
    }

    const emptyContext: AgentContext = {
      messages: [],
      variables: new Map()
    }

    const result = await executeAgent(
      agent,
      "test",
      mockProvider,
      "gpt-4",
      emptyContext
    )

    expect(result).toHaveProperty("content")
  })
})

describe("Feature: executeAgent property-based tests", () => {
  const mockProvider: LLMProvider = {
    name: "test-provider",
    chat: async () => ({
      content: [{ type: "text", text: "mock response" }],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    })
  }

  it("should always return valid AgentResult structure", () => {
    fc.assert(fc.property(
      fc.record({
        name: fc.string(),
        role: fc.string(),
        instructions: fc.string(),
        tools: fc.array(fc.record({
          name: fc.string(),
          description: fc.string(),
          inputSchema: fc.record({
            type: fc.constant("object"),
            properties: fc.dictionary(fc.string(), fc.anything())
          })
        }))
      }),
      fc.string(),
      fc.string(),
      async (agent, userMessage, model) => {
        const context: AgentContext = {
          messages: [],
          variables: new Map()
        }

        const result = await executeAgent(
          agent,
          userMessage,
          mockProvider,
          model,
          context
        )

        expect(result).toHaveProperty("content")
        expect(result).toHaveProperty("usage")
        expect(result).toHaveProperty("messages")
        expect(Array.isArray(result.messages)).toBe(true)
        expect(typeof result.usage.totalTokens).toBe("number")
        expect(result.usage.totalTokens).toBeGreaterThanOrEqual(0)
      }
    ))
  })

  it("should handle variable user message lengths", () => {
    fc.assert(fc.property(
      fc.string(),
      async (userMessage) => {
        const agent: AgentDefinition = {
          name: "test",
          role: "assistant", 
          instructions: "test",
          tools: []
        }

        const context: AgentContext = {
          messages: [],
          variables: new Map()
        }

        const result = await executeAgent(
          agent,
          userMessage,
          mockProvider,
          "gpt-4",
          context
        )

        expect(result.messages.length).toBeGreaterThan(0)
        expect(result.messages.some(m => m.role === "user")).toBe(true)
      }
    ))
  })
})