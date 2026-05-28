import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import {
  type Blueprint,
  flattenBlueprintNodes,
  isParallelGroup,
} from "@bollard/engine/src/blueprint.js"
import type { PipelineContext } from "@bollard/engine/src/context.js"
import { CostTracker } from "@bollard/engine/src/cost-tracker.js"
import { describe, expect, it, vi } from "vitest"
import { createImplementFeatureBlueprint } from "../src/implement-feature.js"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

function findNode(bp: Blueprint, id: string) {
  return flattenBlueprintNodes(bp.nodes).find((n) => n.id === id)
}

const ALL_LEAF_IDS = [
  "create-branch",
  "generate-plan",
  "approve-plan",
  "expand-affected-files",
  "implement",
  "static-checks",
  "extract-signatures",
  "assess-contract-risk",
  "extract-contracts",
  "extract-behavioral-context",
  "generate-tests",
  "verify-boundary-grounding",
  "write-tests",
  "run-tests",
  "generate-contract-tests",
  "verify-claim-grounding",
  "write-contract-tests",
  "run-contract-tests",
  "generate-behavioral-tests",
  "verify-behavioral-grounding",
  "write-behavioral-tests",
  "run-behavioral-tests",
  "extract-probes",
  "run-mutation-testing",
  "generate-review-diff",
  "extract-code-metrics",
  "semantic-review",
  "verify-review-grounding",
  "docker-verify",
  "generate-diff",
  "approve-pr",
] as const

describe("createImplementFeatureBlueprint", () => {
  const bp = createImplementFeatureBlueprint("/tmp/test")
  const flat = flattenBlueprintNodes(bp.nodes)

  it("has 17 top-level entries with parallel scope groups", () => {
    expect(bp.nodes).toHaveLength(17)
    const group1 = bp.nodes[6]
    expect(isParallelGroup(group1)).toBe(true)
    if (isParallelGroup(group1)) {
      expect(group1.id).toBe("scope-extraction")
      expect(group1.branches).toHaveLength(3)
      const boundaryBranch = group1.branches.find((b) => b.id === "boundary-extraction")
      expect(boundaryBranch?.nodes[0]?.id).toBe("extract-signatures")
    }
    const group2 = bp.nodes[7]
    expect(isParallelGroup(group2)).toBe(true)
    if (isParallelGroup(group2)) {
      expect(group2.id).toBe("scope-chains")
    }
    expect(bp.nodes[8]?.id).toBe("extract-probes")
    expect(bp.nodes[16]?.id).toBe("approve-pr")
  })

  it("has all 31 leaf node IDs in execution order", () => {
    expect(flat).toHaveLength(31)
    expect(flat.map((n) => n.id)).toEqual([...ALL_LEAF_IDS])
  })

  it("has correct node types", () => {
    const types = flat.map((n) => ({ id: n.id, type: n.type }))
    expect(types).toEqual(
      ALL_LEAF_IDS.map((id) => {
        const node = flat.find((n) => n.id === id)
        return { id, type: node?.type ?? "deterministic" }
      }),
    )
  })

  it("has correct cost and duration limits", () => {
    expect(bp.maxCostUsd).toBe(15)
    expect(bp.maxDurationMinutes).toBe(30)
  })

  it("has unique node IDs", () => {
    const ids = flat.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("deterministic nodes have execute functions", () => {
    const deterministicNodes = flat.filter((n) => n.type === "deterministic")
    for (const node of deterministicNodes) {
      expect(typeof node.execute).toBe("function")
    }
  })

  it("agentic nodes have agent roles", () => {
    expect(findNode(bp, "generate-plan")?.agent).toBe("planner")
    expect(findNode(bp, "implement")?.agent).toBe("coder")
    expect(findNode(bp, "generate-tests")?.agent).toBe("boundary-tester")
    expect(findNode(bp, "generate-contract-tests")?.agent).toBe("contract-tester")
    expect(findNode(bp, "generate-behavioral-tests")?.agent).toBe("behavioral-tester")
    expect(findNode(bp, "semantic-review")?.agent).toBe("semantic-reviewer")
  })

  it("coder node has retry config", () => {
    const implNode = findNode(bp, "implement")
    expect(implNode?.maxRetries).toBe(1)
    expect(implNode?.onFailure).toBe("stop")
  })

  it("selected deterministic best-effort nodes skip on failure after coder verification hook", () => {
    expect(findNode(bp, "expand-affected-files")?.onFailure).toBe("skip")
    expect(findNode(bp, "static-checks")?.onFailure).toBe("skip")
    expect(findNode(bp, "run-tests")?.onFailure).toBe("skip")
    expect(findNode(bp, "verify-boundary-grounding")?.onFailure).toBe("skip")
    expect(findNode(bp, "extract-code-metrics")?.onFailure).toBe("skip")
  })

  it("deterministic nodes never have an agent field", () => {
    const deterministicNodes = flat.filter((n) => n.type === "deterministic")
    expect(deterministicNodes.length).toBeGreaterThan(0)
    for (const node of deterministicNodes) {
      expect(node.agent).toBeUndefined()
    }
  })

  it("human_gate nodes never have an agent field or execute function", () => {
    const gates = flat.filter((n) => n.type === "human_gate")
    expect(gates.length).toBeGreaterThan(0)
    for (const node of gates) {
      expect(node.agent).toBeUndefined()
      expect(node.execute).toBeUndefined()
    }
  })

  it("agentic nodes never have an execute function", () => {
    const agenticNodes = flat.filter((n) => n.type === "agentic")
    expect(agenticNodes.length).toBeGreaterThan(0)
    for (const node of agenticNodes) {
      expect(node.execute).toBeUndefined()
    }
  })

  it("boundary grounding sits between generate-tests and write-tests", () => {
    const ids = flat.map((n) => n.id)
    const iGen = ids.indexOf("generate-tests")
    const iVerify = ids.indexOf("verify-boundary-grounding")
    const iWrite = ids.indexOf("write-tests")
    expect(iVerify).toBe(iGen + 1)
    expect(iWrite).toBe(iVerify + 1)
  })

  it("has 6 agentic nodes including behavioral-tester and semantic-reviewer", () => {
    const agenticNodes = flat.filter((n) => n.type === "agentic")
    expect(agenticNodes).toHaveLength(6)
    expect(agenticNodes.map((n) => n.agent)).toEqual([
      "planner",
      "coder",
      "boundary-tester",
      "contract-tester",
      "behavioral-tester",
      "semantic-reviewer",
    ])
  })

  it("behavioral extraction precedes chains; behavioral chain precedes extract-probes", () => {
    const ids = flat.map((n) => n.id)
    expect(ids.indexOf("extract-behavioral-context")).toBeLessThan(ids.indexOf("generate-tests"))
    const iContract = ids.indexOf("run-contract-tests")
    expect(ids[iContract + 1]).toBe("generate-behavioral-tests")
    expect(ids[iContract + 4]).toBe("run-behavioral-tests")
    expect(ids[iContract + 5]).toBe("extract-probes")
  })

  it("semantic review nodes sit between run-mutation-testing and docker-verify", () => {
    const ids = flat.map((n) => n.id)
    const iMut = ids.indexOf("run-mutation-testing")
    expect(ids[iMut + 1]).toBe("generate-review-diff")
    expect(ids[iMut + 2]).toBe("extract-code-metrics")
    expect(ids[iMut + 3]).toBe("semantic-review")
    expect(ids[iMut + 4]).toBe("verify-review-grounding")
    expect(ids[iMut + 5]).toBe("docker-verify")
  })

  it("docker-verify follows verify-review-grounding", () => {
    const idx = flat.findIndex((n) => n.id === "docker-verify")
    expect(flat[idx - 1]?.id).toBe("verify-review-grounding")
    expect(flat[idx + 1]?.id).toBe("generate-diff")
  })

  it("docker-verify has an execute function", () => {
    const node = findNode(bp, "docker-verify")
    expect(typeof node?.execute).toBe("function")
  })
})

function makeWriteTestsCtx(workDir: string): PipelineContext {
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
    sourcePatterns: ["**/*.ts"],
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
    runId: "run-verify-only",
    task: "verify multiply",
    blueprintId: "implement-feature",
    config: {
      llm: { default: { provider: "mock", model: "m" } },
      agent: { max_cost_usd: 10, max_duration_minutes: 30 },
    },
    currentNode: "write-tests",
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
    plan: {
      affected_files: { modify: [], create: [], delete: [] },
      steps: [{ files: ["packages/engine/src/cost-tracker.ts"] }],
    },
  }
}

function makeExtractSignaturesCtx(workDir: string, plan: PipelineContext["plan"]): PipelineContext {
  const ctx = makeWriteTestsCtx(workDir)
  ctx.currentNode = "extract-signatures"
  ctx.plan = plan
  return ctx
}

describe("extract-signatures verification-only fallback", () => {
  it("falls back to plan steps files when affected_files.modify is empty", async () => {
    const bp = createImplementFeatureBlueprint(REPO_ROOT)
    const node = findNode(bp, "extract-signatures")
    const execute = node?.execute
    if (!execute) throw new Error("missing execute")

    const ctx = makeExtractSignaturesCtx(REPO_ROOT, {
      affected_files: { modify: [], create: [], delete: [] },
      steps: [{ files: ["packages/engine/src/cost-tracker.ts"] }],
    })

    const result = await execute(ctx)
    expect(result.status).toBe("ok")
    const data = result.data as {
      filesExtracted?: number
      signatures?: Array<{ signatures?: string }>
    }
    expect(data.filesExtracted).toBeGreaterThan(0)
    const corpus = (data.signatures ?? []).map((s) => s.signatures ?? "").join("\n")
    expect(corpus).toMatch(/constructor\s*\(\s*limitUsd/)
  })

  it("returns empty extraction when modify and steps are empty", async () => {
    const bp = createImplementFeatureBlueprint(REPO_ROOT)
    const execute = findNode(bp, "extract-signatures")?.execute
    if (!execute) throw new Error("missing execute")

    const ctx = makeExtractSignaturesCtx(REPO_ROOT, {
      affected_files: { modify: [], create: [], delete: [] },
      steps: [],
    })

    const result = await execute(ctx)
    expect(result.status).toBe("ok")
    expect(result.data).toEqual({ filesExtracted: 0, signatures: [], types: [] })
  })

  it("filters test files from plan steps", async () => {
    const bp = createImplementFeatureBlueprint(REPO_ROOT)
    const execute = findNode(bp, "extract-signatures")?.execute
    if (!execute) throw new Error("missing execute")

    const ctx = makeExtractSignaturesCtx(REPO_ROOT, {
      affected_files: { modify: [], create: [], delete: [] },
      steps: [{ files: ["packages/engine/tests/cost-tracker.test.ts"] }],
    })

    const result = await execute(ctx)
    expect(result.status).toBe("ok")
    expect(result.data).toEqual({ filesExtracted: 0, signatures: [], types: [] })
  })
})

describe("write-tests verification-only fallback", () => {
  it("skips gracefully when grounded claims exist but source file cannot be inferred", async () => {
    const bp = createImplementFeatureBlueprint("/tmp/w")
    const node = findNode(bp, "write-tests")
    const execute = node?.execute
    if (!execute) throw new Error("missing execute")

    const ctx = makeWriteTestsCtx("/tmp/w")
    ctx.plan = {
      affected_files: { modify: [], create: [], delete: [] },
      steps: [],
    }
    ctx.results["verify-boundary-grounding"] = {
      data: {
        claims: [
          {
            id: "unknown-format",
            concern: "correctness",
            claim: "test",
            grounding: [{ quote: "x", source: "task" }],
            test: "it('x', () => {})",
          },
        ],
      },
    }

    const result = await execute(ctx)
    expect(result.status).toBe("ok")
    expect((result.data as { skipped?: boolean }).skipped).toBe(true)
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
    const node = findNode(bp, "verify-review-grounding")
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
