import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { RunRecord } from "../src/run-history.js"
import {
  FileRunHistoryStore,
  RUN_HISTORY_SCHEMA_VERSION,
  parseHistoryLine,
} from "../src/run-history.js"

function minimalRun(overrides: Partial<RunRecord> & Pick<RunRecord, "runId">): RunRecord {
  return {
    type: "run",
    schemaVersion: RUN_HISTORY_SCHEMA_VERSION,
    blueprintId: "demo",
    task: "t",
    timestamp: 1_700_000_000_000,
    status: "success",
    totalCostUsd: 0,
    totalDurationMs: 100,
    nodes: [
      {
        id: "n1",
        name: "N1",
        type: "deterministic",
        status: "ok",
      },
    ],
    testCount: { passed: 1, skipped: 0, failed: 0 },
    scopes: [
      { scope: "boundary", enabled: true },
      { scope: "contract", enabled: false },
      { scope: "behavioral", enabled: false },
    ],
    ...overrides,
  }
}

describe("parseHistoryLine", () => {
  it("parses a stable schema v1 run line", () => {
    const line = JSON.stringify(minimalRun({ runId: "run-a", timestamp: 1_700_000_000_000 }))
    const rec = parseHistoryLine(line)
    expect(rec).not.toBeNull()
    expect(rec?.type).toBe("run")
    if (rec?.type === "run") {
      expect(rec.runId).toBe("run-a")
      expect(rec.schemaVersion).toBe(1)
      expect(rec.testCount.passed).toBe(1)
    }
  })

  it("returns null for unknown schemaVersion", () => {
    const line = JSON.stringify({ type: "run", schemaVersion: 99, runId: "x" })
    expect(parseHistoryLine(line)).toBeNull()
  })

  it("returns null for invalid JSON", () => {
    expect(parseHistoryLine("not json")).toBeNull()
  })
})

describe("FileRunHistoryStore", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bollard-rh-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("record and query round-trip", async () => {
    const store = new FileRunHistoryStore(dir)
    const r = minimalRun({ runId: "r1", timestamp: 10 })
    await store.record(r)
    const rows = await store.query({ limit: 10, offset: 0 })
    expect(rows).toHaveLength(1)
    const got = rows[0]
    expect(got?.type).toBe("run")
    if (got?.type === "run") {
      expect(got.runId).toBe("r1")
      expect(got.nodes).toEqual(r.nodes)
      expect(got.testCount).toEqual(r.testCount)
    }
  })

  it("findByRunId scans full file", async () => {
    const store = new FileRunHistoryStore(dir)
    await store.record(minimalRun({ runId: "old", timestamp: 1 }))
    await store.record(minimalRun({ runId: "new", timestamp: 2 }))
    const found = await store.findByRunId("old")
    expect(found?.type).toBe("run")
    if (found?.type === "run") expect(found.runId).toBe("old")
  })

  it("concurrent appends preserve all lines", async () => {
    const store = new FileRunHistoryStore(dir)
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.record(minimalRun({ runId: `c${i}`, timestamp: 100 + i })),
      ),
    )
    const all = await store.query({ limit: 100, offset: 0 })
    expect(all).toHaveLength(10)
    expect(new Set(all.map((r) => r.runId)).size).toBe(10)
  }, 15000)

  it("filters by blueprintId and status", async () => {
    const store = new FileRunHistoryStore(dir)
    await store.record(
      minimalRun({
        runId: "a1",
        blueprintId: "implement-feature",
        status: "success",
        timestamp: 1,
      }),
    )
    await store.record(
      minimalRun({ runId: "a2", blueprintId: "demo", status: "failure", timestamp: 2 }),
    )
    const impl = await store.query({ blueprintId: "implement-feature", limit: 50, offset: 0 })
    expect(impl).toHaveLength(1)
    if (impl[0]?.type === "run") expect(impl[0].runId).toBe("a1")

    const failed = await store.query({ status: "failure", limit: 50, offset: 0 })
    expect(failed).toHaveLength(1)
    if (failed[0]?.type === "run") expect(failed[0].runId).toBe("a2")
  })

  it("compare computes deltas", async () => {
    const store = new FileRunHistoryStore(dir)
    const ra = minimalRun({
      runId: "cmp-a",
      timestamp: 1,
      totalCostUsd: 1,
      totalDurationMs: 100,
      mutationScore: 50,
      nodes: [
        { id: "x", name: "X", type: "deterministic", status: "ok" },
        { id: "y", name: "Y", type: "deterministic", status: "fail" },
      ],
      scopes: [
        {
          scope: "boundary",
          enabled: true,
          claimsProposed: 2,
          claimsGrounded: 2,
          claimsDropped: 0,
        },
        { scope: "contract", enabled: false },
        { scope: "behavioral", enabled: false },
      ],
    })
    const rb = minimalRun({
      runId: "cmp-b",
      timestamp: 2,
      totalCostUsd: 3,
      totalDurationMs: 400,
      mutationScore: 60,
      nodes: [
        { id: "x", name: "X", type: "deterministic", status: "fail" },
        { id: "y", name: "Y", type: "deterministic", status: "ok" },
      ],
      scopes: [
        {
          scope: "boundary",
          enabled: true,
          claimsProposed: 3,
          claimsGrounded: 3,
          claimsDropped: 0,
        },
        { scope: "contract", enabled: false },
        { scope: "behavioral", enabled: false },
      ],
    })
    await store.record(ra)
    await store.record(rb)
    const cmp = await store.compare("cmp-a", "cmp-b")
    expect(cmp.delta.costUsd).toBe(2)
    expect(cmp.delta.durationMs).toBe(300)
    expect(cmp.delta.mutationScoreDelta).toBe(10)
    expect(cmp.delta.newFailingNodes).toContain("x")
    expect(cmp.delta.newPassingNodes).toContain("y")
    expect(
      cmp.delta.scopeChanges.some((c) => c.scope === "boundary" && c.field === "claimsProposed"),
    ).toBe(true)
  })

  it("compare rejects verify records", async () => {
    const store = new FileRunHistoryStore(dir)
    const v = {
      type: "verify" as const,
      schemaVersion: RUN_HISTORY_SCHEMA_VERSION,
      timestamp: 1,
      workDir: dir,
      source: "cli" as const,
      checks: [],
      allPassed: true,
      totalDurationMs: 0,
    }
    await store.record({ ...v, runId: "v1" })
    await store.record({ ...v, runId: "v2" })
    await expect(store.compare("v1", "v2")).rejects.toThrow(/pipeline run/)
  })
})
