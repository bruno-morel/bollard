import { describe, expect, it, vi } from "vitest"
import { _generateTempRunId, _slugify, createContext } from "../src/context.js"
import type { BollardConfig } from "../src/context.js"

const TEST_CONFIG: BollardConfig = {
  llm: { default: { provider: "mock", model: "test-model" } },
  agent: { max_cost_usd: 5.0, max_duration_minutes: 10 },
}

describe("createContext", () => {
  it("creates context with correct task, blueprintId, and config", () => {
    const ctx = createContext("do something", "bp-123", TEST_CONFIG)
    expect(ctx.task).toBe("do something")
    expect(ctx.blueprintId).toBe("bp-123")
    expect(ctx.config).toBe(TEST_CONFIG)
  })

  it("initializes with empty results and changedFiles", () => {
    const ctx = createContext("task", "bp", TEST_CONFIG)
    expect(ctx.results).toEqual({})
    expect(ctx.changedFiles).toEqual([])
  })

  it("starts without rollbackSha and can record branch creation SHA", () => {
    const ctx = createContext("task", "bp", TEST_CONFIG)
    expect(ctx.rollbackSha).toBeUndefined()
    ctx.rollbackSha = "deadbeefcafebabe"
    expect(ctx.rollbackSha).toBe("deadbeefcafebabe")
  })

  it("creates a CostTracker with the configured limit", () => {
    const ctx = createContext("task", "bp", TEST_CONFIG)
    expect(ctx.costTracker.remaining()).toBe(5.0)
    expect(ctx.costTracker.exceeded()).toBe(false)
  })

  it("records startedAt timestamp", () => {
    const before = Date.now()
    const ctx = createContext("task", "bp", TEST_CONFIG)
    const after = Date.now()
    expect(ctx.startedAt).toBeGreaterThanOrEqual(before)
    expect(ctx.startedAt).toBeLessThanOrEqual(after)
  })
})

describe("run ID generation", () => {
  it("generates a temp run ID matching the expected pattern", () => {
    const id = _generateTempRunId()
    expect(id).toMatch(/^\d{8}-\d{4}-run-[0-9a-f]{6}$/)
  })

  it("generates unique IDs on successive calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => _generateTempRunId()))
    expect(ids.size).toBe(50)
  })
})

describe("upgradeRunId", () => {
  it("upgrades the run ID to include blueprint prefix and task slug", () => {
    const ctx = createContext("Say hello world", "demo-blueprint", TEST_CONFIG)
    const oldId = ctx.runId
    ctx.upgradeRunId("Say hello world")
    expect(ctx.runId).not.toBe(oldId)
    expect(ctx.runId).toMatch(/^\d{8}-\d{4}-demo-blu-say-hello-world-[0-9a-f]{6}$/)
  })

  it("slugifies special characters and truncates long slugs", () => {
    const ctx = createContext("task", "bp", TEST_CONFIG)
    ctx.upgradeRunId("This!! Is a very long task name that should be truncated")
    expect(ctx.runId).toContain("this-is-a-very-long-task-name-")
  })
})

describe("slugify", () => {
  it("lowercases and replaces non-alphanum with hyphens", () => {
    expect(_slugify("Hello World!")).toBe("hello-world")
  })

  it("strips leading and trailing hyphens", () => {
    expect(_slugify("--hello--")).toBe("hello")
  })

  it("truncates to 30 characters", () => {
    const long = "a".repeat(50)
    expect(_slugify(long).length).toBeLessThanOrEqual(30)
  })
})

describe("structured logger", () => {
  it("writes info/debug to stdout as JSON", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const ctx = createContext("task", "bp", TEST_CONFIG)

    ctx.log.info("hello", { key: "value" })

    expect(writeSpy).toHaveBeenCalledOnce()
    const output = writeSpy.mock.calls[0]?.[0] as string
    const parsed = JSON.parse(output.trim()) as Record<string, unknown>
    expect(parsed["level"]).toBe("info")
    expect(parsed["message"]).toBe("hello")
    expect(parsed["runId"]).toBe(ctx.runId)
    expect(parsed["data"]).toEqual({ key: "value" })
    expect(parsed["timestamp"]).toBeDefined()

    writeSpy.mockRestore()
  })

  it("writes warn/error to stderr as JSON", () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const ctx = createContext("task", "bp", TEST_CONFIG)

    ctx.log.error("boom")

    expect(writeSpy).toHaveBeenCalledOnce()
    const output = writeSpy.mock.calls[0]?.[0] as string
    const parsed = JSON.parse(output.trim()) as Record<string, unknown>
    expect(parsed["level"]).toBe("error")
    expect(parsed["message"]).toBe("boom")

    writeSpy.mockRestore()
  })

  it("includes currentNode in log entries when set", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const ctx = createContext("task", "bp", TEST_CONFIG)
    ctx.currentNode = "node-1"

    ctx.log.info("step")

    const output = writeSpy.mock.calls[0]?.[0] as string
    const parsed = JSON.parse(output.trim()) as Record<string, unknown>
    expect(parsed["node"]).toBe("node-1")

    writeSpy.mockRestore()
  })
})
