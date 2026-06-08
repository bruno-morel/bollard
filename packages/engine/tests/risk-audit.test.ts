import { describe, expect, it } from "vitest"
import type { RunRecord } from "../src/run-history.js"
import {
  computeConcernYield,
  computeScopeCalibration,
  RUN_HISTORY_SCHEMA_VERSION,
} from "../src/run-history.js"

function minimalRun(overrides: Partial<RunRecord> & Pick<RunRecord, "runId">): RunRecord {
  return {
    type: "run",
    schemaVersion: RUN_HISTORY_SCHEMA_VERSION,
    blueprintId: "implement-feature",
    task: "t",
    timestamp: 1_700_000_000_000,
    status: "success",
    totalCostUsd: 1,
    totalDurationMs: 100,
    nodes: [{ id: "n1", name: "N1", type: "deterministic", status: "ok" }],
    testCount: { passed: 1, skipped: 0, failed: 0 },
    scopes: [
      { scope: "boundary", enabled: true },
      { scope: "contract", enabled: false },
      { scope: "behavioral", enabled: false },
    ],
    ...overrides,
  }
}

function scopePatch(
  run: RunRecord,
  scope: "boundary" | "contract" | "behavioral",
  patch: Partial<RunRecord["scopes"][number]>,
): RunRecord {
  return {
    ...run,
    scopes: run.scopes.map((s) => (s.scope === scope ? { ...s, ...patch } : s)),
  }
}

describe("computeScopeCalibration", () => {
  it("returns hasData=false when fewer than 5 runs", () => {
    const runs = Array.from({ length: 4 }, (_, i) =>
      minimalRun({ runId: `run-${i}`, timestamp: i }),
    )
    const report = computeScopeCalibration(runs)
    expect(report.hasData).toBe(false)
    expect(report.runCount).toBe(4)
    expect(report.scopes).toHaveLength(3)
  })

  it("computes correlationRate when scope test failures align with run failure", () => {
    const runs = Array.from({ length: 5 }, (_, i) => {
      let run = minimalRun({ runId: `run-${i}`, timestamp: i, status: "success" })
      if (i < 2) {
        run = scopePatch(run, "boundary", { enabled: true, testsFailed: 1 })
        run = { ...run, status: "failure" }
      } else {
        run = scopePatch(run, "boundary", { enabled: true, testsFailed: 0 })
      }
      return run
    })
    const boundary = computeScopeCalibration(runs).scopes.find((s) => s.scope === "boundary")
    expect(boundary?.runsWithFailures).toBe(2)
    expect(boundary?.runsAlsoFailed).toBe(2)
    expect(boundary?.correlationRate).toBe(1)
  })

  it("leaves correlationRate undefined when no scope test failures", () => {
    const runs = Array.from({ length: 5 }, (_, i) =>
      minimalRun({ runId: `run-${i}`, timestamp: i }),
    )
    const boundary = computeScopeCalibration(runs).scopes.find((s) => s.scope === "boundary")
    expect(boundary?.runsWithFailures).toBe(0)
    expect(boundary?.correlationRate).toBeUndefined()
  })

  it("computes avgGroundingRate from contract claim counts", () => {
    const runs = [
      scopePatch(minimalRun({ runId: "r1" }), "contract", {
        enabled: true,
        claimsProposed: 10,
        claimsGrounded: 8,
      }),
      scopePatch(minimalRun({ runId: "r2" }), "contract", {
        enabled: true,
        claimsProposed: 10,
        claimsGrounded: 6,
      }),
      ...Array.from({ length: 3 }, (_, i) => minimalRun({ runId: `pad-${i}`, timestamp: i + 10 })),
    ]
    const contract = computeScopeCalibration(runs).scopes.find((s) => s.scope === "contract")
    expect(contract?.avgGroundingRate).toBeCloseTo(0.7)
  })
})

describe("computeConcernYield", () => {
  it("returns hasData=false when fewer than 5 runs with claim data", () => {
    const runs = [
      scopePatch(minimalRun({ runId: "r1" }), "contract", {
        enabled: true,
        claimsProposed: 10,
        claimsGrounded: 5,
      }),
    ]
    const report = computeConcernYield(runs)
    expect(report.hasData).toBe(false)
    expect(report.runCount).toBe(1)
  })

  it("suggests decrease when avg grounding is below 30%", () => {
    const runs = Array.from({ length: 5 }, (_, i) =>
      scopePatch(minimalRun({ runId: `run-${i}`, timestamp: i }), "contract", {
        enabled: true,
        claimsProposed: 10,
        claimsGrounded: 2,
      }),
    )
    const entry = computeConcernYield(runs).concerns.find((c) => c.concern === "security")
    expect(entry?.suggestion).toBe("decrease")
    expect(entry?.avgGroundingRate).toBeCloseTo(0.2)
  })

  it("suggests increase when avg grounding is above 70%", () => {
    const runs = Array.from({ length: 5 }, (_, i) =>
      scopePatch(minimalRun({ runId: `run-${i}`, timestamp: i }), "behavioral", {
        enabled: true,
        claimsProposed: 10,
        claimsGrounded: 8,
      }),
    )
    const entry = computeConcernYield(runs).concerns.find((c) => c.concern === "resilience")
    expect(entry?.suggestion).toBe("increase")
    expect(entry?.avgGroundingRate).toBeCloseTo(0.8)
  })

  it("suggests keep for mid-range grounding and omits disabled scopes", () => {
    const runs = Array.from({ length: 5 }, (_, i) =>
      scopePatch(minimalRun({ runId: `run-${i}`, timestamp: i }), "contract", {
        enabled: true,
        claimsProposed: 10,
        claimsGrounded: 5,
      }),
    )
    const report = computeConcernYield(runs)
    const contract = report.concerns.find((c) => c.concern === "security")
    expect(contract?.suggestion).toBe("keep")
    expect(report.concerns.find((c) => c.concern === "correctness")).toBeUndefined()
  })

  it("omits boundary entry when only test counts exist without claims", () => {
    const runs = Array.from({ length: 5 }, (_, i) =>
      scopePatch(minimalRun({ runId: `run-${i}`, timestamp: i }), "boundary", {
        enabled: true,
        testsFailed: 2,
        testsPassed: 1,
      }),
    )
    const report = computeConcernYield(runs)
    expect(report.hasData).toBe(false)
    expect(report.concerns.find((c) => c.concern === "correctness")).toBeUndefined()
  })

  it("returns empty concerns when all scopes disabled", () => {
    const runs = Array.from({ length: 5 }, (_, i) =>
      minimalRun({
        runId: `run-${i}`,
        timestamp: i,
        scopes: [
          { scope: "boundary", enabled: false },
          { scope: "contract", enabled: false },
          { scope: "behavioral", enabled: false },
        ],
      }),
    )
    const report = computeConcernYield(runs)
    expect(report.hasData).toBe(false)
    expect(report.concerns).toHaveLength(0)
  })
})
