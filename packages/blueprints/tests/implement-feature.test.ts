import { describe, expect, it } from "vitest"
import { createImplementFeatureBlueprint } from "../src/implement-feature.js"

describe("createImplementFeatureBlueprint", () => {
  const bp = createImplementFeatureBlueprint("/tmp/test")

  it("has 12 nodes in the correct order", () => {
    expect(bp.nodes).toHaveLength(12)
    const ids = bp.nodes.map((n) => n.id)
    expect(ids).toEqual([
      "create-branch",
      "generate-plan",
      "approve-plan",
      "implement",
      "static-checks",
      "extract-signatures",
      "generate-tests",
      "write-tests",
      "run-tests",
      "docker-verify",
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
      { id: "extract-signatures", type: "deterministic" },
      { id: "generate-tests", type: "agentic" },
      { id: "write-tests", type: "deterministic" },
      { id: "run-tests", type: "deterministic" },
      { id: "docker-verify", type: "deterministic" },
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
    const testNode = bp.nodes.find((n) => n.id === "generate-tests")
    expect(planNode?.agent).toBe("planner")
    expect(implNode?.agent).toBe("coder")
    expect(testNode?.agent).toBe("tester")
  })

  it("coder node has retry config", () => {
    const implNode = bp.nodes.find((n) => n.id === "implement")
    expect(implNode?.maxRetries).toBe(1)
    expect(implNode?.onFailure).toBe("stop")
  })

  it("deterministic nodes never have an agent field", () => {
    const deterministicNodes = bp.nodes.filter((n) => n.type === "deterministic")
    expect(deterministicNodes.length).toBeGreaterThan(0)
    for (const node of deterministicNodes) {
      expect(node.agent).toBeUndefined()
    }
  })

  it("human_gate nodes never have an agent field or execute function", () => {
    const gates = bp.nodes.filter((n) => n.type === "human_gate")
    expect(gates.length).toBeGreaterThan(0)
    for (const node of gates) {
      expect(node.agent).toBeUndefined()
      expect(node.execute).toBeUndefined()
    }
  })

  it("agentic nodes never have an execute function", () => {
    const agenticNodes = bp.nodes.filter((n) => n.type === "agentic")
    expect(agenticNodes.length).toBeGreaterThan(0)
    for (const node of agenticNodes) {
      expect(node.execute).toBeUndefined()
    }
  })

  it("has 3 agentic nodes (planner, coder, tester)", () => {
    const agenticNodes = bp.nodes.filter((n) => n.type === "agentic")
    expect(agenticNodes).toHaveLength(3)
    expect(agenticNodes.map((n) => n.agent)).toEqual(["planner", "coder", "tester"])
  })

  it("docker-verify is at position 10 (after run-tests)", () => {
    const idx = bp.nodes.findIndex((n) => n.id === "docker-verify")
    expect(idx).toBe(9)
    expect(bp.nodes[idx - 1]?.id).toBe("run-tests")
    expect(bp.nodes[idx + 1]?.id).toBe("generate-diff")
  })

  it("docker-verify has an execute function", () => {
    const node = bp.nodes.find((n) => n.id === "docker-verify")
    expect(typeof node?.execute).toBe("function")
  })
})
