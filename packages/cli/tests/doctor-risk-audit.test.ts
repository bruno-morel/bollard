import { randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RunRecord } from "@bollard/engine/src/run-history.js"
import { FileRunHistoryStore, RUN_HISTORY_SCHEMA_VERSION } from "@bollard/engine/src/run-history.js"
import { afterEach, describe, expect, it } from "vitest"
import {
  checkHistoryHealth,
  formatDoctorReport,
  formatHistorySection,
  runDoctor,
} from "../src/doctor.js"

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

function envWithoutLlmKeys(): NodeJS.ProcessEnv {
  const copy = { ...process.env }
  copy.ANTHROPIC_API_KEY = undefined
  copy.OPENAI_API_KEY = undefined
  copy.GOOGLE_API_KEY = undefined
  return copy
}

async function createTempWorkspace(): Promise<string> {
  const dir = join(tmpdir(), `bollard-doctor-risk-${randomUUID()}`)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "tsconfig.json"), '{"compilerOptions":{}}', "utf-8")
  await writeFile(join(dir, "package.json"), "{}", "utf-8")
  return dir
}

function claimRun(runId: string, timestamp: number): RunRecord {
  return {
    type: "run",
    schemaVersion: RUN_HISTORY_SCHEMA_VERSION,
    runId,
    blueprintId: "implement-feature",
    task: "task",
    timestamp,
    status: "success",
    totalCostUsd: 1,
    totalDurationMs: 100,
    nodes: [{ id: "n1", name: "N1", type: "deterministic", status: "ok" }],
    testCount: { passed: 1, skipped: 0, failed: 0 },
    scopes: [
      { scope: "boundary", enabled: true, testsFailed: 1 },
      {
        scope: "contract",
        enabled: true,
        claimsProposed: 10,
        claimsGrounded: 7,
        testsFailed: 0,
      },
      { scope: "behavioral", enabled: false },
    ],
  }
}

describe("formatHistorySection concern yield and risk audit", () => {
  function baseHistory() {
    return {
      jsonlExists: true,
      jsonlRecordCount: 5,
      dbExists: false,
      dbCurrent: false,
      dbRecordCount: 0,
      costTrend: "stable" as const,
      recentFailingNodes: [],
    }
  }

  it("includes concern yield block when concernYield is present", () => {
    const out = formatHistorySection({
      ...baseHistory(),
      concernYield: {
        hasData: true,
        runCount: 5,
        concerns: [
          {
            concern: "security",
            activeRuns: 5,
            avgGroundingRate: 0.72,
            suggestion: "increase",
          },
        ],
      },
    })
    expect(out).toContain("Concern yield")
    expect(out).toContain("contract (security + performance proxy)")
    expect(out).toContain("72% avg grounding")
    expect(out).toContain("boundary: not enough data")
  })

  it("shows boundary not enough data without misleading 0% grounding", () => {
    const out = formatHistorySection({
      ...baseHistory(),
      concernYield: {
        hasData: true,
        runCount: 5,
        concerns: [
          {
            concern: "security",
            activeRuns: 5,
            avgGroundingRate: 0.5,
            suggestion: "keep",
          },
        ],
      },
    })
    expect(out).toContain("boundary: not enough data")
    expect(out).not.toMatch(/boundary.*0% avg grounding/)
  })

  it("includes risk audit block when riskAudit is present", () => {
    const out = formatHistorySection({
      ...baseHistory(),
      riskAudit: {
        minRunsRequired: 5,
        runCount: 6,
        hasData: true,
        scopes: [
          {
            scope: "boundary",
            runsWithFailures: 2,
            runsAlsoFailed: 2,
            correlationRate: 1,
            totalEnabledRuns: 6,
          },
          {
            scope: "contract",
            runsWithFailures: 0,
            runsAlsoFailed: 0,
            totalEnabledRuns: 6,
          },
          {
            scope: "behavioral",
            runsWithFailures: 0,
            runsAlsoFailed: 0,
            totalEnabledRuns: 0,
          },
        ],
      },
    })
    expect(out).toContain("Scope calibration (risk audit)")
    expect(out).toContain("100% correlated with run failure")
    expect(out).toContain("behavioral: insufficient data")
  })
})

const healthyRegistry = {
  deprecatedInUse: [] as const,
  staleEntries: [] as const,
  unknownInUse: [] as const,
}

describe("formatDoctorReport integration", () => {
  it("renders concern yield via formatDoctorReport", () => {
    const out = formatDoctorReport({
      allPassed: true,
      configNote: "using defaults",
      registryHealth: healthyRegistry,
      checks: [
        { id: "docker", label: "Docker", status: "pass", detail: "ok" },
        { id: "llm-key", label: "LLM API key", status: "pass", detail: "set: X" },
        { id: "toolchain", label: "Toolchain", status: "pass", detail: "typescript" },
      ],
      historyHealth: {
        jsonlExists: true,
        jsonlRecordCount: 5,
        dbExists: false,
        dbCurrent: false,
        dbRecordCount: 0,
        costTrend: "stable",
        recentFailingNodes: [],
        concernYield: {
          hasData: true,
          runCount: 5,
          concerns: [
            {
              concern: "security",
              activeRuns: 5,
              avgGroundingRate: 0.28,
              suggestion: "decrease",
            },
          ],
        },
      },
    })
    expect(out).toContain("Concern yield")
    expect(out).toContain("consider reducing weight")
  })
})

describe("runDoctor risk audit flag", () => {
  it("populates riskAudit when riskAudit option is true", async () => {
    tempDir = await createTempWorkspace()
    const report = await runDoctor(tempDir, envWithoutLlmKeys(), {
      history: true,
      riskAudit: true,
    })
    expect(report.historyHealth?.riskAudit).toBeDefined()
    expect(report.historyHealth?.riskAudit?.scopes).toHaveLength(3)
  })

  it("does not populate riskAudit without the flag", async () => {
    tempDir = await createTempWorkspace()
    const report = await runDoctor(tempDir, envWithoutLlmKeys(), { history: true })
    expect(report.historyHealth?.riskAudit).toBeUndefined()
  })
})

describe("checkHistoryHealth with fixture history", () => {
  it("populates riskAudit when flag is set", async () => {
    tempDir = await createTempWorkspace()
    const store = new FileRunHistoryStore(tempDir)
    for (let i = 0; i < 5; i++) {
      await store.record(claimRun(`run-${i}`, 1_700_000_000_000 + i))
    }
    const health = await checkHistoryHealth(tempDir, { riskAudit: true })
    expect(health.riskAudit).toBeDefined()
    expect(health.riskAudit?.hasData).toBe(true)
  })

  it("populates concernYield when enough claim data exists", async () => {
    tempDir = await createTempWorkspace()
    const store = new FileRunHistoryStore(tempDir)
    for (let i = 0; i < 5; i++) {
      await store.record(claimRun(`run-${i}`, 1_700_000_000_000 + i))
    }
    const health = await checkHistoryHealth(tempDir)
    expect(health.concernYield).toBeDefined()
    expect(health.concernYield?.hasData).toBe(true)
    expect(health.concernYield?.concerns.some((c) => c.concern === "security")).toBe(true)
  })
})
