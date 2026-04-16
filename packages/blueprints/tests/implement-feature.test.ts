import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import type { PipelineContext } from "@bollard/engine/src/context.js"
import { CostTracker } from "@bollard/engine/src/cost-tracker.js"
import { describe, expect, it, vi } from "vitest"
import { createImplementFeatureBlueprint } from "../src/implement-feature.js"

describe("createImplementFeatureBlueprint", () => {
  const bp = createImplementFeatureBlueprint("/tmp/test")

  it("has 22 nodes in the correct order", () => {
    expect(bp.nodes).toHaveLength(22)
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
      "assess-contract-risk",
      "extract-contracts",
      "generate-contract-tests",
      "verify-claim-grounding",
      "write-contract-tests",
      "run-contract-tests",
      "run-mutation-testing",
      "generate-review-diff",
      "semantic-review",
      "verify-review-grounding",
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
      { id: "assess-contract-risk", type: "deterministic" },
      { id: "extract-contracts", type: "deterministic" },
      { id: "generate-contract-tests", type: "agentic" },
      { id: "verify-claim-grounding", type: "deterministic" },
      { id: "write-contract-tests", type: "deterministic" },
      { id: "run-contract-tests", type: "deterministic" },
      { id: "run-mutation-testing", type: "deterministic" },
      { id: "generate-review-diff", type: "deterministic" },
      { id: "semantic-review", type: "agentic" },
      { id: "verify-review-grounding", type: "deterministic" },
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
    expect(bp.nodes.find((n) => n.id === "semantic-review")?.agent).toBe("semantic-reviewer")
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

  it("has 5 agentic nodes including semantic-reviewer", () => {
    const agenticNodes = bp.nodes.filter((n) => n.type === "agentic")
    expect(agenticNodes).toHaveLength(5)
    expect(agenticNodes.map((n) => n.agent)).toEqual([
      "planner",
      "coder",
      "boundary-tester",
      "contract-tester",
      "semantic-reviewer",
    ])
  })

  it("semantic review nodes sit between run-mutation-testing and docker-verify", () => {
    const ids = bp.nodes.map((n) => n.id)
    const iMut = ids.indexOf("run-mutation-testing")
    expect(ids[iMut + 1]).toBe("generate-review-diff")
    expect(ids[iMut + 2]).toBe("semantic-review")
    expect(ids[iMut + 3]).toBe("verify-review-grounding")
    expect(ids[iMut + 4]).toBe("docker-verify")
  })

  it("docker-verify follows verify-review-grounding", () => {
    const idx = bp.nodes.findIndex((n) => n.id === "docker-verify")
    expect(bp.nodes[idx - 1]?.id).toBe("verify-review-grounding")
    expect(bp.nodes[idx + 1]?.id).toBe("generate-diff")
  })

  it("docker-verify has an execute function", () => {
    const node = bp.nodes.find((n) => n.id === "docker-verify")
    expect(typeof node?.execute).toBe("function")
  })
})

function makeCtx(): PipelineContext {
  const scopeConfig = (enabled: boolean) => ({
    enabled,
    integration: "independent" as const,
    lifecycle: "ephemeral" as const,
    concerns: {
      correctness: "high" as const,
      security: "medium" as const,
      performance: "low" as const,
      resilience: "off" as const,
    },
  })
  const profile: ToolchainProfile = {
    language: "typescript",
    packageManager: "pnpm",
    checks: {},
    sourcePatterns: ["src/**/*.ts"],
    testPatterns: ["**/*.test.ts"],
    ignorePatterns: [],
    allowedCommands: ["pnpm"],
    adversarial: {
      boundary: scopeConfig(true),
      contract: scopeConfig(false),
      behavioral: scopeConfig(false),
    },
  }
  return {
    runId: "run-1",
    task: "task",
    blueprintId: "implement-feature",
    config: {
      llm: { default: { provider: "mock", model: "m" } },
      agent: { max_cost_usd: 10, max_duration_minutes: 30 },
    },
    currentNode: "verify-review-grounding",
    results: {},
    changedFiles: [],
    toolchainProfile: profile,
    costTracker: new CostTracker(10),
    startedAt: Date.now(),
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    upgradeRunId: vi.fn(),
  }
}

describe("verify-review-grounding node", () => {
  it("returns ok with grounded findings", async () => {
    const bp = createImplementFeatureBlueprint("/tmp/w")
    const node = bp.nodes.find((n) => n.id === "verify-review-grounding")
    expect(node?.execute).toBeDefined()
    const execute = node?.execute
    if (!execute) {
      throw new Error("missing execute")
    }

    const ctx = makeCtx()
    ctx.plan = { summary: "Plan summary line" }
    ctx.results["generate-review-diff"] = {
      data: { diff: "@@\n+added line in diff\n", plan: ctx.plan },
    }
    ctx.results["semantic-review"] = {
      data: JSON.stringify({
        findings: [
          {
            id: "r1",
            severity: "warning",
            category: "plan-divergence",
            finding: "Mismatch",
            grounding: [
              { quote: "Plan summary line", source: "plan" },
              { quote: "+added line in diff", source: "diff" },
            ],
          },
        ],
      }),
    }

    const result = await execute(ctx)

    expect(result.status).toBe("ok")
    const data = result.data as { findings?: unknown[] }
    expect(data.findings?.length).toBe(1)
  })
})
