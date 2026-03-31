import { describe, it, expect, vi } from "vitest"
import * as fc from "fast-check"
import { runBlueprint } from "../src/runner.js"
import type { Blueprint, BlueprintNode, NodeResult } from "../src/blueprint.js"
import type { BollardConfig, PipelineContext } from "../src/context.js"
import type { AgenticHandler, HumanGateHandler, ProgressCallback } from "../src/runner.js"

describe("Feature: runBlueprint executes blueprints with proper result structure", () => {
  const mockConfig: BollardConfig = {
    llm: {
      default: {
        provider: "openai",
        model: "gpt-4"
      }
    }
  }

  const mockBlueprint: Blueprint = {
    name: "test-blueprint",
    description: "Test blueprint",
    nodes: [
      {
        id: "node1",
        name: "Test Node",
        type: "agentic",
        agent: {
          role: "test-agent",
          goal: "test goal",
          backstory: "test backstory"
        },
        tools: [],
        dependencies: []
      }
    ]
  }

  it("should return RunResult with required fields on success", async () => {
    const mockAgenticHandler: AgenticHandler = vi.fn().mockResolvedValue({
      status: "ok" as const,
      output: "test output",
      costUsd: 0.01,
      durationMs: 100
    })

    const result = await runBlueprint(
      mockBlueprint,
      "test task",
      mockConfig,
      mockAgenticHandler
    )

    expect(result).toMatchObject({
      status: expect.stringMatching(/^(success|failure|handed_to_human)$/),
      runId: expect.any(String),
      totalCostUsd: expect.any(Number),
      totalDurationMs: expect.any(Number),
      nodeResults: expect.any(Object)
    })
    expect(result.runId).toHaveLength(36) // UUID format
    expect(result.totalCostUsd).toBeGreaterThanOrEqual(0)
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0)
  })

  it("should accumulate costs from all nodes", async () => {
    const blueprint: Blueprint = {
      name: "multi-node",
      description: "Multiple nodes",
      nodes: [
        {
          id: "node1",
          name: "Node 1",
          type: "agentic",
          agent: { role: "agent1", goal: "goal1", backstory: "backstory1" },
          tools: [],
          dependencies: []
        },
        {
          id: "node2",
          name: "Node 2",
          type: "agentic",
          agent: { role: "agent2", goal: "goal2", backstory: "backstory2" },
          tools: [],
          dependencies: ["node1"]
        }
      ]
    }

    const mockHandler: AgenticHandler = vi.fn().mockResolvedValue({
      status: "ok" as const,
      output: "output",
      costUsd: 0.05,
      durationMs: 50
    })

    const result = await runBlueprint(blueprint, "task", mockConfig, mockHandler)

    expect(result.totalCostUsd).toBe(0.10) // 2 nodes * 0.05 each
    expect(Object.keys(result.nodeResults)).toHaveLength(2)
  })

  it("should call progress callback for each node event", async () => {
    const progressCallback = vi.fn()
    const mockHandler: AgenticHandler = vi.fn().mockResolvedValue({
      status: "ok" as const,
      output: "output",
      costUsd: 0.01,
      durationMs: 100
    })

    await runBlueprint(
      mockBlueprint,
      "task",
      mockConfig,
      mockHandler,
      undefined,
      progressCallback
    )

    expect(progressCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "node_start",
        nodeId: "node1",
        nodeName: "Test Node",
        nodeType: "agentic",
        step: expect.any(Number),
        totalSteps: expect.any(Number)
      })
    )

    expect(progressCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "node_complete",
        nodeId: "node1",
        status: "ok",
        costUsd: expect.any(Number),
        durationMs: expect.any(Number)
      })
    )
  })
})

describe("Feature: runBlueprint handles human gate nodes", () => {
  const mockConfig: BollardConfig = {
    llm: {
      default: {
        provider: "openai",
        model: "gpt-4"
      }
    }
  }

  it("should call humanGateHandler for human_gate nodes", async () => {
    const blueprint: Blueprint = {
      name: "human-gate-test",
      description: "Test human gate",
      nodes: [
        {
          id: "gate1",
          name: "Human Gate",
          type: "human_gate",
          message: "Please review",
          dependencies: []
        }
      ]
    }

    const mockHumanHandler: HumanGateHandler = vi.fn().mockResolvedValue({
      status: "ok" as const,
      output: "approved",
      costUsd: 0,
      durationMs: 5000
    })

    const result = await runBlueprint(
      blueprint,
      "task",
      mockConfig,
      undefined,
      mockHumanHandler
    )

    expect(mockHumanHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "gate1",
        type: "human_gate",
        message: "Please review"
      }),
      expect.any(Object)
    )
    expect(result.status).toBe("success")
  })

  it("should return handed_to_human status when human gate blocks", async () => {
    const blueprint: Blueprint = {
      name: "blocking-gate",
      description: "Blocking gate",
      nodes: [
        {
          id: "gate1",
          name: "Blocking Gate",
          type: "human_gate",
          message: "Manual intervention required",
          dependencies: []
        }
      ]
    }

    const mockHumanHandler: HumanGateHandler = vi.fn().mockResolvedValue({
      status: "block" as const,
      output: "requires manual review",
      costUsd: 0,
      durationMs: 1000
    })

    const result = await runBlueprint(
      blueprint,
      "task",
      mockConfig,
      undefined,
      mockHumanHandler
    )

    expect(result.status).toBe("handed_to_human")
  })
})

describe("Feature: runBlueprint handles errors and failures", () => {
  const mockConfig: BollardConfig = {
    llm: {
      default: {
        provider: "openai",
        model: "gpt-4"
      }
    }
  }

  const mockBlueprint: Blueprint = {
    name: "error-test",
    description: "Error test",
    nodes: [
      {
        id: "node1",
        name: "Failing Node",
        type: "agentic",
        agent: { role: "agent", goal: "goal", backstory: "backstory" },
        tools: [],
        dependencies: []
      }
    ]
  }

  it("should return failure status when node fails", async () => {
    const mockHandler: AgenticHandler = vi.fn().mockResolvedValue({
      status: "fail" as const,
      output: "execution failed",
      costUsd: 0.02,
      durationMs: 200
    })

    const result = await runBlueprint(mockBlueprint, "task", mockConfig, mockHandler)

    expect(result.status).toBe("failure")
    expect(result.error).toMatchObject({
      code: expect.any(String),
      message: expect.any(String)
    })
  })

  it("should handle missing agentic handler", async () => {
    const result = await runBlueprint(mockBlueprint, "task", mockConfig)

    expect(result.status).toBe("failure")
    expect(result.error?.message).toContain("handler")
  })

  it("should handle handler exceptions", async () => {
    const mockHandler: AgenticHandler = vi.fn().mockRejectedValue(
      new Error("Handler crashed")
    )

    const result = await runBlueprint(mockBlueprint, "task", mockConfig, mockHandler)

    expect(result.status).toBe("failure")
    expect(result.error?.message).toContain("Handler crashed")
  })
})

describe("Feature: Property-based tests for runBlueprint parameters", () => {
  const mockConfig: BollardConfig = {
    llm: {
      default: {
        provider: "openai",
        model: "gpt-4"
      }
    }
  }

  const mockHandler: AgenticHandler = vi.fn().mockResolvedValue({
    status: "ok" as const,
    output: "output",
    costUsd: 0.01,
    durationMs: 100
  })

  it("should handle arbitrary task strings", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 1000 }),
        async (task) => {
          const blueprint: Blueprint = {
            name: "prop-test",
            description: "Property test",
            nodes: [
              {
                id: "node1",
                name: "Test Node",
                type: "agentic",
                agent: { role: "agent", goal: "goal", backstory: "backstory" },
                tools: [],
                dependencies: []
              }
            ]
          }

          const result = await runBlueprint(blueprint, task, mockConfig, mockHandler)

          expect(result.runId).toMatch(/^[0-9a-f-]{36}$/) // UUID format
          expect(result.totalCostUsd).toBeGreaterThanOrEqual(0)
          expect(result.totalDurationMs).toBeGreaterThanOrEqual(0)
        }
      ),
      { numRuns: 20 }
    )
  })

  it("should handle blueprints with varying node counts", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        async (nodeCount) => {
          const nodes = Array.from({ length: nodeCount }, (_, i) => ({
            id: `node${i}`,
            name: `Node ${i}`,
            type: "agentic" as const,
            agent: { role: `agent${i}`, goal: `goal${i}`, backstory: `backstory${i}` },
            tools: [],
            dependencies: i > 0 ? [`node${i - 1}`] : []
          }))

          const blueprint: Blueprint = {
            name: "variable-nodes",
            description: "Variable node count",
            nodes
          }

          const result = await runBlueprint(blueprint, "task", mockConfig, mockHandler)

          expect(Object.keys(result.nodeResults)).toHaveLength(nodeCount)
          expect(result.totalCostUsd).toBe(nodeCount * 0.01)
        }
      ),
      { numRuns: 10 }
    )
  })
})

describe("Feature: Negative tests for invalid inputs", () => {
  const mockConfig: BollardConfig = {
    llm: {
      default: {
        provider: "openai",
        model: "gpt-4"
      }
    }
  }

  const mockHandler: AgenticHandler = vi.fn().mockResolvedValue({
    status: "ok" as const,
    output: "output",
    costUsd: 0.01,
    durationMs: 100
  })

  it("should handle empty task string", async () => {
    const blueprint: Blueprint = {
      name: "empty-task-test",
      description: "Empty task test",
      nodes: [
        {
          id: "node1",
          name: "Node",
          type: "agentic",
          agent: { role: "agent", goal: "goal", backstory: "backstory" },
          tools: [],
          dependencies: []
        }
      ]
    }

    const result = await runBlueprint(blueprint, "", mockConfig, mockHandler)

    // Should still execute but may affect context
    expect(result.runId).toBeDefined()
    expect(typeof result.status).toBe("string")
  })

  it("should handle blueprint with no nodes", async () => {
    const blueprint: Blueprint = {
      name: "empty-blueprint",
      description: "No nodes",
      nodes: []
    }

    const result = await runBlueprint(blueprint, "task", mockConfig, mockHandler)

    expect(result.status).toBe("success")
    expect(Object.keys(result.nodeResults)).toHaveLength(0)
    expect(result.totalCostUsd).toBe(0)
  })

  it("should handle circular dependencies", async () => {
    const blueprint: Blueprint = {
      name: "circular-deps",
      description: "Circular dependencies",
      nodes: [
        {
          id: "node1",
          name: "Node 1",
          type: "agentic",
          agent: { role: "agent1", goal: "goal1", backstory: "backstory1" },
          tools: [],
          dependencies: ["node2"]
        },
        {
          id: "node2",
          name: "Node 2",
          type: "agentic",
          agent: { role: "agent2", goal: "goal2", backstory: "backstory2" },
          tools: [],
          dependencies: ["node1"]
        }
      ]
    }

    const result = await runBlueprint(blueprint, "task", mockConfig, mockHandler)

    expect(result.status).toBe("failure")
    expect(result.error?.message).toContain("circular")
  })

  it("should handle missing dependencies", async () => {
    const blueprint: Blueprint = {
      name: "missing-deps",
      description: "Missing dependencies",
      nodes: [
        {
          id: "node1",
          name: "Node 1",
          type: "agentic",
          agent: { role: "agent", goal: "goal", backstory: "backstory" },
          tools: [],
          dependencies: ["nonexistent"]
        }
      ]
    }

    const result = await runBlueprint(blueprint, "task", mockConfig, mockHandler)

    expect(result.status).toBe("failure")
    expect(result.error?.message).toContain("dependency")
  })
})