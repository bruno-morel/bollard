import { describe, it, expect, beforeEach } from "vitest"
import * as fc from "fast-check"
import { createContext, _slugify, _generateTempRunId } from "../src/context.js"
import type { BollardConfig, PipelineContext, LogLevel } from "../src/context.js"

describe("Feature: createContext creates valid PipelineContext", () => {
  const validConfig: BollardConfig = {
    llm: {
      default: { provider: "openai", model: "gpt-4" }
    },
    agent: {
      max_cost_usd: 10.0,
      max_duration_minutes: 30
    }
  }

  it("should create context with required fields populated", () => {
    const ctx = createContext("test task", "blueprint-1", validConfig)
    
    expect(typeof ctx.runId).toBe("string")
    expect(ctx.runId.length).toBeGreaterThan(0)
    expect(ctx.task).toBe("test task")
    expect(ctx.blueprintId).toBe("blueprint-1")
    expect(ctx.config).toEqual(validConfig)
    expect(ctx.results).toEqual({})
    expect(ctx.changedFiles).toEqual([])
    expect(typeof ctx.startedAt).toBe("number")
    expect(ctx.startedAt).toBeGreaterThan(0)
  })

  it("should create unique runIds for different contexts", () => {
    const ctx1 = createContext("task1", "bp1", validConfig)
    const ctx2 = createContext("task2", "bp2", validConfig)
    
    expect(ctx1.runId).not.toBe(ctx2.runId)
  })

  it("should create cost tracker instance", () => {
    const ctx = createContext("test", "bp", validConfig)
    
    expect(ctx.costTracker).toBeDefined()
    expect(typeof ctx.costTracker.add).toBe("function")
    expect(typeof ctx.costTracker.total).toBe("function")
  })

  it("should create log methods that accept message and optional data", () => {
    const ctx = createContext("test", "bp", validConfig)
    
    expect(typeof ctx.log.debug).toBe("function")
    expect(typeof ctx.log.info).toBe("function")
    expect(typeof ctx.log.warn).toBe("function")
    expect(typeof ctx.log.error).toBe("function")
    
    // Should not throw when called
    expect(() => ctx.log.info("test message")).not.toThrow()
    expect(() => ctx.log.debug("test", { key: "value" })).not.toThrow()
  })

  it("should create upgradeRunId function", () => {
    const ctx = createContext("test", "bp", validConfig)
    
    expect(typeof ctx.upgradeRunId).toBe("function")
    expect(() => ctx.upgradeRunId("new-task")).not.toThrow()
  })
})

describe("Feature: createContext handles edge case inputs", () => {
  const validConfig: BollardConfig = {
    llm: {
      default: { provider: "openai", model: "gpt-4" }
    },
    agent: {
      max_cost_usd: 1.0,
      max_duration_minutes: 5
    }
  }

  it("should handle empty string task", () => {
    const ctx = createContext("", "bp", validConfig)
    expect(ctx.task).toBe("")
  })

  it("should handle empty string blueprintId", () => {
    const ctx = createContext("task", "", validConfig)
    expect(ctx.blueprintId).toBe("")
  })

  it("should handle config with agents map", () => {
    const configWithAgents: BollardConfig = {
      llm: {
        default: { provider: "openai", model: "gpt-4" },
        agents: {
          "agent1": { provider: "anthropic", model: "claude-3" },
          "agent2": { provider: "openai", model: "gpt-3.5-turbo" }
        }
      },
      agent: {
        max_cost_usd: 5.0,
        max_duration_minutes: 15
      }
    }
    
    const ctx = createContext("task", "bp", configWithAgents)
    expect(ctx.config.llm.agents).toEqual(configWithAgents.llm.agents)
  })

  it("should handle zero cost and duration limits", () => {
    const zeroConfig: BollardConfig = {
      llm: {
        default: { provider: "test", model: "test" }
      },
      agent: {
        max_cost_usd: 0,
        max_duration_minutes: 0
      }
    }
    
    const ctx = createContext("task", "bp", zeroConfig)
    expect(ctx.config.agent.max_cost_usd).toBe(0)
    expect(ctx.config.agent.max_duration_minutes).toBe(0)
  })
})

describe("Feature: createContext property-based tests", () => {
  const configArb = fc.record({
    llm: fc.record({
      default: fc.record({
        provider: fc.string({ minLength: 1 }),
        model: fc.string({ minLength: 1 })
      }),
      agents: fc.option(fc.dictionary(
        fc.string({ minLength: 1 }),
        fc.record({
          provider: fc.string({ minLength: 1 }),
          model: fc.string({ minLength: 1 })
        })
      ))
    }),
    agent: fc.record({
      max_cost_usd: fc.double({ min: 0, max: 1000, noNaN: true }),
      max_duration_minutes: fc.integer({ min: 0, max: 10000 }),
    }),
  })

  it("should preserve input task and blueprintId exactly", () => {
    fc.assert(fc.property(
      fc.string(),
      fc.string(),
      configArb,
      (task, blueprintId, config) => {
        const ctx = createContext(task, blueprintId, config)
        return ctx.task === task && ctx.blueprintId === blueprintId
      }
    ))
  })

  it("should always create non-empty runId", () => {
    fc.assert(fc.property(
      fc.string(),
      fc.string(),
      configArb,
      (task, blueprintId, config) => {
        const ctx = createContext(task, blueprintId, config)
        return typeof ctx.runId === "string" && ctx.runId.length > 0
      }
    ))
  })

  it("should preserve config structure exactly", () => {
    fc.assert(fc.property(
      fc.string(),
      fc.string(),
      configArb,
      (task, blueprintId, config) => {
        const ctx = createContext(task, blueprintId, config)
        return JSON.stringify(ctx.config) === JSON.stringify(config)
      }
    ))
  })

  it("should always initialize collections as empty", () => {
    fc.assert(fc.property(
      fc.string(),
      fc.string(),
      configArb,
      (task, blueprintId, config) => {
        const ctx = createContext(task, blueprintId, config)
        return Array.isArray(ctx.changedFiles) && 
               ctx.changedFiles.length === 0 &&
               typeof ctx.results === "object" &&
               Object.keys(ctx.results).length === 0
      }
    ))
  })
})

describe("Feature: _slugify transforms strings", () => {
  it("should convert string to lowercase slug format", () => {
    const result = _slugify("Test String")
    expect(typeof result).toBe("string")
    expect(result).toMatch(/^[a-z0-9-]+$/)
  })

  it("should handle empty string", () => {
    const result = _slugify("")
    expect(typeof result).toBe("string")
  })

  it("should handle special characters", () => {
    const result = _slugify("Test@#$%String!")
    expect(typeof result).toBe("string")
    expect(result).toMatch(/^[a-z0-9-]*$/)
  })

  it("should be deterministic", () => {
    const input = "Same Input String"
    const result1 = _slugify(input)
    const result2 = _slugify(input)
    expect(result1).toBe(result2)
  })
})

describe("Feature: _slugify property-based tests", () => {
  it("should always return string", () => {
    fc.assert(fc.property(
      fc.string(),
      (input) => {
        const result = _slugify(input)
        return typeof result === "string"
      }
    ))
  })

  it("should be deterministic for same input", () => {
    fc.assert(fc.property(
      fc.string(),
      (input) => {
        const result1 = _slugify(input)
        const result2 = _slugify(input)
        return result1 === result2
      }
    ))
  })
})

describe("Feature: _generateTempRunId creates temporary identifiers", () => {
  it("should generate string identifier", () => {
    const result = _generateTempRunId()
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })

  it("should generate unique identifiers", () => {
    const id1 = _generateTempRunId()
    const id2 = _generateTempRunId()
    expect(id1).not.toBe(id2)
  })

  it("should generate multiple unique identifiers", () => {
    const ids = Array.from({ length: 100 }, () => _generateTempRunId())
    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBe(100)
  })
})

describe("Feature: Context log methods produce structured output", () => {
  it("should log methods accept data parameter", () => {
    const ctx = createContext("test", "bp", {
      llm: { default: { provider: "test", model: "test" } },
      agent: { max_cost_usd: 1, max_duration_minutes: 1 }
    })

    const testData = { key: "value", number: 42, nested: { prop: true } }
    
    expect(() => ctx.log.debug("debug msg", testData)).not.toThrow()
    expect(() => ctx.log.info("info msg", testData)).not.toThrow()
    expect(() => ctx.log.warn("warn msg", testData)).not.toThrow()
    expect(() => ctx.log.error("error msg", testData)).not.toThrow()
  })

  it("should log methods work without data parameter", () => {
    const ctx = createContext("test", "bp", {
      llm: { default: { provider: "test", model: "test" } },
      agent: { max_cost_usd: 1, max_duration_minutes: 1 }
    })

    expect(() => ctx.log.debug("debug only")).not.toThrow()
    expect(() => ctx.log.info("info only")).not.toThrow()
    expect(() => ctx.log.warn("warn only")).not.toThrow()
    expect(() => ctx.log.error("error only")).not.toThrow()
  })
})

describe("Feature: Context upgradeRunId modifies context state", () => {
  it("should accept task slug parameter", () => {
    const ctx = createContext("original", "bp", {
      llm: { default: { provider: "test", model: "test" } },
      agent: { max_cost_usd: 1, max_duration_minutes: 1 }
    })

    expect(() => ctx.upgradeRunId("new-task-slug")).not.toThrow()
  })

  it("should handle empty task slug", () => {
    const ctx = createContext("original", "bp", {
      llm: { default: { provider: "test", model: "test" } },
      agent: { max_cost_usd: 1, max_duration_minutes: 1 }
    })

    expect(() => ctx.upgradeRunId("")).not.toThrow()
  })

  it("should handle special characters in task slug", () => {
    const ctx = createContext("original", "bp", {
      llm: { default: { provider: "test", model: "test" } },
      agent: { max_cost_usd: 1, max_duration_minutes: 1 }
    })

    expect(() => ctx.upgradeRunId("task-with-special@#$chars")).not.toThrow()
  })
})