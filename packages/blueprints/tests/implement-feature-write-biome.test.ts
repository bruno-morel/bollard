import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import type { PipelineContext } from "@bollard/engine/src/context.js"
import { CostTracker } from "@bollard/engine/src/cost-tracker.js"
import { beforeEach, describe, expect, it, vi } from "vitest"

const biomeExecFileCalls: unknown[][] = []

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return {
    ...actual,
    execFile: ((...args: Parameters<typeof actual.execFile>) => {
      const cmd = args[0]
      if (cmd === "biome") {
        biomeExecFileCalls.push(args as unknown[])
        const last = args[args.length - 1]
        if (typeof last === "function") {
          process.nextTick(() => {
            ;(last as (e: Error | null, stdout: Buffer, stderr: Buffer) => void)(
              null,
              Buffer.from(""),
              Buffer.from(""),
            )
          })
        }
        return undefined as ReturnType<typeof actual.execFile>
      }
      return actual.execFile(...args)
    }) as typeof actual.execFile,
  }
})

import { createImplementFeatureBlueprint } from "../src/implement-feature.js"

function makeWriteTestsCtx(tempDir: string): PipelineContext {
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
    currentNode: "write-tests",
    results: {
      "generate-tests": {
        status: "ok",
        data: `import { describe, it, expect } from "vitest"\n\ndescribe("t", () => {\n  it("x", () => {\n    expect(1).toBe(1)\n  })\n})\n`,
      },
    },
    plan: {
      affected_files: { modify: ["src/foo.ts"], create: [] },
    },
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

describe("write-tests node runs biome on generated file", () => {
  let tempDir: string

  beforeEach(() => {
    biomeExecFileCalls.length = 0
    tempDir = mkdtempSync(join(tmpdir(), "bollard-write-biome-"))
    mkdirSync(join(tempDir, "src"), { recursive: true })
    writeFileSync(join(tempDir, "src", "foo.ts"), "export const x = 1\n")
  })

  it("calls biome check --write --unsafe on the written adversarial test path", async () => {
    const bp = createImplementFeatureBlueprint(tempDir)
    const node = bp.nodes.find((n) => n.id === "write-tests")
    expect(node?.execute).toBeDefined()
    const execute = node?.execute
    if (!execute) {
      throw new Error("missing execute")
    }

    const ctx = makeWriteTestsCtx(tempDir)
    const result = await execute(ctx)

    expect(result.status).toBe("ok")
    expect(biomeExecFileCalls.length).toBe(1)
    const first = biomeExecFileCalls[0]
    expect(first?.[0]).toBe("biome")
    const biomeArgs = first?.[1] as string[] | undefined
    expect(biomeArgs).toEqual(["check", "--write", "--unsafe", expect.any(String)])
    const fullPath = biomeArgs?.[3]
    expect(fullPath).toContain(".adversarial.test.ts")
    expect(fullPath).toMatch(/^\/|^([A-Za-z]:)?/)
  })
})
