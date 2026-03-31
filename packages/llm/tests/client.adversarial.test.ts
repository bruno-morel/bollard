import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import { LLMClient } from "../src/client.js"
import type { BollardConfig } from "@bollard/engine/src/context.js"
import type { LLMResponse } from "./types.js"

describe("Feature: LLMClient constructor", () => {
  it("should create instance with valid config", () => {
    const config: BollardConfig = {
      llm: {
        default: {
          provider: "anthropic",
          model: "claude-3-sonnet"
        }
      }
    }
    const client = new LLMClient(config)
    expect(client).toBeInstanceOf(LLMClient)
  })

  it("should create instance with mock responses", () => {
    const config: BollardConfig = {
      llm: {
        default: {
          provider: "mock",
          model: "test"
        }
      }
    }
    const mockResponses: LLMResponse[] = [
      { content: "test response", usage: { inputTokens: 10, outputTokens: 5 } }
    ]
    const client = new LLMClient(config, mockResponses)
    expect(client).toBeInstanceOf(LLMClient)
  })

  it("should handle empty mock responses array", () => {
    const config: BollardConfig = {
      llm: {
        default: {
          provider: "mock",
          model: "test"
        }
      }
    }
    const client = new LLMClient(config, [])
    expect(client).toBeInstanceOf(LLMClient)
  })
})

describe("Feature: forAgent method returns provider and model", () => {
  it("should return default provider and model for any agent role", () => {
    const config: BollardConfig = {
      llm: {
        default: {
          provider: "anthropic",
          model: "claude-3-sonnet"
        }
      }
    }
    const client = new LLMClient(config)
    const result = client.forAgent("test-agent")
    
    expect(result).toHaveProperty("provider")
    expect(result).toHaveProperty("model")
    expect(typeof result.model).toBe("string")
    expect(result.model).toBe("claude-3-sonnet")
  })

  it("should return consistent results for same agent role", () => {
    const config: BollardConfig = {
      llm: {
        default: {
          provider: "anthropic",
          model: "claude-3-haiku"
        }
      }
    }
    const client = new LLMClient(config)
    const result1 = client.forAgent("agent1")
    const result2 = client.forAgent("agent1")
    
    expect(result1.model).toBe(result2.model)
    expect(result1.provider).toBe(result2.provider)
  })

  it("should handle agent-specific configuration when available", () => {
    const config: BollardConfig = {
      llm: {
        default: {
          provider: "anthropic",
          model: "claude-3-sonnet"
        },
        agents: {
          "special-agent": {
            provider: "anthropic",
            model: "claude-3-opus"
          }
        }
      }
    }
    const client = new LLMClient(config)
    const result = client.forAgent("special-agent")
    
    expect(result.model).toBe("claude-3-opus")
  })
})

describe("Property-based tests: forAgent with arbitrary agent roles", () => {
  it("should always return valid provider and model structure", () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1, maxLength: 100 }),
      (agentRole) => {
        const config: BollardConfig = {
          llm: {
            default: {
              provider: "anthropic",
              model: "claude-3-sonnet"
            }
          }
        }
        const client = new LLMClient(config)
        const result = client.forAgent(agentRole)
        
        expect(result).toHaveProperty("provider")
        expect(result).toHaveProperty("model")
        expect(typeof result.model).toBe("string")
        expect(result.model.length).toBeGreaterThan(0)
      }
    ))
  })

  it("should handle unicode and special characters in agent roles", () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1 }).filter(s => s.trim().length > 0),
      (agentRole) => {
        const config: BollardConfig = {
          llm: {
            default: {
              provider: "mock",
              model: "test-model"
            }
          }
        }
        const client = new LLMClient(config)
        const result = client.forAgent(agentRole)
        
        expect(result.model).toBe("test-model")
        expect(result.provider).toBeDefined()
      }
    ))
  })
})

describe("Negative tests: error conditions", () => {
  it("should handle missing default configuration gracefully", () => {
    const config = {} as BollardConfig
    // ASSUMPTION: constructor may throw or handle gracefully
    expect(() => new LLMClient(config)).not.toThrow()
  })

  it("should handle null config", () => {
    // ASSUMPTION: may throw TypeError or handle gracefully
    expect(() => new LLMClient(null as any)).not.toThrow()
  })

  it("should handle empty string agent role", () => {
    const config: BollardConfig = {
      llm: {
        default: {
          provider: "anthropic",
          model: "claude-3-sonnet"
        }
      }
    }
    const client = new LLMClient(config)
    const result = client.forAgent("")
    
    expect(result).toHaveProperty("provider")
    expect(result).toHaveProperty("model")
  })

  it("should handle whitespace-only agent role", () => {
    const config: BollardConfig = {
      llm: {
        default: {
          provider: "anthropic",
          model: "claude-3-sonnet"
        }
      }
    }
    const client = new LLMClient(config)
    const result = client.forAgent("   ")
    
    expect(result).toHaveProperty("provider")
    expect(result).toHaveProperty("model")
  })

  it("should handle very long agent role names", () => {
    const config: BollardConfig = {
      llm: {
        default: {
          provider: "anthropic",
          model: "claude-3-sonnet"
        }
      }
    }
    const client = new LLMClient(config)
    const longRole = "a".repeat(10000)
    const result = client.forAgent(longRole)
    
    expect(result).toHaveProperty("provider")
    expect(result).toHaveProperty("model")
  })

  it("should handle malformed mock responses", () => {
    const config: BollardConfig = {
      llm: {
        default: {
          provider: "mock",
          model: "test"
        }
      }
    }
    const malformedResponses = [
      { content: null, usage: null } as any,
      { } as any,
      null as any
    ]
    
    expect(() => new LLMClient(config, malformedResponses)).not.toThrow()
  })
})

describe("Domain-specific behavior: LLM provider selection", () => {
  it("should respect provider hierarchy: agent-specific over default", () => {
    const config: BollardConfig = {
      llm: {
        default: {
          provider: "anthropic",
          model: "claude-3-sonnet"
        },
        agents: {
          "priority-agent": {
            provider: "anthropic",
            model: "claude-3-opus"
          }
        }
      }
    }
    const client = new LLMClient(config)
    
    const defaultResult = client.forAgent("unknown-agent")
    const specificResult = client.forAgent("priority-agent")
    
    expect(defaultResult.model).toBe("claude-3-sonnet")
    expect(specificResult.model).toBe("claude-3-opus")
    expect(specificResult.model).not.toBe(defaultResult.model)
  })

  it("should maintain provider consistency across multiple calls", () => {
    const config: BollardConfig = {
      llm: {
        default: {
          provider: "anthropic",
          model: "claude-3-sonnet"
        }
      }
    }
    const client = new LLMClient(config)
    
    const calls = Array.from({ length: 10 }, () => client.forAgent("consistent-agent"))
    const models = calls.map(result => result.model)
    const providers = calls.map(result => result.provider)
    
    expect(new Set(models).size).toBe(1)
    expect(models.every(model => model === "claude-3-sonnet")).toBe(true)
  })

  it("should handle mock provider configuration correctly", () => {
    const config: BollardConfig = {
      llm: {
        default: {
          provider: "mock",
          model: "mock-model"
        }
      }
    }
    const mockResponses: LLMResponse[] = [
      { content: "mocked response", usage: { inputTokens: 1, outputTokens: 1 } }
    ]
    const client = new LLMClient(config, mockResponses)
    const result = client.forAgent("test-agent")
    
    expect(result.model).toBe("mock-model")
  })
})