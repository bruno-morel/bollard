```typescript
import { describe, it, expect, vi } from "vitest"
import * as fc from "fast-check"
import {
  createContext,
  CostTracker,
  BollardError,
  runBlueprint,
  runEvals,
  type BollardConfig,
  type Blueprint,
  type BlueprintNode,
  type NodeResult,
  type PipelineContext,
  type EvalCase,
  type EvalProvider,
  type EvalOptions,
  type EvalResponse,
  type BollardErrorCode,
  type NodeType,
  type ProbeAssertion,
  type EvalAssertion,
  type EvalAssertionType,
} from "../src/types.js"

describe("Feature: Public API exercises all core functionality", () => {
  const validConfig: BollardConfig = {
    llm: {
      default: { provider: "openai", model: "gpt-4" },
      agents: { "test-agent": { provider: "anthropic", model: "claude-3" } }
    },
    agent: {
      max_cost_usd: 10.0,
      max_duration_minutes: 30
    }
  }

  const validBlueprint: Blueprint = {
    id: "test-blueprint",
    name: "Test Blueprint",
    nodes: [],
    maxCostUsd: 5.0,
    maxDurationMinutes: 15
  }

  it("should create context with valid inputs", () => {
    const ctx = createContext("test task", "blueprint-1", validConfig)
    expect(ctx.task).toBe("test task")
    expect(ctx.blueprintId).toBe("blueprint-1")
    expect(ctx.config).toEqual(validConfig)
    expect(ctx.runId).toBeDefined()
    expect(ctx.results).toEqual({})
    expect(ctx.changedFiles).toEqual([])
    expect(ctx.costTracker).toBeInstanceOf(CostTracker)
    expect(typeof ctx.log.debug).toBe("function")
    expect(typeof ctx.log.info).toBe("function")
    expect(typeof ctx.log.warn).toBe("function")
    expect(typeof ctx.log.error).toBe("function")
    expect(typeof ctx.upgradeRunId).toBe("function")
    expect(typeof ctx.startedAt).toBe("number")
  })

  it("should run blueprint with minimal valid inputs", async () => {
    const result = await runBlueprint(validBlueprint, "test task", validConfig)
    expect(result.status).toMatch(/^(success|failure|handed_to_human)$/)
    expect(typeof result.runId).toBe("string")
    expect(typeof result.totalCostUsd).toBe("number")
    expect(typeof result.totalDurationMs).toBe("number")
    expect(typeof result.nodeResults).toBe("object")
  })
})

describe("Feature: Negative and boundary cases", () => {
  it("should handle empty task string", () => {
    const ctx = createContext("", "blueprint-1", validConfig)
    expect(ctx.task).toBe("")
  })

  it("should handle empty blueprint ID", () => {
    const ctx = createContext("task", "", validConfig)
    expect(ctx.blueprintId).toBe("")
  })

  it("should handle blueprint with empty nodes array", async () => {
    const emptyBlueprint: Blueprint = {
      id: "empty",
      name: "Empty Blueprint",
      nodes: [],
      maxCostUsd: 1.0,
      maxDurationMinutes: 1
    }
    const result = await runBlueprint(emptyBlueprint, "task", validConfig)
    expect(result.status).toMatch(/^(success|failure|handed_to_human)$/)
  })

  it("should handle zero cost limits", () => {
    const tracker = new CostTracker(0)
    expect(tracker.total()).toBe(0)
    expect(tracker.exceeded()).toBe(false)
    expect(tracker.remaining()).toBe(0)
  })

  it("should handle negative cost limits", () => {
    const tracker = new CostTracker(-1)
    expect(tracker.total()).toBe(0)
    expect(tracker.remaining()).toBe(-1)
  })

  it("should handle maximum safe integer cost", () => {
    const tracker = new CostTracker(Number.MAX_SAFE_INTEGER)
    expect(tracker.remaining()).toBe(Number.MAX_SAFE_INTEGER)
  })

  it("should handle adding zero cost", () => {
    const tracker = new CostTracker(10)
    tracker.add(0)
    expect(tracker.total()).toBe(0)
    expect(tracker.exceeded()).toBe(false)
  })

  it("should handle adding negative cost", () => {
    const tracker = new CostTracker(10)
    tracker.add(-5)
    expect(tracker.total()).toBe(-5)
  })

  it("should detect cost exceeded", () => {
    const tracker = new CostTracker(5)
    tracker.add(10)
    expect(tracker.exceeded()).toBe(true)
    expect(tracker.remaining()).toBe(-5)
  })

  it("should handle empty eval cases array", async () => {
    const mockProvider: EvalProvider = {
      chat: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "response" }],
        usage: { inputTokens: 10, outputTokens: 20 },
        costUsd: 0.01
      })
    }
    const options: EvalOptions = { model: "gpt-4" }
    const results = await runEvals([], mockProvider, options)
    expect(results).toEqual([])
  })

  it("should handle BollardError with minimal options", () => {
    const error = new BollardError({ code: "LLM_TIMEOUT", message: "timeout" })
    expect(error.code).toBe("LLM_TIMEOUT")
    expect(error.message).toBe("timeout")
    expect(error.context).toEqual({})
    expect(typeof error.retryable).toBe("boolean")
  })

  it("should identify BollardError instances", () => {
    const error = new BollardError({ code: "LLM_TIMEOUT", message: "test" })
    const regularError = new Error("regular")
    
    expect(BollardError.is(error)).toBe(true)
    expect(BollardError.is(regularError)).toBe(false)
    expect(BollardError.is(null)).toBe(false)
    expect(BollardError.is(undefined)).toBe(false)
    expect(BollardError.is("string")).toBe(false)
  })

  it("should check error codes correctly", () => {
    const error = new BollardError({ code: "LLM_TIMEOUT", message: "test" })
    
    expect(BollardError.hasCode(error, "LLM_TIMEOUT")).toBe(true)
    expect(BollardError.hasCode(error, "LLM_RATE_LIMIT")).toBe(false)
    expect(BollardError.hasCode(new Error("regular"), "LLM_TIMEOUT")).toBe(false)
    expect(BollardError.hasCode(null, "LLM_TIMEOUT")).toBe(false)
  })
})

describe("Feature: Property-based tests for core functions", () => {
  it("should maintain cost tracking invariants", () => {
    fc.assert(fc.property(
      fc.float({ min: 0, max: 1000 }),
      fc.array(fc.float({ min: 0, max: 100 }), { maxLength: 20 }),
      (limit, costs) => {
        const tracker = new CostTracker(limit)
        let expectedTotal = 0
        
        for (const cost of costs) {
          tracker.add(cost)
          expectedTotal += cost
        }
        
        expect(tracker.total()).toBeCloseTo(expectedTotal, 10)
        expect(tracker.exceeded()).toBe(expectedTotal > limit)
        expect(tracker.remaining()).toBeCloseTo(limit - expectedTotal, 10)
      }
    ))
  })

  it("should handle arbitrary valid node types", () => {
    fc.assert(fc.property(
      fc.constantFrom("deterministic", "agentic", "risk_gate", "human_gate"),
      fc.string({ minLength: 1 }),
      fc.string({ minLength: 1 }),
      (nodeType: NodeType, id, name) => {
        const node: BlueprintNode = {
          id,
          name,
          type: nodeType
        }
        expect(node.type).toBe(nodeType)
        expect(node.id).toBe(id)
        expect(node.name).toBe(name)
      }
    ))
  })

  it("should handle arbitrary valid probe assertion types", () => {
    fc.assert(fc.property(
      fc.constantFrom(
        "status",
        "latency",
        "json_field",
        "body_contains",
        "body_matches",
        "header",
      ),
      fc.anything(),
      (assertionType, expected) => {
        const assertion: ProbeAssertion = {
          type: assertionType,
          expected
        }
        expect(assertion.type).toBe(assertionType)
        expect(assertion.expected).toBe(expected)
      }
    ))
  })

  it("should handle arbitrary valid eval assertion types", () => {
    fc.assert(fc.property(
      fc.constantFrom("contains", "not_contains", "json_field", "max_tokens", "max_cost", "matches_regex"),
      fc.oneof(fc.string(), fc.integer()),
      (assertionType: EvalAssertionType, value) => {
        const assertion: EvalAssertion = {
          type: assertionType,
          value
        }
        expect(assertion.type).toBe(assertionType)
        expect(assertion.value).toBe(value)
      }
    ))
  })

  it("should handle arbitrary valid error codes", () => {
    fc.assert(fc.property(
      fc.constantFrom(
        "LLM_TIMEOUT", "LLM_RATE_LIMIT", "LLM_AUTH", "LLM_PROVIDER_ERROR",
        "LLM_INVALID_RESPONSE", "COST_LIMIT_EXCEEDED", "TIME_LIMIT_EXCEEDED",
        "NODE_EXECUTION_FAILED", "POSTCONDITION_FAILED", "STATIC_CHECK_FAILED",
        "TEST_FAILED", "MUTATION_THRESHOLD_NOT_MET", "CONTRACT_VIOLATION",
        "HUMAN_REJECTED", "RISK_GATE_BLOCKED", "CONFIG_INVALID",
        "DETECTION_FAILED", "PROFILE_INVALID", "PROVIDER_NOT_FOUND",
        "MODEL_NOT_AVAILABLE"
      ),
      fc.string({ minLength: 1 }),
      (code: BollardErrorCode, message) => {
        const error = new BollardError({ code, message })
        expect(error.code).toBe(code)
        expect(error.message).toBe(message)
        expect(BollardError.hasCode(error, code)).toBe(true)
      }
    ))
  })

  it("should create contexts with arbitrary valid configs", () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1 }),
      fc.string({ minLength: 1 }),
      fc.string({ minLength: 1 }),
      fc.string({ minLength: 1 }),
      fc.float({ min: 0.01, max: 1000 }),
      fc.integer({ min: 1, max: 1440 }),
      (task, blueprintId, provider, model, maxCost, maxDuration) => {
        const config: BollardConfig = {
          llm: {
            default: { provider, model }
          },
          agent: {
            max_cost_usd: maxCost,
            max_duration_minutes: maxDuration
          }
        }
        
        const ctx = createContext(task, blueprintId, config)
        expect(ctx.task).toBe(task)
        expect(ctx.blueprintId).toBe(blueprintId)
        expect(ctx.config.llm.default.provider).toBe(provider)
        expect(ctx.config.llm.default.model).toBe(model)
        expect(ctx.config.agent.max_cost_usd).toBe(maxCost)
        expect(ctx.config.agent.max_duration_minutes).toBe(maxDuration)
      }
    ))
  })
})

describe("Feature: Complex object validation", () => {
  it("should handle node result with all optional fields", () => {
    const result: NodeResult = {
      status: "ok",
      data: { key: "value" },
      cost_usd: 1.5,
      duration_ms: 1000,
      error: { code: "TEST_ERROR", message: "test error" },
      probes: [{
        id: "probe-1",
        name: "Test Probe",
        endpoint: "https://api.test.com",
        method: "GET",
        assertions: [{ type: "status", expected: 200 }],
        intervalSeconds: 60
      }]
    }
    
    expect(result.status).toBe("ok")
    expect(result.data).toEqual({ key: "value" })
    expect(result.cost_usd).toBe(1.5)
    expect(result.duration_ms).toBe(1000)
    expect(result.error?.code).toBe("TEST_ERROR")
    expect(result.probes?.[0]?.id).toBe("probe-1")
  })

  it("should handle blueprint node with all optional fields", () => {
    const mockExecute = vi.fn().mockResolvedValue({ status: "ok" } as NodeResult)
    const mockPostcondition = vi.fn().mockReturnValue(true)
    
    const node: BlueprintNode = {
      id: "node-1",
      name: "Test Node",
      type: "deterministic",
      execute: mockExecute,
      agent: "test-agent",
      postconditions: [mockPostcondition],
      onFailure: "retry",
      maxRetries: 3
    }
    
    expect(node.id).toBe("node-1")
    expect(node.name).toBe("Test Node")
    expect(node.type).toBe("deterministic")
    expect(node.execute).toBe(mockExecute)
    expect(node.agent).toBe("test-agent")
    expect(node.postconditions?.[0]).toBe(mockPostcondition)
    expect(node.onFailure).toBe("retry")
    expect(node.maxRetries).toBe(3)
  })

  it("should handle eval case with all optional fields", () => {
    const evalCase: EvalCase = {
      id: "case-1",
      description: "Test case",
      systemPrompt: "You are a test assistant",
      messages: [{ role: "user", content: "Hello" }],
      assertions: [{ type: "contains", value: "hello" }],
      tools: [{
        name: "test_tool",
        description: "A test tool",
        inputSchema: { type: "object", properties: {} }
      }],
      model: "gpt-4",
      temperature: 0.7
    }
    
    expect(evalCase.id).toBe("case-1")
    expect(evalCase.tools?.[0]?.name).toBe("test_tool")
    expect(evalCase.model).toBe("gpt-4")
    expect(evalCase.temperature).toBe(0.7)
  })
})
```