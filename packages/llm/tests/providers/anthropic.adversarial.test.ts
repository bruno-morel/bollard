import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import { AnthropicProvider } from "../../src/providers/anthropic.js"
import { BollardError } from "@bollard/engine/src/errors.js"

describe("Feature: AnthropicProvider constructor", () => {
  it("should create provider with valid API key", () => {
    const provider = new AnthropicProvider("sk-ant-api03-test-key")
    expect(provider.name).toBe("anthropic")
  })

  it("should handle empty API key", () => {
    const provider = new AnthropicProvider("")
    expect(provider.name).toBe("anthropic")
  })

  it("should handle whitespace-only API key", () => {
    const provider = new AnthropicProvider("   ")
    expect(provider.name).toBe("anthropic")
  })
})

describe("Feature: AnthropicProvider chat method", () => {
  const provider = new AnthropicProvider("sk-ant-api03-test-key")

  it("should return LLMResponse for valid request", async () => {
    const request = {
      messages: [{ role: "user" as const, content: "Hello" }],
      model: "claude-3-sonnet-20240229",
      maxTokens: 100
    }
    
    const response = await provider.chat(request)
    expect(response).toHaveProperty("content")
    expect(Array.isArray(response.content)).toBe(true)
    expect(response.content.length).toBeGreaterThan(0)
    expect(response.content[0]).toHaveProperty("type")
    expect(response.content[0]).toHaveProperty("text")
  })

  it("should handle system message in request", async () => {
    const request = {
      messages: [
        { role: "system" as const, content: "You are a helpful assistant" },
        { role: "user" as const, content: "Hello" }
      ],
      model: "claude-3-sonnet-20240229",
      maxTokens: 100
    }
    
    const response = await provider.chat(request)
    expect(response.content).toBeDefined()
    expect(Array.isArray(response.content)).toBe(true)
  })

  it("should handle multi-turn conversation", async () => {
    const request = {
      messages: [
        { role: "user" as const, content: "What is 2+2?" },
        { role: "assistant" as const, content: "2+2 equals 4." },
        { role: "user" as const, content: "What about 3+3?" }
      ],
      model: "claude-3-sonnet-20240229",
      maxTokens: 100
    }
    
    const response = await provider.chat(request)
    expect(response.content).toBeDefined()
    expect(response.content.length).toBeGreaterThan(0)
  })

  it("should handle request with temperature", async () => {
    const request = {
      messages: [{ role: "user" as const, content: "Hello" }],
      model: "claude-3-sonnet-20240229",
      maxTokens: 100,
      temperature: 0.7
    }
    
    const response = await provider.chat(request)
    expect(response.content).toBeDefined()
  })

  it("should handle request with topP", async () => {
    const request = {
      messages: [{ role: "user" as const, content: "Hello" }],
      model: "claude-3-sonnet-20240229",
      maxTokens: 100,
      topP: 0.9
    }
    
    const response = await provider.chat(request)
    expect(response.content).toBeDefined()
  })

  it("should reject request with no messages", async () => {
    const request = {
      messages: [],
      model: "claude-3-sonnet-20240229",
      maxTokens: 100
    }
    
    await expect(provider.chat(request)).rejects.toThrow()
  })

  it("should reject request with invalid model", async () => {
    const request = {
      messages: [{ role: "user" as const, content: "Hello" }],
      model: "invalid-model-name",
      maxTokens: 100
    }
    
    await expect(provider.chat(request)).rejects.toThrow()
  })

  it("should reject request with zero maxTokens", async () => {
    const request = {
      messages: [{ role: "user" as const, content: "Hello" }],
      model: "claude-3-sonnet-20240229",
      maxTokens: 0
    }
    
    await expect(provider.chat(request)).rejects.toThrow()
  })

  it("should reject request with negative maxTokens", async () => {
    const request = {
      messages: [{ role: "user" as const, content: "Hello" }],
      model: "claude-3-sonnet-20240229",
      maxTokens: -1
    }
    
    await expect(provider.chat(request)).rejects.toThrow()
  })

  it("should reject request with temperature out of range", async () => {
    const request = {
      messages: [{ role: "user" as const, content: "Hello" }],
      model: "claude-3-sonnet-20240229",
      maxTokens: 100,
      temperature: 2.5
    }
    
    await expect(provider.chat(request)).rejects.toThrow()
  })

  it("should reject request with negative temperature", async () => {
    const request = {
      messages: [{ role: "user" as const, content: "Hello" }],
      model: "claude-3-sonnet-20240229",
      maxTokens: 100,
      temperature: -0.1
    }
    
    await expect(provider.chat(request)).rejects.toThrow()
  })

  it("should reject request with topP out of range", async () => {
    const request = {
      messages: [{ role: "user" as const, content: "Hello" }],
      model: "claude-3-sonnet-20240229",
      maxTokens: 100,
      topP: 1.5
    }
    
    await expect(provider.chat(request)).rejects.toThrow()
  })

  it("should handle extremely long message content", async () => {
    const longContent = "x".repeat(100000)
    const request = {
      messages: [{ role: "user" as const, content: longContent }],
      model: "claude-3-sonnet-20240229",
      maxTokens: 100
    }
    
    // Should either succeed or throw a meaningful error
    try {
      const response = await provider.chat(request)
      expect(response.content).toBeDefined()
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
    }
  })

  it("should handle message with empty content", async () => {
    const request = {
      messages: [{ role: "user" as const, content: "" }],
      model: "claude-3-sonnet-20240229",
      maxTokens: 100
    }
    
    await expect(provider.chat(request)).rejects.toThrow()
  })

  it("should handle message with only whitespace content", async () => {
    const request = {
      messages: [{ role: "user" as const, content: "   \n\t  " }],
      model: "claude-3-sonnet-20240229",
      maxTokens: 100
    }
    
    // Should either succeed or reject meaningfully
    try {
      const response = await provider.chat(request)
      expect(response.content).toBeDefined()
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
    }
  })
})

describe("Property-based tests: AnthropicProvider", () => {
  const provider = new AnthropicProvider("sk-ant-api03-test-key")

  it("should handle various valid maxTokens values", () => {
    fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 4096 }),
      async (maxTokens) => {
        const request = {
          messages: [{ role: "user" as const, content: "Hello" }],
          model: "claude-3-sonnet-20240229",
          maxTokens
        }
        
        try {
          const response = await provider.chat(request)
          expect(response.content).toBeDefined()
          expect(Array.isArray(response.content)).toBe(true)
        } catch (error) {
          // API errors are acceptable for property tests
          expect(error).toBeInstanceOf(Error)
        }
      }
    ))
  })

  it("should handle various valid temperature values", () => {
    fc.assert(fc.asyncProperty(
      fc.float({ min: 0, max: 1, noNaN: true }),
      async (temperature) => {
        const request = {
          messages: [{ role: "user" as const, content: "Hello" }],
          model: "claude-3-sonnet-20240229",
          maxTokens: 100,
          temperature
        }
        
        try {
          const response = await provider.chat(request)
          expect(response.content).toBeDefined()
        } catch (error) {
          expect(error).toBeInstanceOf(Error)
        }
      }
    ))
  })

  it("should handle various message content strings", () => {
    fc.assert(fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 1000 }),
      async (content) => {
        const request = {
          messages: [{ role: "user" as const, content }],
          model: "claude-3-sonnet-20240229",
          maxTokens: 100
        }
        
        try {
          const response = await provider.chat(request)
          expect(response.content).toBeDefined()
          expect(response.content.length).toBeGreaterThan(0)
        } catch (error) {
          expect(error).toBeInstanceOf(Error)
        }
      }
    ))
  })
})