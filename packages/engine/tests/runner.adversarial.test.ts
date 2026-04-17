import { describe, it, expect, vi } from "vitest"
import * as fc from "fast-check"
import type { Blueprint, BlueprintNode } from "../src/blueprint.js"
import type { BollardConfig } from "../src/context.js"
import type { AgenticHandler, HumanGateHandler, ProgressCallback } from "../src/runner.js"
import { runBlueprint } from "../src/runner.js"

const TEST_CONFIG: BollardConfig = {
  llm: { default: { provider: "openai", model: "gpt-4" } },
  agent: { max_cost_usd: 10, max_duration_minutes: 30 },
}

function makeBlueprint(nodes: BlueprintNode[], overrides?: Partial<Blueprint>): Blueprint {
  return {
    id: "adv-bp",
    name: "adversarial-blueprint",
    nodes,
    maxCostUsd: 10,
    maxDurationMinutes: 30,
    ...overrides,
  }
}

function agenticNode(id: string, agent = "test-agent"): BlueprintNode {
  return { id, name: id, type: "agentic", agent }
}

describe("Feature: runBlueprint executes blueprints with proper result structure", () => {
  const mockBlueprint = makeBlueprint([agenticNode("node1")])

  it("should return RunResult with required fields on success", async () => {
    const mockAgenticHandler: AgenticHandler = vi.fn().mockResolvedValue({
      status: "ok" as const,
      data: "test output",
      cost_usd: 0.01,
      duration_ms: 100,
    })

    const result = await runBlueprint(mockBlueprint, "test task", TEST_CONFIG, mockAgenticHandler)

    expect(result).toMatchObject({
      status: expect.stringMatching(/^(success|failure|handed_to_human)$/),
      runId: expect.any(String),
      totalCostUsd: expect.any(Number),
      totalDurationMs: expect.any(Number),
      nodeResults: expect.any(Object),
    })
    expect(result.runId).toMatch(/^\d{8}-\d{4}-run-[0-9a-f]+$/)
    expect(result.totalCostUsd).toBeGreaterThanOrEqual(0)
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0)
  })

  it("should accumulate costs from all nodes", async () => {
    const blueprint = makeBlueprint([agenticNode("node1"), agenticNode("node2")])

    const mockHandler: AgenticHandler = vi.fn().mockResolvedValue({
      status: "ok" as const,
      data: "output",
      cost_usd: 0.05,
      duration_ms: 50,
    })

    const result = await runBlueprint(blueprint, "task", TEST_CONFIG, mockHandler)

    expect(result.totalCostUsd).toBeCloseTo(0.1, 5)
    expect(Object.keys(result.nodeResults)).toHaveLength(2)
  })

  it("should call progress callback for each node event", async () => {
    const progressCallback: ProgressCallback = vi.fn()
    const mockHandler: AgenticHandler = vi.fn().mockResolvedValue({
      status: "ok" as const,
      data: "output",
      cost_usd: 0.01,
      duration_ms: 100,
    })

    await runBlueprint(mockBlueprint, "task", TEST_CONFIG, mockHandler, undefined, progressCallback)

    expect(progressCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "node_start",
        nodeId: "node1",
        nodeName: "node1",
        nodeType: "agentic",
        step: expect.any(Number),
        totalSteps: expect.any(Number),
      }),
    )

    expect(progressCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "node_complete",
        nodeId: "node1",
        status: "ok",
        costUsd: expect.any(Number),
        durationMs: expect.any(Number),
      }),
    )
  })
})

describe("Feature: runBlueprint handles human gate nodes", () => {
  it("should call humanGateHandler for human_gate nodes", async () => {
    const blueprint = makeBlueprint([
      { id: "gate1", name: "Human Gate", type: "human_gate" },
    ])

    const mockHumanHandler: HumanGateHandler = vi.fn().mockResolvedValue({
      status: "ok" as const,
      data: "approved",
      cost_usd: 0,
      duration_ms: 5000,
    })

    const result = await runBlueprint(blueprint, "task", TEST_CONFIG, undefined, mockHumanHandler)

    expect(mockHumanHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "gate1",
        type: "human_gate",
      }),
      expect.any(Object),
    )
    expect(result.status).toBe("success")
  })

  it("should return handed_to_human when human_gate fails with onFailure hand_to_human", async () => {
    const blueprint = makeBlueprint([
      {
        id: "gate1",
        name: "Blocking Gate",
        type: "human_gate",
        onFailure: "hand_to_human",
      },
    ])

    const mockHumanHandler: HumanGateHandler = vi.fn().mockResolvedValue({
      status: "fail" as const,
      error: { code: "HUMAN_REJECTED", message: "requires manual review" },
      cost_usd: 0,
      duration_ms: 1000,
    })

    const result = await runBlueprint(blueprint, "task", TEST_CONFIG, undefined, mockHumanHandler)

    expect(result.status).toBe("handed_to_human")
  })
})

describe("Feature: runBlueprint handles errors and failures", () => {
  const mockBlueprint = makeBlueprint([agenticNode("node1", "agent")])

  it("should return failure status when node fails", async () => {
    const mockHandler: AgenticHandler = vi.fn().mockResolvedValue({
      status: "fail" as const,
      error: { code: "NODE_EXECUTION_FAILED", message: "execution failed" },
      cost_usd: 0.02,
      duration_ms: 200,
    })

    const result = await runBlueprint(mockBlueprint, "task", TEST_CONFIG, mockHandler)

    expect(result.status).toBe("failure")
    expect(result.error).toMatchObject({
      code: expect.any(String),
      message: expect.any(String),
    })
  })

  it("should succeed with placeholder when agentic handler is omitted", async () => {
    const result = await runBlueprint(mockBlueprint, "task", TEST_CONFIG)

    expect(result.status).toBe("success")
    expect(result.nodeResults["node1"]?.status).toBe("ok")
    expect(String(result.nodeResults["node1"]?.data ?? "")).toContain("no LLM client provided")
  })

  it("should handle handler exceptions", async () => {
    const mockHandler: AgenticHandler = vi.fn().mockRejectedValue(new Error("Handler crashed"))

    const result = await runBlueprint(mockBlueprint, "task", TEST_CONFIG, mockHandler)

    expect(result.status).toBe("failure")
    expect(result.error?.message).toContain("Handler crashed")
  })
})

describe("Feature: Property-based tests for runBlueprint parameters", () => {
  const mockHandler: AgenticHandler = vi.fn().mockResolvedValue({
    status: "ok" as const,
    data: "output",
    cost_usd: 0.01,
    duration_ms: 100,
  })

  it("should handle arbitrary task strings", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 1000 }), async (task) => {
        const blueprint = makeBlueprint([agenticNode("node1")])

        const result = await runBlueprint(blueprint, task, TEST_CONFIG, mockHandler)

        expect(result.runId).toMatch(/^\d{8}-\d{4}-run-[0-9a-f]+$/)
        expect(result.totalCostUsd).toBeGreaterThanOrEqual(0)
        expect(result.totalDurationMs).toBeGreaterThanOrEqual(0)
      }),
      { numRuns: 20 },
    )
  })

  it("should handle blueprints with varying node counts", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 10 }), async (nodeCount) => {
        const nodes = Array.from({ length: nodeCount }, (_, i) => agenticNode(`node${i}`, `agent${i}`))
        const blueprint = makeBlueprint(nodes)

        const result = await runBlueprint(blueprint, "task", TEST_CONFIG, mockHandler)

        expect(Object.keys(result.nodeResults)).toHaveLength(nodeCount)
        expect(result.totalCostUsd).toBeCloseTo(nodeCount * 0.01, 5)
      }),
      { numRuns: 10 },
    )
  })
})

describe("Feature: Negative tests for invalid inputs", () => {
  const mockHandler: AgenticHandler = vi.fn().mockResolvedValue({
    status: "ok" as const,
    data: "output",
    cost_usd: 0.01,
    duration_ms: 100,
  })

  it("should handle empty task string", async () => {
    const blueprint = makeBlueprint([agenticNode("node1")])

    const result = await runBlueprint(blueprint, "", TEST_CONFIG, mockHandler)

    expect(result.runId).toBeDefined()
    expect(typeof result.status).toBe("string")
  })

  it("should handle blueprint with no nodes", async () => {
    const blueprint = makeBlueprint([])

    const result = await runBlueprint(blueprint, "task", TEST_CONFIG, mockHandler)

    expect(result.status).toBe("success")
    expect(Object.keys(result.nodeResults)).toHaveLength(0)
    expect(result.totalCostUsd).toBe(0)
  })
})
