import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createSqliteIndex } from "../src/run-history-db.js"
import type { RunRecord, VerifyRecord } from "../src/run-history.js"
import { RUN_HISTORY_SCHEMA_VERSION } from "../src/run-history.js"

function makeRunRecord(overrides?: Partial<RunRecord>): RunRecord {
  return {
    type: "run",
    schemaVersion: RUN_HISTORY_SCHEMA_VERSION,
    runId: `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    blueprintId: "implement-feature",
    task: "test task",
    timestamp: Date.now(),
    status: "success",
    totalCostUsd: 1.0,
    totalDurationMs: 60_000,
    nodes: [],
    testCount: { passed: 100, skipped: 2, failed: 0 },
    scopes: [],
    ...overrides,
  }
}

function makeVerify(overrides?: Partial<VerifyRecord>): VerifyRecord {
  return {
    type: "verify",
    schemaVersion: RUN_HISTORY_SCHEMA_VERSION,
    runId: `verify-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    workDir: "/tmp/w",
    source: "cli",
    checks: [{ name: "lint", passed: true, durationMs: 10 }],
    allPassed: true,
    totalDurationMs: 10,
    ...overrides,
  }
}

describe("createSqliteIndex", () => {
  let dir: string
  let dbPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bollard-rhdb-"))
    dbPath = join(dir, "t.db")
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("creates schema on fresh db without error", () => {
    const idx = createSqliteIndex(dbPath)
    expect(() => idx.recordCount()).not.toThrow()
    idx.close()
  })

  it("insert + query round-trip RunRecord", () => {
    const idx = createSqliteIndex(dbPath)
    const r = makeRunRecord({
      runId: "r1",
      timestamp: 1000,
      nodes: [{ id: "n1", name: "N1", type: "deterministic", status: "ok" }],
      scopes: [
        {
          scope: "boundary",
          enabled: true,
          claimsProposed: 1,
          claimsGrounded: 1,
          claimsDropped: 0,
        },
      ],
    })
    idx.insert(r)
    const rows = idx.query({ limit: 10, offset: 0 })
    expect(rows).toHaveLength(1)
    const got = rows[0]
    expect(got?.type).toBe("run")
    if (got?.type === "run") {
      expect(got.runId).toBe("r1")
      expect(got.nodes).toEqual(r.nodes)
      expect(got.scopes).toEqual(r.scopes)
    }
    idx.close()
  })

  it("insert + query round-trip VerifyRecord", () => {
    const idx = createSqliteIndex(dbPath)
    const v = makeVerify({ runId: "v1", timestamp: 2000, allPassed: false })
    idx.insert(v)
    const rows = idx.query({ limit: 10, offset: 0 })
    expect(rows).toHaveLength(1)
    const got = rows[0]
    expect(got?.type).toBe("verify")
    if (got?.type === "verify") {
      expect(got.runId).toBe("v1")
      expect(got.allPassed).toBe(false)
    }
    idx.close()
  })

  it("filter since and until", () => {
    const idx = createSqliteIndex(dbPath)
    idx.insert(makeRunRecord({ runId: "a", timestamp: 100 }))
    idx.insert(makeRunRecord({ runId: "b", timestamp: 200 }))
    idx.insert(makeRunRecord({ runId: "c", timestamp: 300 }))
    expect(idx.query({ since: 150, limit: 50, offset: 0 }).map((r) => r.runId)).toEqual(["c", "b"])
    expect(idx.query({ until: 199, limit: 50, offset: 0 }).map((r) => r.runId)).toEqual(["a"])
    idx.close()
  })

  it("filter status for runs and verify", () => {
    const idx = createSqliteIndex(dbPath)
    idx.insert(makeRunRecord({ runId: "ok-run", status: "success", timestamp: 1 }))
    idx.insert(makeRunRecord({ runId: "bad-run", status: "failure", timestamp: 2 }))
    idx.insert(makeVerify({ runId: "bad-v", timestamp: 3, allPassed: false }))
    idx.insert(makeVerify({ runId: "ok-v", timestamp: 4, allPassed: true }))
    const succ = idx.query({ status: "success", limit: 50, offset: 0 })
    expect(succ.map((r) => r.runId).sort()).toEqual(["ok-run", "ok-v"])
    const fail = idx.query({ status: "failure", limit: 50, offset: 0 })
    expect(fail.map((r) => r.runId).sort()).toEqual(["bad-run", "bad-v"])
    idx.close()
  })

  it("filter blueprintId", () => {
    const idx = createSqliteIndex(dbPath)
    idx.insert(makeRunRecord({ runId: "x", blueprintId: "demo", timestamp: 1 }))
    idx.insert(makeRunRecord({ runId: "y", blueprintId: "implement-feature", timestamp: 2 }))
    const rows = idx.query({ blueprintId: "demo", limit: 50, offset: 0 })
    expect(rows).toHaveLength(1)
    if (rows[0]?.type === "run") expect(rows[0].runId).toBe("x")
    idx.close()
  })

  it("limit and offset pagination", () => {
    const idx = createSqliteIndex(dbPath)
    for (let i = 0; i < 5; i++) {
      idx.insert(makeRunRecord({ runId: `p${i}`, timestamp: i + 1 }))
    }
    expect(idx.query({ limit: 2, offset: 0 }).map((r) => r.runId)).toEqual(["p4", "p3"])
    expect(idx.query({ limit: 2, offset: 2 }).map((r) => r.runId)).toEqual(["p2", "p1"])
    idx.close()
  })

  it("findByRunId finds existing and undefined for missing", () => {
    const idx = createSqliteIndex(dbPath)
    idx.insert(makeRunRecord({ runId: "exists", timestamp: 1 }))
    expect(idx.findByRunId("exists")?.runId).toBe("exists")
    expect(idx.findByRunId("nope")).toBeUndefined()
    idx.close()
  })

  it("summary aggregates runs", () => {
    const idx = createSqliteIndex(dbPath)
    idx.insert(
      makeRunRecord({
        runId: "s1",
        timestamp: 1,
        status: "success",
        totalCostUsd: 1,
        totalDurationMs: 100,
        testCount: { passed: 10, skipped: 0, failed: 0 },
        mutationScore: 70,
      }),
    )
    idx.insert(
      makeRunRecord({
        runId: "s2",
        timestamp: 2,
        status: "failure",
        totalCostUsd: 3,
        totalDurationMs: 300,
        testCount: { passed: 5, skipped: 1, failed: 2 },
        mutationScore: 72,
      }),
    )
    const s = idx.summary()
    expect(s.totalRuns).toBe(2)
    expect(s.successRate).toBe(0.5)
    expect(s.avgCostUsd).toBe(2)
    expect(s.avgDurationMs).toBe(200)
    expect(s.avgMutationScore).toBeCloseTo(71, 5)
    idx.close()
  })

  it("summary with since excludes older", () => {
    const idx = createSqliteIndex(dbPath)
    idx.insert(makeRunRecord({ runId: "old", timestamp: 10, totalCostUsd: 1, totalDurationMs: 10 }))
    idx.insert(
      makeRunRecord({ runId: "new", timestamp: 1000, totalCostUsd: 5, totalDurationMs: 50 }),
    )
    const s = idx.summary({ since: 100 })
    expect(s.totalRuns).toBe(1)
    expect(s.avgCostUsd).toBe(5)
    idx.close()
  })

  it("summary with since and until includes only runs in window", () => {
    const idx = createSqliteIndex(dbPath)
    idx.insert(
      makeRunRecord({ runId: "early", timestamp: 100, totalCostUsd: 1, totalDurationMs: 10 }),
    )
    idx.insert(
      makeRunRecord({ runId: "mid", timestamp: 200, totalCostUsd: 2, totalDurationMs: 20 }),
    )
    idx.insert(
      makeRunRecord({ runId: "late", timestamp: 300, totalCostUsd: 3, totalDurationMs: 30 }),
    )
    const s = idx.summary({ since: 100, until: 200 })
    expect(s.totalRuns).toBe(2)
    expect(s.avgCostUsd).toBe(1.5)
    idx.close()
  })

  it("summary byBlueprint groups", () => {
    const idx = createSqliteIndex(dbPath)
    idx.insert(
      makeRunRecord({
        runId: "a",
        blueprintId: "bp-a",
        status: "success",
        totalCostUsd: 2,
        timestamp: 1,
      }),
    )
    idx.insert(
      makeRunRecord({
        runId: "b",
        blueprintId: "bp-a",
        status: "failure",
        totalCostUsd: 4,
        timestamp: 2,
      }),
    )
    idx.insert(
      makeRunRecord({
        runId: "c",
        blueprintId: "bp-b",
        status: "success",
        totalCostUsd: 6,
        timestamp: 3,
      }),
    )
    const s = idx.summary()
    expect(s.byBlueprint["bp-a"]?.runs).toBe(2)
    expect(s.byBlueprint["bp-a"]?.successRate).toBe(0.5)
    expect(s.byBlueprint["bp-a"]?.avgCostUsd).toBe(3)
    expect(s.byBlueprint["bp-b"]?.runs).toBe(1)
    idx.close()
  })

  it("costTrend stable with flat costs", () => {
    const idx = createSqliteIndex(dbPath)
    for (let i = 0; i < 4; i++) {
      idx.insert(
        makeRunRecord({ runId: `f${i}`, timestamp: i, totalCostUsd: 1, totalDurationMs: 1 }),
      )
    }
    expect(idx.summary().costTrend).toBe("stable")
    idx.close()
  })

  it("costTrend increasing when later costs higher", () => {
    const idx = createSqliteIndex(dbPath)
    idx.insert(makeRunRecord({ runId: "l0", timestamp: 0, totalCostUsd: 1, totalDurationMs: 1 }))
    idx.insert(makeRunRecord({ runId: "l1", timestamp: 1, totalCostUsd: 1, totalDurationMs: 1 }))
    idx.insert(makeRunRecord({ runId: "l2", timestamp: 2, totalCostUsd: 1, totalDurationMs: 1 }))
    idx.insert(makeRunRecord({ runId: "l3", timestamp: 3, totalCostUsd: 10, totalDurationMs: 1 }))
    idx.insert(makeRunRecord({ runId: "l4", timestamp: 4, totalCostUsd: 10, totalDurationMs: 1 }))
    expect(idx.summary().costTrend).toBe("increasing")
    idx.close()
  })

  it("rebuild returns runCount and durationMs", () => {
    const idx = createSqliteIndex(dbPath)
    const recs = [
      makeRunRecord({ runId: "a", timestamp: 1 }),
      makeRunRecord({ runId: "b", timestamp: 2 }),
    ]
    const out = idx.rebuild(recs)
    expect(out.runCount).toBe(2)
    expect(out.durationMs).toBeGreaterThanOrEqual(0)
    expect(idx.recordCount()).toBe(2)
    idx.close()
  })

  it("rebuild clears stale data", () => {
    const idx = createSqliteIndex(dbPath)
    idx.insert(makeRunRecord({ runId: "gone", timestamp: 1 }))
    idx.rebuild([makeRunRecord({ runId: "only", timestamp: 2 })])
    expect(idx.findByRunId("gone")).toBeUndefined()
    expect(idx.findByRunId("only")?.runId).toBe("only")
    expect(idx.recordCount()).toBe(1)
    idx.close()
  })

  it("recordCount tracks inserts", () => {
    const idx = createSqliteIndex(dbPath)
    expect(idx.recordCount()).toBe(0)
    idx.insert(makeRunRecord({ runId: "c1", timestamp: 1 }))
    expect(idx.recordCount()).toBe(1)
    idx.insert(makeVerify({ runId: "v1", timestamp: 2 }))
    expect(idx.recordCount()).toBe(2)
    idx.close()
  })

  describe("purge", () => {
    it("purge with no matching records returns { purged: 0 } and leaves existing records intact", () => {
      const idx = createSqliteIndex(dbPath)

      // Insert some records with timestamps after the purge cutoff
      idx.insert(makeRunRecord({ runId: "r1", timestamp: 2000 }))
      idx.insert(makeRunRecord({ runId: "r2", timestamp: 3000 }))
      idx.insert(makeVerify({ runId: "v1", timestamp: 2500 }))

      // Purge records before timestamp 1000 (no matches)
      const result = idx.purge(1000)

      expect(result.purged).toBe(0)
      expect(idx.recordCount()).toBe(3)
      expect(idx.findByRunId("r1")).toBeDefined()
      expect(idx.findByRunId("r2")).toBeDefined()
      expect(idx.findByRunId("v1")).toBeDefined()

      idx.close()
    })

    it("purge all records when all timestamps are older than before", () => {
      const idx = createSqliteIndex(dbPath)

      // Insert records with timestamps before the purge cutoff
      idx.insert(makeRunRecord({ runId: "r1", timestamp: 1000 }))
      idx.insert(makeRunRecord({ runId: "r2", timestamp: 1500 }))
      idx.insert(makeVerify({ runId: "v1", timestamp: 800 }))

      expect(idx.recordCount()).toBe(3)

      // Purge records before timestamp 2000 (all should be deleted)
      const result = idx.purge(2000)

      expect(result.purged).toBe(3)
      expect(idx.recordCount()).toBe(0)
      expect(idx.findByRunId("r1")).toBeUndefined()
      expect(idx.findByRunId("r2")).toBeUndefined()
      expect(idx.findByRunId("v1")).toBeUndefined()

      idx.close()
    })

    it("purge preserving newer records - insert 3 records with timestamps 1000, 2000, 3000, purge before 2500, verify only the 3000 record survives", () => {
      const idx = createSqliteIndex(dbPath)

      // Insert records with specific timestamps
      idx.insert(
        makeRunRecord({
          runId: "r1",
          timestamp: 1000,
          nodes: [{ id: "n1", name: "Node1", type: "deterministic", status: "ok" }],
          scopes: [
            {
              scope: "test",
              enabled: true,
              claimsProposed: 1,
              claimsGrounded: 1,
              claimsDropped: 0,
            },
          ],
        }),
      )
      idx.insert(
        makeRunRecord({
          runId: "r2",
          timestamp: 2000,
          nodes: [{ id: "n2", name: "Node2", type: "deterministic", status: "ok" }],
          scopes: [
            {
              scope: "test",
              enabled: true,
              claimsProposed: 2,
              claimsGrounded: 2,
              claimsDropped: 0,
            },
          ],
        }),
      )
      idx.insert(
        makeRunRecord({
          runId: "r3",
          timestamp: 3000,
          nodes: [{ id: "n3", name: "Node3", type: "deterministic", status: "ok" }],
          scopes: [
            {
              scope: "test",
              enabled: true,
              claimsProposed: 3,
              claimsGrounded: 3,
              claimsDropped: 0,
            },
          ],
        }),
      )

      expect(idx.recordCount()).toBe(3)

      // Purge records before timestamp 2500 (should delete r1 and r2, keep r3)
      const result = idx.purge(2500)

      expect(result.purged).toBe(2)
      expect(idx.recordCount()).toBe(1)
      expect(idx.findByRunId("r1")).toBeUndefined()
      expect(idx.findByRunId("r2")).toBeUndefined()

      const surviving = idx.findByRunId("r3")
      expect(surviving).toBeDefined()
      expect(surviving?.timestamp).toBe(3000)

      idx.close()
    })

    it("purge updates recordCount metadata correctly after deletion", () => {
      const idx = createSqliteIndex(dbPath)

      // Insert multiple records
      idx.insert(makeRunRecord({ runId: "r1", timestamp: 1000 }))
      idx.insert(makeRunRecord({ runId: "r2", timestamp: 2000 }))
      idx.insert(makeRunRecord({ runId: "r3", timestamp: 3000 }))
      idx.insert(makeVerify({ runId: "v1", timestamp: 1500 }))
      idx.insert(makeVerify({ runId: "v2", timestamp: 2500 }))

      expect(idx.recordCount()).toBe(5)

      // Purge records before timestamp 2200 (should delete r1, r2, v1)
      const result = idx.purge(2200)

      expect(result.purged).toBe(3)
      expect(idx.recordCount()).toBe(2)

      // Verify the remaining records
      expect(idx.findByRunId("r1")).toBeUndefined()
      expect(idx.findByRunId("r2")).toBeUndefined()
      expect(idx.findByRunId("v1")).toBeUndefined()
      expect(idx.findByRunId("r3")).toBeDefined()
      expect(idx.findByRunId("v2")).toBeDefined()

      // Purge the rest
      const result2 = idx.purge(4000)
      expect(result2.purged).toBe(2)
      expect(idx.recordCount()).toBe(0)

      idx.close()
    })
  })
})
