import type { MutationConfig, ToolchainProfile } from "@bollard/detect/src/types.js"
import type { PipelineContext } from "@bollard/engine/src/context.js"
import { CostTracker } from "@bollard/engine/src/cost-tracker.js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createImplementFeatureBlueprint } from "../src/implement-feature.js"

const { mockRunMutationTesting } = vi.hoisted(() => ({
  mockRunMutationTesting: vi.fn(),
}))

vi.mock("@bollard/verify/src/mutation.js", () => ({
  runMutationTesting: mockRunMutationTesting,
}))

function makeProfile(mutation?: MutationConfig): ToolchainProfile {
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
      contract: scopeConfig(false),
      behavioral: scopeConfig(false),
    },
    ...(mutation !== undefined ? { mutation } : {}),
  }
}

function makeCtx(profile: ToolchainProfile): PipelineContext {
  return {
    runId: "test-run-001",
    task: "test task",
    blueprintId: "implement-feature",
    config: {
      llm: { default: { provider: "mock", model: "mock-1" } },
      agent: { max_cost_usd: 10, max_duration_minutes: 30 },
    },
    currentNode: "run-mutation-testing",
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

function getMutationNode() {
  const bp = createImplementFeatureBlueprint("/tmp/test")
  const node = bp.nodes.find((n) => n.id === "run-mutation-testing")
  if (!node?.execute) {
    throw new Error("run-mutation-testing node not found or has no execute")
  }
  return node.execute
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("run-mutation-testing node", () => {
  it("skips when mutation config is undefined on profile", async () => {
    const execute = getMutationNode()
    const ctx = makeCtx(makeProfile())

    const result = await execute(ctx)

    expect(result.status).toBe("ok")
    expect((result.data as Record<string, unknown>).skipped).toBe(true)
    expect((result.data as Record<string, unknown>).reason).toBe("mutation testing not enabled")
    expect(mockRunMutationTesting).not.toHaveBeenCalled()
  })

  it("skips when mutation.enabled is false", async () => {
    const execute = getMutationNode()
    const profile = makeProfile({
      enabled: false,
      tool: "stryker",
      threshold: 80,
      timeoutMs: 300_000,
      concurrency: 2,
    })
    const ctx = makeCtx(profile)

    const result = await execute(ctx)

    expect(result.status).toBe("ok")
    expect((result.data as Record<string, unknown>).skipped).toBe(true)
    expect(mockRunMutationTesting).not.toHaveBeenCalled()
  })

  it("sets ctx.mutationScore on success", async () => {
    const execute = getMutationNode()
    const profile = makeProfile({
      enabled: true,
      tool: "stryker",
      threshold: 80,
      timeoutMs: 300_000,
      concurrency: 2,
    })
    const ctx = makeCtx(profile)

    mockRunMutationTesting.mockResolvedValue({
      score: 85,
      killed: 17,
      survived: 3,
      noCoverage: 0,
      timeout: 0,
      totalMutants: 20,
      duration_ms: 5000,
    })

    const result = await execute(ctx)

    expect(result.status).toBe("ok")
    expect(ctx.mutationScore).toBe(85)
  })

  it("fails with MUTATION_THRESHOLD_NOT_MET when below threshold", async () => {
    const execute = getMutationNode()
    const profile = makeProfile({
      enabled: true,
      tool: "stryker",
      threshold: 80,
      timeoutMs: 300_000,
      concurrency: 2,
    })
    const ctx = makeCtx(profile)

    mockRunMutationTesting.mockResolvedValue({
      score: 60,
      killed: 6,
      survived: 4,
      noCoverage: 0,
      timeout: 0,
      totalMutants: 10,
      duration_ms: 3000,
    })

    const result = await execute(ctx)

    expect(result.status).toBe("fail")
    expect(result.error?.code).toBe("MUTATION_THRESHOLD_NOT_MET")
    expect(result.error?.message).toContain("60.0%")
    expect(result.error?.message).toContain("80%")
  })

  it("passes with zero mutants even when score is 0", async () => {
    const execute = getMutationNode()
    const profile = makeProfile({
      enabled: true,
      tool: "stryker",
      threshold: 80,
      timeoutMs: 300_000,
      concurrency: 2,
    })
    const ctx = makeCtx(profile)

    mockRunMutationTesting.mockResolvedValue({
      score: 0,
      killed: 0,
      survived: 0,
      noCoverage: 0,
      timeout: 0,
      totalMutants: 0,
      duration_ms: 100,
    })

    const result = await execute(ctx)

    expect(result.status).toBe("ok")
    expect(ctx.mutationScore).toBe(0)
  })

  it("emits mutation_testing_result log event with scopedToFiles false when no plan", async () => {
    const execute = getMutationNode()
    const profile = makeProfile({
      enabled: true,
      tool: "stryker",
      threshold: 80,
      timeoutMs: 300_000,
      concurrency: 2,
    })
    const ctx = makeCtx(profile)

    mockRunMutationTesting.mockResolvedValue({
      score: 90,
      killed: 9,
      survived: 1,
      noCoverage: 0,
      timeout: 0,
      totalMutants: 10,
      duration_ms: 4000,
    })

    await execute(ctx)

    expect(ctx.log.info).toHaveBeenCalledWith("mutation_testing_result", {
      event: "mutation_testing_result",
      runId: "test-run-001",
      score: 90,
      killed: 9,
      survived: 1,
      noCoverage: 0,
      timeout: 0,
      totalMutants: 10,
      duration_ms: 4000,
      scopedToFiles: false,
      affectedFileCount: 0,
    })
  })

  it("passes affected files to runMutationTesting", async () => {
    const execute = getMutationNode()
    const profile = makeProfile({
      enabled: true,
      tool: "stryker",
      threshold: 80,
      timeoutMs: 300_000,
      concurrency: 2,
    })
    const ctx = makeCtx(profile)
    ctx.plan = {
      affected_files: {
        modify: ["packages/engine/src/cost-tracker.ts"],
      },
    }

    mockRunMutationTesting.mockResolvedValue({
      score: 85,
      killed: 17,
      survived: 3,
      noCoverage: 0,
      timeout: 0,
      totalMutants: 20,
      duration_ms: 5000,
    })

    await execute(ctx)

    expect(mockRunMutationTesting).toHaveBeenCalledWith("/tmp/test", profile, [
      "packages/engine/src/cost-tracker.ts",
    ])
  })

  it("passes undefined when no affected files", async () => {
    const execute = getMutationNode()
    const profile = makeProfile({
      enabled: true,
      tool: "stryker",
      threshold: 80,
      timeoutMs: 300_000,
      concurrency: 2,
    })
    const ctx = makeCtx(profile)

    mockRunMutationTesting.mockResolvedValue({
      score: 85,
      killed: 17,
      survived: 3,
      noCoverage: 0,
      timeout: 0,
      totalMutants: 20,
      duration_ms: 5000,
    })

    await execute(ctx)

    expect(mockRunMutationTesting).toHaveBeenCalledWith("/tmp/test", profile, undefined)
  })

  it("log event includes scopedToFiles true when files are scoped", async () => {
    const execute = getMutationNode()
    const profile = makeProfile({
      enabled: true,
      tool: "stryker",
      threshold: 80,
      timeoutMs: 300_000,
      concurrency: 2,
    })
    const ctx = makeCtx(profile)
    ctx.plan = {
      affected_files: {
        modify: ["packages/engine/src/cost-tracker.ts"],
      },
    }

    mockRunMutationTesting.mockResolvedValue({
      score: 90,
      killed: 9,
      survived: 1,
      noCoverage: 0,
      timeout: 0,
      totalMutants: 10,
      duration_ms: 4000,
    })

    await execute(ctx)

    expect(ctx.log.info).toHaveBeenCalledWith(
      "mutation_testing_result",
      expect.objectContaining({
        scopedToFiles: true,
        affectedFileCount: 1,
      }),
    )
  })
})
