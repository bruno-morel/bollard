import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import { runEvals, EvalCase, EvalProvider, EvalOptions, EvalRunResult } from "../src/eval-runner.js"

describe("Feature: All exported functions have behavioral tests", () => {
  const mockProvider: EvalProvider = {
    async chat(request) {
      return {
        content: [{ type: "text", text: "Mock response" }],
        usage: { inputTokens: 10, outputTokens: 20 },
        costUsd: 0.001
      }
    }
  }

  const basicCase: EvalCase = {
    id: "test-case-1",
    description: "Basic test case",
    systemPrompt: "You are a helpful assistant",
    messages: [{ role: "user", content: "Hello" }],
    assertions: [{ type: "contains", value: "Mock" }]
  }

  const basicOptions: EvalOptions = {
    model: "gpt-4",
    runs: 1
  }

  it("should return results array with same length as input cases", async () => {
    const cases = [basicCase]
    const results = await runEvals(cases, mockProvider, basicOptions)
    
    expect(results).toHaveLength(1)
    expect(results[0].caseId).toBe("test-case-1")
  })

  it("should execute specified number of runs per case", async () => {
    const options = { ...basicOptions, runs: 3 }
    const results = await runEvals([basicCase], mockProvider, options)
    
    expect(results[0].runs).toBe(3)
    expect(results[0].details).toHaveLength(3)
  })

  it("should calculate pass rate correctly", async () => {
    const passingCase: EvalCase = {
      ...basicCase,
      assertions: [{ type: "contains", value: "Mock" }]
    }
    
    const results = await runEvals([passingCase], mockProvider, { ...basicOptions, runs: 2 })
    
    expect(results[0].passRate).toBe(1.0)
    expect(results[0].passed).toBe(2)
    expect(results[0].ok).toBe(true)
  })
})

describe("Feature: Property-based tests for collection parameters", () => {
  const mockProvider: EvalProvider = {
    async chat() {
      return {
        content: [{ type: "text", text: "Response" }],
        usage: { inputTokens: 5, outputTokens: 10 },
        costUsd: 0.0005
      }
    }
  }

  it("should handle arbitrary number of cases", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({
        id: fc.string({ minLength: 1 }),
        description: fc.string(),
        systemPrompt: fc.string(),
        messages: fc.array(fc.record({
          role: fc.constantFrom("user", "assistant"),
          content: fc.string()
        }), { minLength: 1 }),
        assertions: fc.array(fc.record({
          type: fc.constantFrom("contains", "not_contains", "json_field", "max_tokens", "max_cost", "matches_regex"),
          value: fc.oneof(fc.string(), fc.integer({ min: 0 }))
        }), { minLength: 1 })
      }), { minLength: 1, maxLength: 5 }),
      async (cases) => {
        const options = { model: "test-model", runs: 1 }
        const results = await runEvals(cases, mockProvider, options)
        
        expect(results).toHaveLength(cases.length)
        results.forEach((result, i) => {
          expect(result.caseId).toBe(cases[i].id)
          expect(result.runs).toBe(1)
          expect(typeof result.passRate).toBe("number")
          expect(result.passRate).toBeGreaterThanOrEqual(0)
          expect(result.passRate).toBeLessThanOrEqual(1)
        })
      }
    ))
  })

  it("should handle arbitrary run counts", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 10 }),
      async (runCount) => {
        const case1: EvalCase = {
          id: "prop-test",
          description: "Property test case",
          systemPrompt: "Test",
          messages: [{ role: "user", content: "Test" }],
          assertions: [{ type: "contains", value: "Response" }]
        }
        
        const options = { model: "test-model", runs: runCount }
        const results = await runEvals([case1], mockProvider, options)
        
        expect(results[0].runs).toBe(runCount)
        expect(results[0].details).toHaveLength(runCount)
        expect(results[0].passed).toBeGreaterThanOrEqual(0)
        expect(results[0].passed).toBeLessThanOrEqual(runCount)
      }
    ))
  })
})

describe("Feature: Negative tests for error conditions", () => {
  const mockProvider: EvalProvider = {
    async chat() {
      return {
        content: [{ type: "text", text: "Test response" }],
        usage: { inputTokens: 1, outputTokens: 1 },
        costUsd: 0.001
      }
    }
  }

  it("should handle empty cases array", async () => {
    const options = { model: "test-model", runs: 1 }
    const results = await runEvals([], mockProvider, options)
    
    expect(results).toHaveLength(0)
  })

  it("should handle cases with empty messages array", async () => {
    const caseWithNoMessages: EvalCase = {
      id: "empty-messages",
      description: "Case with no messages",
      systemPrompt: "System",
      messages: [],
      assertions: [{ type: "contains", value: "anything" }]
    }
    
    const options = { model: "test-model", runs: 1 }
    const results = await runEvals([caseWithNoMessages], mockProvider, options)
    
    expect(results).toHaveLength(1)
    expect(results[0].caseId).toBe("empty-messages")
  })

  it("should handle cases with empty assertions array", async () => {
    const caseWithNoAssertions: EvalCase = {
      id: "no-assertions",
      description: "Case with no assertions",
      systemPrompt: "System",
      messages: [{ role: "user", content: "Hello" }],
      assertions: []
    }
    
    const options = { model: "test-model", runs: 1 }
    const results = await runEvals([caseWithNoAssertions], mockProvider, options)
    
    expect(results).toHaveLength(1)
    expect(results[0].details[0].assertions).toHaveLength(0)
    expect(results[0].details[0].allPassed).toBe(true)
  })

  it("should handle zero runs option", async () => {
    const basicCase: EvalCase = {
      id: "zero-runs",
      description: "Test case",
      systemPrompt: "System",
      messages: [{ role: "user", content: "Hello" }],
      assertions: [{ type: "contains", value: "test" }]
    }
    
    const options = { model: "test-model", runs: 0 }
    const results = await runEvals([basicCase], mockProvider, options)
    
    expect(results[0].runs).toBe(0)
    expect(results[0].details).toHaveLength(0)
    expect(results[0].passed).toBe(0)
    expect(results[0].passRate).toBe(0)
  })

  it("should handle provider that returns empty content", async () => {
    const emptyProvider: EvalProvider = {
      async chat() {
        return {
          content: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          costUsd: 0
        }
      }
    }
    
    const basicCase: EvalCase = {
      id: "empty-content",
      description: "Test with empty content",
      systemPrompt: "System",
      messages: [{ role: "user", content: "Hello" }],
      assertions: [{ type: "contains", value: "anything" }]
    }
    
    const options = { model: "test-model", runs: 1 }
    const results = await runEvals([basicCase], emptyProvider, options)
    
    expect(results[0].details[0].assertions[0].passed).toBe(false)
  })
})

describe("Feature: Domain-specific assertion evaluation", () => {
  it("should evaluate contains assertions correctly", async () => {
    const containsProvider: EvalProvider = {
      async chat() {
        return {
          content: [{ type: "text", text: "The quick brown fox" }],
          usage: { inputTokens: 5, outputTokens: 4 },
          costUsd: 0.001
        }
      }
    }
    
    const testCase: EvalCase = {
      id: "contains-test",
      description: "Test contains assertion",
      systemPrompt: "System",
      messages: [{ role: "user", content: "Tell me about foxes" }],
      assertions: [
        { type: "contains", value: "fox", description: "Should mention fox" },
        { type: "not_contains", value: "elephant", description: "Should not mention elephant" }
      ]
    }
    
    const results = await runEvals([testCase], containsProvider, { model: "test", runs: 1 })
    
    expect(results[0].details[0].assertions[0].passed).toBe(true)
    expect(results[0].details[0].assertions[1].passed).toBe(true)
    expect(results[0].details[0].allPassed).toBe(true)
  })

  it("should evaluate max_tokens assertions correctly", async () => {
    const tokenProvider: EvalProvider = {
      async chat() {
        return {
          content: [{ type: "text", text: "Short response" }],
          usage: { inputTokens: 10, outputTokens: 50 },
          costUsd: 0.002
        }
      }
    }
    
    const testCase: EvalCase = {
      id: "token-test",
      description: "Test token limit",
      systemPrompt: "Be concise",
      messages: [{ role: "user", content: "Explain AI" }],
      assertions: [
        { type: "max_tokens", value: 100, description: "Should use under 100 tokens" },
        { type: "max_tokens", value: 30, description: "Should use under 30 tokens" }
      ]
    }
    
    const results = await runEvals([testCase], tokenProvider, { model: "test", runs: 1 })
    
    expect(results[0].details[0].assertions[0].passed).toBe(true)
    expect(results[0].details[0].assertions[1].passed).toBe(false)
    expect(results[0].details[0].allPassed).toBe(false)
  })

  it("should evaluate max_cost assertions correctly", async () => {
    const costProvider: EvalProvider = {
      async chat() {
        return {
          content: [{ type: "text", text: "Expensive response" }],
          usage: { inputTokens: 1000, outputTokens: 1000 },
          costUsd: 0.05
        }
      }
    }
    
    const testCase: EvalCase = {
      id: "cost-test",
      description: "Test cost limit",
      systemPrompt: "System",
      messages: [{ role: "user", content: "Generate a lot of text" }],
      assertions: [
        { type: "max_cost", value: 0.1, description: "Should cost under $0.10" },
        { type: "max_cost", value: 0.01, description: "Should cost under $0.01" }
      ]
    }
    
    const results = await runEvals([testCase], costProvider, { model: "test", runs: 1 })
    
    expect(results[0].details[0].assertions[0].passed).toBe(true)
    expect(results[0].details[0].assertions[1].passed).toBe(false)
  })

  it("should track cumulative costs across runs", async () => {
    const costProvider: EvalProvider = {
      async chat() {
        return {
          content: [{ type: "text", text: "Response" }],
          usage: { inputTokens: 10, outputTokens: 10 },
          costUsd: 0.01
        }
      }
    }
    
    const testCase: EvalCase = {
      id: "multi-run-cost",
      description: "Test multiple runs",
      systemPrompt: "System",
      messages: [{ role: "user", content: "Hello" }],
      assertions: [{ type: "contains", value: "Response" }]
    }
    
    const results = await runEvals([testCase], costProvider, { model: "test", runs: 3 })
    
    const totalCost = results[0].details.reduce((sum, detail) => sum + detail.costUsd, 0)
    expect(totalCost).toBe(0.03)
    results[0].details.forEach(detail => {
      expect(detail.costUsd).toBe(0.01)
    })
  })
})