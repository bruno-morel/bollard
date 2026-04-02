```typescript
import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import { LLMClient } from "../src/client.js"
import { MockProvider } from "../src/mock.js"
import { AnthropicProvider } from "../src/providers/anthropic.js"
import { GoogleProvider } from "../src/providers/google.js"
import { OpenAIProvider } from "../src/providers/openai.js"
import type { LLMRequest, LLMResponse, LLMMessage, LLMContentBlock, LLMTool } from "../src/types.js"

describe("Feature: LLMClient public API", () => {
  const mockConfig = {
    llm: {
      default: { provider: "openai", model: "gpt-4" },
      agents: {
        "test-agent": { provider: "anthropic", model: "claude-3-sonnet" }
      }
    }
  }

  it("should construct with valid config", () => {
    const client = new LLMClient(mockConfig)
    expect(client).toBeInstanceOf(LLMClient)
  })

  it("should construct with mock responses", () => {
    const mockResponses: LLMResponse[] = [{
      content: [{ type: "text", text: "test" }],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
      costUsd: 0.001
    }]
    const client = new LLMClient(mockConfig, mockResponses)
    expect(client).toBeInstanceOf(LLMClient)
  })

  it("should return provider and model for known agent", () => {
    const client = new LLMClient(mockConfig)
    const result = client.forAgent("test-agent")
    expect(result).toHaveProperty("provider")
    expect(result).toHaveProperty("model")
    expect(typeof result.model).toBe("string")
  })

  it("should handle unknown agent role", () => {
    const client = new LLMClient(mockConfig)
    const result = client.forAgent("unknown-agent")
    expect(result).toHaveProperty("provider")
    expect(result).toHaveProperty("model")
  })
})

describe("Feature: MockProvider behavior", () => {
  it("should construct with empty responses", () => {
    const provider = new MockProvider()
    expect(provider.name).toBe("mock")
  })

  it("should construct with predefined responses", () => {
    const responses: LLMResponse[] = [{
      content: [{ type: "text", text: "mock response" }],
      stopReason: "end_turn",
      usage: { inputTokens: 5, outputTokens: 3 },
      costUsd: 0.0005
    }]
    const provider = new MockProvider(responses)
    expect(provider.name).toBe("mock")
  })

  it("should handle chat request", async () => {
    const mockResponse: LLMResponse = {
      content: [{ type: "text", text: "test response" }],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
      costUsd: 0.001
    }
    const provider = new MockProvider([mockResponse])
    
    const request: LLMRequest = {
      system: "You are a test assistant",
      messages: [{ role: "user", content: "Hello" }],
      maxTokens: 100,
      temperature: 0.7,
      model: "test-model"
    }
    
    const response = await provider.chat(request)
    expect(response).toHaveProperty("content")
    expect(response).toHaveProperty("stopReason")
    expect(response).toHaveProperty("usage")
    expect(response).toHaveProperty("costUsd")
  })
})

describe("Feature: Provider constructors", () => {
  it("should construct AnthropicProvider with API key", () => {
    const provider = new AnthropicProvider("test-key")
    expect(provider.name).toBe("anthropic")
  })

  it("should construct GoogleProvider with API key", () => {
    const provider = new GoogleProvider("test-key")
    expect(provider.name).toBe("google")
  })

  it("should construct OpenAIProvider with API key", () => {
    const provider = new OpenAIProvider("test-key")
    expect(provider.name).toBe("openai")
  })
})

describe("Feature: Negative cases and boundaries", () => {
  it("should handle empty string agent role", () => {
    const client = new LLMClient(mockConfig)
    const result = client.forAgent("")
    expect(result).toHaveProperty("provider")
    expect(result).toHaveProperty("model")
  })

  it("should handle null/undefined in mock responses", () => {
    const provider = new MockProvider(undefined)
    expect(provider.name).toBe("mock")
  })

  it("should handle empty API keys", () => {
    const anthropic = new AnthropicProvider("")
    const google = new GoogleProvider("")
    const openai = new OpenAIProvider("")
    
    expect(anthropic.name).toBe("anthropic")
    expect(google.name).toBe("google")
    expect(openai.name).toBe("openai")
  })

  it("should handle malformed config", () => {
    const badConfig = { llm: {} }
    const client = new LLMClient(badConfig as any)
    expect(client).toBeInstanceOf(LLMClient)
  })
})

describe("Feature: Property-based tests", () => {
  it("should handle arbitrary agent roles", () => {
    fc.assert(fc.property(
      fc.string(),
      (agentRole) => {
        const client = new LLMClient(mockConfig)
        const result = client.forAgent(agentRole)
        expect(result).toHaveProperty("provider")
        expect(result).toHaveProperty("model")
        expect(typeof result.model).toBe("string")
      }
    ))
  })

  it("should handle arbitrary API keys", () => {
    fc.assert(fc.property(
      fc.string(),
      (apiKey) => {
        const anthropic = new AnthropicProvider(apiKey)
        const google = new GoogleProvider(apiKey)
        const openai = new OpenAIProvider(apiKey)
        
        expect(anthropic.name).toBe("anthropic")
        expect(google.name).toBe("google")
        expect(openai.name).toBe("openai")
      }
    ))
  })

  it("should handle arbitrary LLM requests", () => {
    fc.assert(fc.property(
      fc.record({
        system: fc.string(),
        messages: fc.array(fc.record({
          role: fc.constantFrom("user", "assistant"),
          content: fc.oneof(
            fc.string(),
            fc.array(fc.record({
              type: fc.constantFrom("text", "tool_use", "tool_result"),
              text: fc.option(fc.string()),
              toolName: fc.option(fc.string()),
              toolInput: fc.option(fc.object()),
              toolUseId: fc.option(fc.string())
            }))
          )
        })),
        maxTokens: fc.integer({ min: 1, max: 10000 }),
        temperature: fc.float({ min: 0, max: 2 }),
        model: fc.string()
      }),
      async (request) => {
        const mockResponse: LLMResponse = {
          content: [{ type: "text", text: "response" }],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
          costUsd: 0.001
        }
        const provider = new MockProvider([mockResponse])
        
        const response = await provider.chat(request as LLMRequest)
        expect(response).toHaveProperty("content")
        expect(Array.isArray(response.content)).toBe(true)
        expect(response).toHaveProperty("stopReason")
        expect(["end_turn", "tool_use", "max_tokens"]).toContain(response.stopReason)
        expect(response).toHaveProperty("usage")
        expect(typeof response.usage.inputTokens).toBe("number")
        expect(typeof response.usage.outputTokens).toBe("number")
        expect(typeof response.costUsd).toBe("number")
      }
    ))
  })
})

describe("Feature: Type contract validation", () => {
  it("should validate LLMContentBlock structure", () => {
    const textBlock: LLMContentBlock = { type: "text", text: "hello" }
    const toolUseBlock: LLMContentBlock = { 
      type: "tool_use", 
      toolName: "test", 
      toolInput: { param: "value" },
      toolUseId: "123"
    }
    const toolResultBlock: LLMContentBlock = { 
      type: "tool_result", 
      toolUseId: "123",
      text: "result"
    }
    
    expect(textBlock.type).toBe("text")
    expect(toolUseBlock.type).toBe("tool_use")
    expect(toolResultBlock.type).toBe("tool_result")
  })

  it("should validate LLMTool structure", () => {
    const tool: LLMTool = {
      name: "test_tool",
      description: "A test tool",
      inputSchema: { type: "object", properties: {} }
    }
    
    expect(typeof tool.name).toBe("string")
    expect(typeof tool.description).toBe("string")
    expect(typeof tool.inputSchema).toBe("object")
  })

  it("should validate LLMResponse structure", () => {
    const response: LLMResponse = {
      content: [{ type: "text", text: "response" }],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
      costUsd: 0.001
    }
    
    expect(Array.isArray(response.content)).toBe(true)
    expect(["end_turn", "tool_use", "max_tokens"]).toContain(response.stopReason)
    expect(typeof response.usage.inputTokens).toBe("number")
    expect(typeof response.usage.outputTokens).toBe("number")
    expect(typeof response.costUsd).toBe("number")
  })
})
```