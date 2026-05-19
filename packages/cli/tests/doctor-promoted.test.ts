import { randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type HistoryHealth, checkHistoryHealth, formatDoctorReport } from "../src/doctor.js"

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

async function createTempWorkspace(): Promise<string> {
  const dir = join(tmpdir(), `bollard-doctor-promoted-${randomUUID()}`)
  await mkdir(dir, { recursive: true })
  return dir
}

describe("checkHistoryHealth promoted manifest", () => {
  it("returns manifestExists=false and promotedCount=0 when .bollard/promoted.json is absent", async () => {
    tempDir = await createTempWorkspace()
    const health = await checkHistoryHealth(tempDir)
    expect(health.promotedManifestHealth).toBeDefined()
    expect(health.promotedManifestHealth?.manifestExists).toBe(false)
    expect(health.promotedManifestHealth?.promotedCount).toBe(0)
    expect(health.promotedManifestHealth?.lastPromotedAt).toBeUndefined()
  })

  it("returns correct count and lastPromotedAt when manifest has entries", async () => {
    tempDir = await createTempWorkspace()
    const bollardDir = join(tempDir, ".bollard")
    await mkdir(bollardDir, { recursive: true })
    const earlier = Date.now() - 60_000
    const latest = Date.now()
    const manifest = {
      schemaVersion: 1,
      promoted: [
        {
          hash: "a".repeat(64),
          promotedAt: earlier,
          sourcePath: ".bollard/tests/boundary/foo.test.ts",
          destPath: "packages/foo/tests/foo.promoted.test.ts",
        },
        {
          hash: "b".repeat(64),
          promotedAt: latest,
          sourcePath: ".bollard/tests/contract/bar.contract.test.ts",
          destPath: "packages/bar/tests/bar.promoted.test.ts",
        },
      ],
    }
    await writeFile(
      join(bollardDir, "promoted.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf-8",
    )

    const health = await checkHistoryHealth(tempDir)
    expect(health.promotedManifestHealth).toBeDefined()
    expect(health.promotedManifestHealth?.manifestExists).toBe(true)
    expect(health.promotedManifestHealth?.promotedCount).toBe(2)
    expect(health.promotedManifestHealth?.lastPromotedAt).toBe(latest)
  })
})

describe("formatDoctorReport promoted manifest section", () => {
  function baseHistory(): HistoryHealth {
    return {
      jsonlExists: true,
      jsonlRecordCount: 1,
      dbExists: false,
      dbCurrent: false,
      dbRecordCount: 0,
      costTrend: "stable",
      recentFailingNodes: [],
    }
  }

  it("renders promoted-tests line whether the count is zero or non-zero", () => {
    const baseReport = {
      allPassed: true,
      configNote: "using defaults" as const,
      checks: [
        { id: "docker" as const, label: "Docker", status: "pass" as const, detail: "ok" },
        {
          id: "llm-key" as const,
          label: "LLM API key",
          status: "pass" as const,
          detail: "set: X",
        },
        {
          id: "toolchain" as const,
          label: "Toolchain",
          status: "pass" as const,
          detail: "typescript",
        },
      ],
    }

    const emptyOut = formatDoctorReport({
      ...baseReport,
      historyHealth: {
        ...baseHistory(),
        promotedManifestHealth: { manifestExists: false, promotedCount: 0 },
      },
    })
    expect(emptyOut).toContain("No promoted tests")

    const nonEmptyOut = formatDoctorReport({
      ...baseReport,
      historyHealth: {
        ...baseHistory(),
        promotedManifestHealth: {
          manifestExists: true,
          promotedCount: 3,
          lastPromotedAt: Date.now() - 5_000,
        },
      },
    })
    expect(nonEmptyOut).toContain("Promoted tests:")
    expect(nonEmptyOut).toContain("3")
  })
})
