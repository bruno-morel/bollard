import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import type { PipelineContext } from "@bollard/engine/src/context.js"
import { CostTracker } from "@bollard/engine/src/cost-tracker.js"
import { describe, expect, it, vi } from "vitest"
import { createImplementFeatureBlueprint } from "../src/implement-feature.js"

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

function makeClaimDocument(
  claims: Array<{
    id: string
    concern: string
    claim: string
    quote: string
    source: string
    test: string
  }>,
): string {
  return JSON.stringify({
    claims: claims.map((c) => ({
      id: c.id,
      concern: c.concern,
      claim: c.claim,
      grounding: [{ quote: c.quote, source: c.source }],
      test: c.test,
    })),
  })
}

function makeContext(overrides?: {
  contractEnabled?: boolean
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
    currentNode: "verify-claim-grounding",
    results: (overrides?.results ?? {}) as Record<string, PipelineContext["results"][string]>,
    changedFiles: [],
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

function getGroundingNode() {
  const bp = createImplementFeatureBlueprint("/tmp/test")
  const node = bp.nodes.find((n) => n.id === "verify-claim-grounding")
  if (!node?.execute) {
    throw new Error("verify-claim-grounding node not found or has no execute")
  }
  return node.execute
}

describe("verify-claim-grounding contract_grounding_result event", () => {
  it("emits all-grounded event when every claim passes", async () => {
    const execute = getGroundingNode()
    const ctx = makeContext({
      results: {
        "extract-contracts": {
          status: "ok",
          data: {
            contract: {
              modules: [
                {
                  path: "src/tracker.ts",
                  packageName: "@test/pkg",
                  publicExports: [
                    {
                      name: "Tracker",
                      signatures: "class Tracker { add(n: number): void }",
                      types: "number",
                    },
                    {
                      name: "remove",
                      signatures: "function remove(id: string): boolean",
                      types: "string | boolean",
                    },
                    {
                      name: "reset",
                      signatures: "function reset(): void",
                    },
                    {
                      name: "snapshot",
                      signatures: "function snapshot(): Readonly<{ total: number }>",
                    },
                    {
                      name: "count",
                      signatures: "function count(): number",
                    },
                  ],
                },
              ],
              edges: [],
              affectedEdges: [],
            },
          },
        },
        "generate-contract-tests": {
          status: "ok",
          data: makeClaimDocument([
            {
              id: "tracker-add",
              concern: "correctness",
              claim: "add increments",
              quote: "add(n: number): void",
              source: "src/tracker.ts",
              test: "it('adds', () => {})",
            },
            {
              id: "remove-returns",
              concern: "correctness",
              claim: "remove returns bool",
              quote: "function remove(id: string): boolean",
              source: "src/tracker.ts",
              test: "it('removes', () => {})",
            },
            {
              id: "reset-clears",
              concern: "correctness",
              claim: "reset clears state",
              quote: "function reset(): void",
              source: "src/tracker.ts",
              test: "it('resets', () => {})",
            },
            {
              id: "snapshot-frozen",
              concern: "security",
              claim: "snapshot is frozen",
              quote: "function snapshot(): Readonly<{ total: number }>",
              source: "src/tracker.ts",
              test: "it('freezes', () => {})",
            },
            {
              id: "count-returns",
              concern: "correctness",
              claim: "count returns number",
              quote: "function count(): number",
              source: "src/tracker.ts",
              test: "it('counts', () => {})",
            },
          ]),
        },
      },
    })

    await execute(ctx)

    expect(ctx.log.info).toHaveBeenCalledOnce()
    expect(ctx.log.info).toHaveBeenCalledWith("contract_grounding_result", {
      event: "contract_grounding_result",
      runId: "test-run-001",
      language: "typescript",
      proposed: 5,
      grounded: 5,
      dropped: 0,
      dropRate: 0,
      droppedSymbols: [],
    })
  })

  it("emits partial-drop event with correct symbols and rate", async () => {
    const execute = getGroundingNode()
    const ctx = makeContext({
      results: {
        "extract-contracts": {
          status: "ok",
          data: {
            contract: {
              modules: [
                {
                  path: "src/tracker.ts",
                  packageName: "@test/pkg",
                  publicExports: [
                    {
                      name: "Tracker",
                      signatures: "class Tracker { add(n: number): void }",
                    },
                    {
                      name: "remove",
                      signatures: "function remove(id: string): boolean",
                    },
                    {
                      name: "reset",
                      signatures: "function reset(): void",
                    },
                  ],
                },
              ],
              edges: [],
              affectedEdges: [],
            },
          },
        },
        "generate-contract-tests": {
          status: "ok",
          data: makeClaimDocument([
            {
              id: "tracker-add",
              concern: "correctness",
              claim: "add increments",
              quote: "add(n: number): void",
              source: "src/tracker.ts",
              test: "it('adds', () => {})",
            },
            {
              id: "remove-returns",
              concern: "correctness",
              claim: "remove returns bool",
              quote: "function remove(id: string): boolean",
              source: "src/tracker.ts",
              test: "it('removes', () => {})",
            },
            {
              id: "reset-clears",
              concern: "correctness",
              claim: "reset clears state",
              quote: "function reset(): void",
              source: "src/tracker.ts",
              test: "it('resets', () => {})",
            },
            {
              id: "hallucinated-merge",
              concern: "correctness",
              claim: "merge combines two trackers",
              quote: "function merge(a: Tracker, b: Tracker): Tracker",
              source: "src/tracker.ts",
              test: "it('merges', () => {})",
            },
            {
              id: "hallucinated-clone",
              concern: "security",
              claim: "clone deep copies",
              quote: "function clone(): Tracker",
              source: "src/tracker.ts",
              test: "it('clones', () => {})",
            },
          ]),
        },
      },
    })

    await execute(ctx)

    expect(ctx.log.info).toHaveBeenCalledOnce()
    expect(ctx.log.info).toHaveBeenCalledWith("contract_grounding_result", {
      event: "contract_grounding_result",
      runId: "test-run-001",
      language: "typescript",
      proposed: 5,
      grounded: 3,
      dropped: 2,
      dropRate: 0.4,
      droppedSymbols: ["hallucinated-clone", "hallucinated-merge"],
    })
  })

  it("emits all-zero event when contract scope is disabled", async () => {
    const execute = getGroundingNode()
    const ctx = makeContext({ contractEnabled: false })

    await execute(ctx)

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
