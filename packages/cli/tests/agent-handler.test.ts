import type { BollardConfig, PipelineContext } from "@bollard/engine/src/context.js"
import { CostTracker } from "@bollard/engine/src/cost-tracker.js"
import { beforeEach, describe, expect, it, vi } from "vitest"

const readFileMock = vi.hoisted(() => vi.fn().mockResolvedValue("preloaded"))

vi.mock("node:fs/promises", async (importOriginal) => {
  const act = await importOriginal<typeof import("node:fs/promises")>()
  return { ...act, readFile: readFileMock }
})

import { preloadAffectedFiles } from "../src/agent-handler.js"

function makeCtx(plan: unknown, results: PipelineContext["results"] = {}): PipelineContext {
  const config: BollardConfig = {
    llm: { default: { provider: "mock", model: "m" } },
    agent: { max_cost_usd: 10, max_duration_minutes: 30 },
  }
  return {
    runId: "r",
    task: "t",
    blueprintId: "implement-feature",
    config,
    results,
    changedFiles: [],
    costTracker: new CostTracker(10),
    startedAt: 0,
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    upgradeRunId: vi.fn(),
    plan,
  }
}

describe("preloadAffectedFiles", () => {
  const workDir = "/proj"

  beforeEach(() => {
    readFileMock.mockClear()
    readFileMock.mockResolvedValue("preloaded")
  })

  it("prefers expand-affected-files expanded list over plan modify", async () => {
    const ctx = makeCtx(
      { affected_files: { modify: ["legacy.ts"] } },
      {
        "expand-affected-files": {
          status: "ok",
          data: {
            expanded: {
              files: ["a.ts", "b.ts"],
              fanInScores: {},
              source: "import-graph",
            },
          },
        },
      },
    )
    const out = await preloadAffectedFiles(ctx, workDir)
    expect(out).toContain("a.ts")
    expect(out).toContain("b.ts")
    expect(out).not.toContain("legacy.ts")
    expect(readFileMock).toHaveBeenCalled()
  })

  it("falls back to plan.affected_files.modify when expand is absent", async () => {
    const ctx = makeCtx({ affected_files: { modify: ["only.ts"] } }, {})
    const out = await preloadAffectedFiles(ctx, workDir)
    expect(out).toContain("only.ts")
  })

  it("falls back when expanded.files is empty", async () => {
    const ctx = makeCtx(
      { affected_files: { modify: ["p.ts"] } },
      {
        "expand-affected-files": {
          status: "ok",
          data: { expanded: { files: [], fanInScores: {}, source: "passthrough" } },
        },
      },
    )
    const out = await preloadAffectedFiles(ctx, workDir)
    expect(out).toContain("p.ts")
  })
})
