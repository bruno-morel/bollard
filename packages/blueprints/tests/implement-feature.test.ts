import { describe, expect, it } from "vitest"
import { createImplementFeatureBlueprint } from "../src/implement-feature.js"

describe("createImplementFeatureBlueprint", () => {
  const bp = createImplementFeatureBlueprint("/tmp/test")

  it("has 16 nodes in the correct order", () => {
    expect(bp.nodes).toHaveLength(16)
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
      "extract-contracts",
      "generate-contract-tests",
      "write-contract-tests",
      "run-contract-tests",
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
      { id: "extract-contracts", type: "deterministic" },
      { id: "generate-contract-tests", type: "agentic" },
      { id: "write-contract-tests", type: "deterministic" },
      { id: "run-contract-tests", type: "deterministic" },
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
    expect(bp.nodes.find((n) => n.id === "generate-plan")?.agent).toBe("planner")
    expect(bp.nodes.find((n) => n.id === "implement")?.agent).toBe("coder")
    expect(bp.nodes.find((n) => n.id === "generate-tests")?.agent).toBe("boundary-tester")
    expect(bp.nodes.find((n) => n.id === "generate-contract-tests")?.agent).toBe("contract-tester")
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

  it("has 4 agentic nodes including contract-tester", () => {
    const agenticNodes = bp.nodes.filter((n) => n.type === "agentic")
    expect(agenticNodes).toHaveLength(4)
    expect(agenticNodes.map((n) => n.agent)).toEqual([
      "planner",
      "coder",
      "boundary-tester",
      "contract-tester",
    ])
  })

  it("docker-verify follows contract test nodes", () => {
    const idx = bp.nodes.findIndex((n) => n.id === "docker-verify")
    expect(bp.nodes[idx - 1]?.id).toBe("run-contract-tests")
    expect(bp.nodes[idx + 1]?.id).toBe("generate-diff")
  })

  it("docker-verify has an execute function", () => {
    const node = bp.nodes.find((n) => n.id === "docker-verify")
    expect(typeof node?.execute).toBe("function")
  })
})
