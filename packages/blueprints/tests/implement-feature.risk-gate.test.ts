import { promisify } from "node:util"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import type { PipelineContext } from "@bollard/engine/src/context.js"
import { CostTracker } from "@bollard/engine/src/cost-tracker.js"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createImplementFeatureBlueprint,
  scanDiffForExportChanges,
} from "../src/implement-feature.js"

const { mockExecFileAsync } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
}))

vi.mock("node:child_process", () => {
  const mockFn = Object.assign(vi.fn(), {
    [promisify.custom]: mockExecFileAsync,
  })
  return { execFile: mockFn }
})

function makeProfile(contractEnabled: boolean): ToolchainProfile {
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
  return {
    language: "typescript",
    packageManager: "pnpm",
    checks: {},
    sourcePatterns: ["src/**/*.ts"],
    testPatterns: ["tests/**/*.test.ts"],
    ignorePatterns: ["node_modules"],
    allowedCommands: ["pnpm"],
    adversarial: {
      boundary: scopeConfig(true),
      contract: scopeConfig(contractEnabled),
      behavioral: scopeConfig(false),
    },
  }
}

function makeContext(overrides?: {
  contractEnabled?: boolean
  plan?: unknown
  results?: Record<string, unknown>
}): PipelineContext {
  const logInfo = vi.fn()
  return {
    runId: "test-run-001",
    task: "test task",
    blueprintId: "implement-feature",
    config: {
      llm: { default: { provider: "mock", model: "mock-1" } },
      agent: { max_cost_usd: 10, max_duration_minutes: 30 },
    },
    currentNode: "assess-contract-risk",
    results: (overrides?.results ?? {}) as Record<string, PipelineContext["results"][string]>,
    changedFiles: [],
    plan: overrides?.plan,
    toolchainProfile: makeProfile(overrides?.contractEnabled ?? true),
    costTracker: new CostTracker(10),
    startedAt: Date.now(),
    log: {
      debug: vi.fn(),
      info: logInfo,
      warn: vi.fn(),
      error: vi.fn(),
    },
    upgradeRunId: vi.fn(),
  }
}

function getRiskGateNode() {
  const bp = createImplementFeatureBlueprint("/tmp/test")
  const node = bp.nodes.find((n) => n.id === "assess-contract-risk")
  if (!node?.execute) {
    throw new Error("assess-contract-risk node not found or has no execute")
  }
  return node.execute
}

function getContractNode(id: string) {
  const bp = createImplementFeatureBlueprint("/tmp/test")
  const node = bp.nodes.find((n) => n.id === id)
  if (!node?.execute) {
    throw new Error(`${id} node not found or has no execute`)
  }
  return node.execute
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("scanDiffForExportChanges", () => {
  it("returns true when diff contains an added export line", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,3 +1,5 @@",
      " const internal = 1",
      "+export function foo() {}",
      " const another = 2",
    ].join("\n")
    expect(scanDiffForExportChanges(diff)).toBe(true)
  })

  it("returns false when diff has no export changes", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,3 +1,3 @@",
      "+const x = 1",
      "-const y = 2",
      " const z = 3",
    ].join("\n")
    expect(scanDiffForExportChanges(diff)).toBe(false)
  })
})

describe("assess-contract-risk node", () => {
  it("skips when risk is low and no exported symbols changed", async () => {
    const execute = getRiskGateNode()
    const ctx = makeContext({
      plan: { risk_assessment: { level: "low" } },
    })
    mockExecFileAsync.mockResolvedValue({ stdout: "+const x = 1\n-const y = 2\n", stderr: "" })

    const result = await execute(ctx)

    expect(result.status).toBe("ok")
    expect((result.data as Record<string, unknown>).skipContract).toBe(true)
    expect(ctx.log.info).toHaveBeenCalledWith("contract_scope_decision", {
      event: "contract_scope_decision",
      runId: "test-run-001",
      decision: "skipped-by-risk-gate",
      riskLevel: "low",
      touchesExportedSymbols: false,
      skipContract: true,
    })
  })

  it("runs when risk is low but exported symbols changed", async () => {
    const execute = getRiskGateNode()
    const ctx = makeContext({
      plan: { risk_assessment: { level: "low" } },
    })
    mockExecFileAsync.mockResolvedValue({ stdout: "+export function foo() {}\n", stderr: "" })

    const result = await execute(ctx)

    expect(result.status).toBe("ok")
    expect((result.data as Record<string, unknown>).skipContract).toBe(false)
    expect(ctx.log.info).toHaveBeenCalledWith("contract_scope_decision", {
      event: "contract_scope_decision",
      runId: "test-run-001",
      decision: "run",
      riskLevel: "low",
      touchesExportedSymbols: true,
      skipContract: false,
    })
  })

  it("runs when risk is medium even with no export changes", async () => {
    const execute = getRiskGateNode()
    const ctx = makeContext({
      plan: { risk_assessment: { level: "medium" } },
    })
    mockExecFileAsync.mockResolvedValue({ stdout: "+const x = 1\n", stderr: "" })

    const result = await execute(ctx)

    expect(result.status).toBe("ok")
    expect((result.data as Record<string, unknown>).skipContract).toBe(false)
    expect(ctx.log.info).toHaveBeenCalledWith("contract_scope_decision", {
      event: "contract_scope_decision",
      runId: "test-run-001",
      decision: "run",
      riskLevel: "medium",
      touchesExportedSymbols: false,
      skipContract: false,
    })
  })

  it("runs with unknown risk level when risk_assessment is missing", async () => {
    const execute = getRiskGateNode()
    const ctx = makeContext({
      plan: { summary: "x" },
    })
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" })

    const result = await execute(ctx)

    expect(result.status).toBe("ok")
    expect((result.data as Record<string, unknown>).riskLevel).toBe("unknown")
    expect((result.data as Record<string, unknown>).skipContract).toBe(false)
    expect(ctx.log.info).toHaveBeenCalledWith("contract_scope_decision", {
      event: "contract_scope_decision",
      runId: "test-run-001",
      decision: "run",
      riskLevel: "unknown",
      touchesExportedSymbols: false,
      skipContract: false,
    })
  })

  it("skips via profile path when contract scope is disabled", async () => {
    const execute = getRiskGateNode()
    const ctx = makeContext({ contractEnabled: false })

    const result = await execute(ctx)

    expect(result.status).toBe("ok")
    expect((result.data as Record<string, unknown>).skipContract).toBe(true)
    expect(ctx.log.info).toHaveBeenCalledWith("contract_scope_decision", {
      event: "contract_scope_decision",
      runId: "test-run-001",
      decision: "skipped-by-profile",
      riskLevel: "n/a",
      touchesExportedSymbols: false,
      skipContract: true,
    })
  })
})

describe("downstream risk-gate skip propagation", () => {
  it("all four deterministic contract nodes early-return when risk gate says skip", async () => {
    const nodeIds = [
      "extract-contracts",
      "verify-claim-grounding",
      "write-contract-tests",
      "run-contract-tests",
    ]

    for (const nodeId of nodeIds) {
      const execute = getContractNode(nodeId)
      const ctx = makeContext({
        contractEnabled: true,
        results: {
          "assess-contract-risk": {
            status: "ok",
            data: { skipContract: true },
          },
        },
      })

      const result = await execute(ctx)

      expect(result, `${nodeId} should return ok`).toEqual({
        status: "ok",
        data: { skipped: true, reason: "risk-gate" },
      })
    }
  })

  it("verify-claim-grounding emits all-zero contract_grounding_result when risk gate skips", async () => {
    const execute = getContractNode("verify-claim-grounding")
    const ctx = makeContext({
      contractEnabled: true,
      results: {
        "assess-contract-risk": {
          status: "ok",
          data: { skipContract: true },
        },
      },
    })

    const result = await execute(ctx)

    expect(result).toEqual({
      status: "ok",
      data: { skipped: true, reason: "risk-gate" },
    })
    expect(ctx.log.info).toHaveBeenCalledOnce()
    expect(ctx.log.info).toHaveBeenCalledWith("contract_grounding_result", {
      event: "contract_grounding_result",
      runId: "test-run-001",
      language: "typescript",
      proposed: 0,
      grounded: 0,
      dropped: 0,
      dropRate: 0,
      droppedSymbols: [],
    })
  })
})
