import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CostBaseline } from "@bollard/engine/src/cost-baseline.js"
import type { RunRecord } from "@bollard/engine/src/run-history.js"
import { FileRunHistoryStore, RUN_HISTORY_SCHEMA_VERSION } from "@bollard/engine/src/run-history.js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runCostBaselineCommand } from "../src/cost-baseline.js"

let workDir: string | undefined

function minimalRun(
  overrides: Partial<RunRecord> & Pick<RunRecord, "runId" | "timestamp" | "totalCostUsd">,
): RunRecord {
  return {
    type: "run",
    schemaVersion: RUN_HISTORY_SCHEMA_VERSION,
    blueprintId: "implement-feature",
    task: "t",
    status: "success",
    totalDurationMs: 100,
    nodes: [],
    testCount: { passed: 1, skipped: 0, failed: 0 },
    scopes: [
      { scope: "boundary", enabled: true },
      { scope: "contract", enabled: false },
      { scope: "behavioral", enabled: false },
    ],
    ...overrides,
  }
}

afterEach(async () => {
  if (workDir) {
    await rm(workDir, { recursive: true, force: true })
    workDir = undefined
  }
  vi.restoreAllMocks()
})

describe("runCostBaselineCommand", () => {
  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "bollard-cli-cb-"))
    await mkdir(join(workDir, ".bollard", "runs"), { recursive: true })
  })

  it("tag writes baseline from most recent successful implement-feature run", async () => {
    const store = new FileRunHistoryStore(workDir as string)
    await store.record(
      minimalRun({
        runId: "older",
        timestamp: 10,
        totalCostUsd: 9.99,
        blueprintId: "implement-feature",
      }),
    )
    await store.record(
      minimalRun({
        runId: "newer",
        timestamp: 20,
        totalCostUsd: 2.5,
        blueprintId: "implement-feature",
      }),
    )
    await runCostBaselineCommand(["tag", "from-latest", "--threshold", "12"], workDir as string)
    const raw = await readFile(join(workDir as string, ".bollard", "cost-baseline.json"), "utf-8")
    const b = JSON.parse(raw) as CostBaseline
    expect(b.tag).toBe("from-latest")
    expect(b.runId).toBe("newer")
    expect(b.totalCostUsd).toBe(2.5)
    expect(b.thresholdPct).toBe(12)
  })

  it("tag --run-id writes baseline from that run", async () => {
    const store = new FileRunHistoryStore(workDir as string)
    await store.record(
      minimalRun({
        runId: "pick-me",
        timestamp: 100,
        totalCostUsd: 4.2,
        blueprintId: "implement-feature",
      }),
    )
    await store.record(
      minimalRun({
        runId: "other",
        timestamp: 200,
        totalCostUsd: 1,
        blueprintId: "implement-feature",
      }),
    )
    await runCostBaselineCommand(["tag", "pinned", "--run-id", "pick-me"], workDir as string)
    const raw = await readFile(join(workDir as string, ".bollard", "cost-baseline.json"), "utf-8")
    const b = JSON.parse(raw) as CostBaseline
    expect(b.runId).toBe("pick-me")
    expect(b.totalCostUsd).toBe(4.2)
  })

  it("show prints baseline table to stderr", async () => {
    const baseline: CostBaseline = {
      tag: "show-me",
      runId: "rid",
      timestamp: 1_700_000_000_000,
      blueprintId: "implement-feature",
      totalCostUsd: 1.23,
      thresholdPct: 10,
    }
    await mkdir(join(workDir as string, ".bollard"), { recursive: true })
    await writeFile(
      join(workDir as string, ".bollard", "cost-baseline.json"),
      `${JSON.stringify(baseline, null, 2)}\n`,
      "utf-8",
    )
    const chunks: string[] = []
    vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => {
      chunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf-8"))
      return true
    })
    await runCostBaselineCommand(["show"], workDir as string)
    const out = chunks.join("")
    expect(out).toContain("show-me")
    expect(out).toContain("rid")
    expect(out).toContain("$1.2300")
  })

  it("diff exits 0 with PASS when within threshold", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)
    const baseline: CostBaseline = {
      tag: "ref",
      runId: "baseline-run",
      timestamp: 1000,
      blueprintId: "implement-feature",
      totalCostUsd: 10,
      thresholdPct: 20,
    }
    await mkdir(join(workDir as string, ".bollard"), { recursive: true })
    await writeFile(
      join(workDir as string, ".bollard", "cost-baseline.json"),
      `${JSON.stringify(baseline, null, 2)}\n`,
      "utf-8",
    )
    const store = new FileRunHistoryStore(workDir as string)
    for (let i = 0; i < 3; i++) {
      await store.record(
        minimalRun({
          runId: `r-${String(i)}`,
          timestamp: 2000 + i,
          totalCostUsd: 10,
          blueprintId: "implement-feature",
        }),
      )
    }
    const chunks: string[] = []
    vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => {
      chunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf-8"))
      return true
    })
    await runCostBaselineCommand(["diff"], workDir as string)
    expect(exitSpy).not.toHaveBeenCalled()
    expect(chunks.join("")).toMatch(/PASS/)
  })

  it("diff exits 1 on FAIL when regression exceeds threshold", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${String(code ?? 0)}`)
    }) as (code?: string | number | null | undefined) => never)
    const baseline: CostBaseline = {
      tag: "ref",
      runId: "baseline-run",
      timestamp: 1000,
      blueprintId: "implement-feature",
      totalCostUsd: 2,
      thresholdPct: 15,
    }
    await mkdir(join(workDir as string, ".bollard"), { recursive: true })
    await writeFile(
      join(workDir as string, ".bollard", "cost-baseline.json"),
      `${JSON.stringify(baseline, null, 2)}\n`,
      "utf-8",
    )
    const store = new FileRunHistoryStore(workDir as string)
    for (let i = 0; i < 3; i++) {
      await store.record(
        minimalRun({
          runId: `x-${String(i)}`,
          timestamp: 3000 + i,
          totalCostUsd: 3,
          blueprintId: "implement-feature",
        }),
      )
    }
    await expect(runCostBaselineCommand(["diff"], workDir as string)).rejects.toThrow("EXIT:1")
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it("diff exits 0 with insufficient_data when fewer than 3 runs since baseline", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)
    const baseline: CostBaseline = {
      tag: "ref",
      runId: "baseline-run",
      timestamp: 9_000_000_000_000,
      blueprintId: "implement-feature",
      totalCostUsd: 2.5592,
      thresholdPct: 15,
    }
    await mkdir(join(workDir as string, ".bollard"), { recursive: true })
    await writeFile(
      join(workDir as string, ".bollard", "cost-baseline.json"),
      `${JSON.stringify(baseline, null, 2)}\n`,
      "utf-8",
    )
    const store = new FileRunHistoryStore(workDir as string)
    await store.record(
      minimalRun({
        runId: "only-one",
        timestamp: 9_000_000_000_001,
        totalCostUsd: 3,
        blueprintId: "implement-feature",
      }),
    )
    const chunks: string[] = []
    vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => {
      chunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf-8"))
      return true
    })
    await runCostBaselineCommand(["diff"], workDir as string)
    expect(exitSpy).not.toHaveBeenCalled()
    const out = chunks.join("")
    expect(out).toMatch(/INSUFFICIENT DATA/)
    expect(out).toMatch(/insufficient data/)
  })
})
