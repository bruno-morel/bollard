import { describe, expect, it } from "vitest"
import { createImplementFeatureBlueprint } from "../src/implement-feature.js"

describe("createImplementFeatureBlueprint", () => {
  const bp = createImplementFeatureBlueprint("/tmp/test")

  it("has 8 nodes in the correct order", () => {
    expect(bp.nodes).toHaveLength(8)
    const ids = bp.nodes.map((n) => n.id)
    expect(ids).toEqual([
      "create-branch",
      "generate-plan",
      "approve-plan",
      "implement",
      "static-checks",
      "run-tests",
      "generate-diff",
      "approve-pr",
    ])
  })

  it("has correct node types", () => {
    const types = bp.nodes.map((n) => ({ id: n.id, type: n.type }))
    expect(types).toEqual([
      { id: "create-branch", type: "deterministic" },
      { id: "generate-plan", type: "agentic" },
      { id: "approve-plan", type: "human_gate" },
      { id: "implement", type: "agentic" },
      { id: "static-checks", type: "deterministic" },
      { id: "run-tests", type: "deterministic" },
      { id: "generate-diff", type: "deterministic" },
      { id: "approve-pr", type: "human_gate" },
    ])
  })

  it("has correct cost and duration limits", () => {
    expect(bp.maxCostUsd).toBe(15)
    expect(bp.maxDurationMinutes).toBe(30)
  })

  it("has unique node IDs", () => {
    const ids = bp.nodes.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("deterministic nodes have execute functions", () => {
    const deterministicNodes = bp.nodes.filter((n) => n.type === "deterministic")
    for (const node of deterministicNodes) {
      expect(typeof node.execute).toBe("function")
    }
  })

  it("agentic nodes have agent roles", () => {
    const planNode = bp.nodes.find((n) => n.id === "generate-plan")
    const implNode = bp.nodes.find((n) => n.id === "implement")
    expect(planNode?.agent).toBe("planner")
    expect(implNode?.agent).toBe("coder")
  })

  it("coder node has retry config", () => {
    const implNode = bp.nodes.find((n) => n.id === "implement")
    expect(implNode?.maxRetries).toBe(1)
    expect(implNode?.onFailure).toBe("stop")
  })
})
