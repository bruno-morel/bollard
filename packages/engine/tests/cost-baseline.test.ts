import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { compareToBaseline, readBaseline, writeBaseline } from "../src/cost-baseline.js"
import type {
  HistoryFilter,
  HistoryRecord,
  RunComparison,
  RunHistoryStore,
  RunRecord,
  RunSummary,
} from "../src/run-history.js"
import { RUN_HISTORY_SCHEMA_VERSION } from "../src/run-history.js"

function minimalRun(
  overrides: Partial<RunRecord> & Pick<RunRecord, "runId" | "timestamp">,
): RunRecord {
  return {
    type: "run",
    schemaVersion: RUN_HISTORY_SCHEMA_VERSION,
    blueprintId: "implement-feature",
    task: "t",
    timestamp: overrides.timestamp,
    status: "success",
    totalCostUsd: 1,
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

class MockHistoryStore implements RunHistoryStore {
  constructor(private readonly records: HistoryRecord[]) {}

  async record(): Promise<void> {
    throw new Error("MockHistoryStore.record not used")
  }

  async query(filter?: HistoryFilter): Promise<HistoryRecord[]> {
    let out = [...this.records]
    if (filter?.blueprintId !== undefined) {
      out = out.filter((r) => r.type === "run" && r.blueprintId === filter.blueprintId)
    }
    if (filter?.since !== undefined) {
      out = out.filter((r) => r.timestamp >= filter.since)
    }
    return out
  }

  async findByRunId(): Promise<HistoryRecord | undefined> {
    return undefined
  }

  async compare(): Promise<RunComparison> {
    throw new Error("not implemented")
  }

  async summary(): Promise<RunSummary> {
    throw new Error("not implemented")
  }

  async rebuild(): Promise<{ runCount: number; durationMs: number }> {
    throw new Error("not implemented")
  }
}

describe("readBaseline", () => {
  it("returns null when file missing", async () => {
    const path = join(tmpdir(), `missing-baseline-${Date.now()}.json`)
    await expect(readBaseline(path)).resolves.toBeNull()
  })
})

describe("writeBaseline / readBaseline", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bollard-cb-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("round-trips all fields", async () => {
    const file = join(dir, "cost-baseline.json")
    const baseline = {
      tag: "t1",
      runId: "run-1",
      timestamp: 1_700_000_000_000,
      blueprintId: "implement-feature",
      totalCostUsd: 2.5592,
      coderTurns: 47,
      avgInputTokensPerTurn: 16_596,
      thresholdPct: 15,
      notes: "n",
    }
    await writeBaseline(file, baseline)
    const got = await readBaseline(file)
    expect(got).toEqual(baseline)
  })
})

describe("compareToBaseline", () => {
  const baseline = {
    tag: "ref",
    runId: "old",
    timestamp: 1000,
    blueprintId: "implement-feature",
    totalCostUsd: 2,
    thresholdPct: 15,
  }

  it("returns insufficient_data when no runs since baseline", async () => {
    const store = new MockHistoryStore([
      minimalRun({ runId: "a", timestamp: 500, totalCostUsd: 5 }),
    ])
    const cmp = await compareToBaseline(baseline, store)
    expect(cmp.verdict).toBe("insufficient_data")
    expect(cmp.current.runCount).toBe(0)
    expect(cmp.passed).toBe(true)
  })

  it("returns insufficient_data when only 2 runs since baseline", async () => {
    const store = new MockHistoryStore([
      minimalRun({ runId: "a", timestamp: 1000, totalCostUsd: 2 }),
      minimalRun({ runId: "b", timestamp: 1001, totalCostUsd: 2 }),
    ])
    const cmp = await compareToBaseline(baseline, store)
    expect(cmp.verdict).toBe("insufficient_data")
    expect(cmp.current.runCount).toBe(2)
  })

  it("passes with correct regressionPct when 3 runs within threshold", async () => {
    const store = new MockHistoryStore([
      minimalRun({ runId: "a", timestamp: 1000, totalCostUsd: 2 }),
      minimalRun({ runId: "b", timestamp: 1001, totalCostUsd: 2 }),
      minimalRun({ runId: "c", timestamp: 1002, totalCostUsd: 2.3 }),
    ])
    const cmp = await compareToBaseline(baseline, store)
    expect(cmp.verdict).toBe("pass")
    expect(cmp.passed).toBe(true)
    expect(cmp.current.runCount).toBe(3)
    expect(cmp.current.avgCostUsd).toBeCloseTo(2.1, 5)
    expect(cmp.regressionPct).toBeCloseTo(5, 5)
  })

  it("fails when 3 runs exceed threshold", async () => {
    const store = new MockHistoryStore([
      minimalRun({ runId: "a", timestamp: 1000, totalCostUsd: 2.6 }),
      minimalRun({ runId: "b", timestamp: 1001, totalCostUsd: 2.6 }),
      minimalRun({ runId: "c", timestamp: 1002, totalCostUsd: 2.6 }),
    ])
    const cmp = await compareToBaseline(baseline, store)
    expect(cmp.verdict).toBe("fail")
    expect(cmp.passed).toBe(false)
    expect(cmp.current.avgCostUsd).toBeCloseTo(2.6, 5)
    expect(cmp.regressionPct).toBeCloseTo(30, 5)
  })

  it("treats cost decrease as negative regressionPct and pass", async () => {
    const store = new MockHistoryStore([
      minimalRun({ runId: "a", timestamp: 1000, totalCostUsd: 1.8 }),
      minimalRun({ runId: "b", timestamp: 1001, totalCostUsd: 1.8 }),
      minimalRun({ runId: "c", timestamp: 1002, totalCostUsd: 1.8 }),
    ])
    const cmp = await compareToBaseline(baseline, store)
    expect(cmp.verdict).toBe("pass")
    expect(cmp.regressionPct).toBeCloseTo(-10, 5)
  })
})
