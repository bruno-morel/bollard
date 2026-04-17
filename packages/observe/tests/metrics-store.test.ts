import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { FileMetricsStore } from "../src/metrics-store.js"
import type { ProbeResult } from "../src/providers/types.js"

function result(id: string, ts: number, pass: boolean): ProbeResult {
  return {
    probeId: id,
    timestamp: ts,
    status: pass ? "pass" : "fail",
    assertions: [],
    latencyMs: 10,
  }
}

describe("FileMetricsStore", () => {
  it("records and queries by probe id", async () => {
    const root = join(process.cwd(), `.bollard-metrics-test-${Date.now()}`)
    await mkdir(root, { recursive: true })
    const store = new FileMetricsStore({ workDir: root, retentionDays: 30 })
    const t = Date.now()
    await store.record(result("a", t, true))
    await store.record(result("a", t + 1, false))
    const q = await store.query("a", t - 1)
    expect(q).toHaveLength(2)
    await rm(root, { recursive: true, force: true })
  })

  it("summary aggregates latency", async () => {
    const root = join(process.cwd(), `.bollard-metrics-sum-${Date.now()}`)
    await mkdir(root, { recursive: true })
    const store = new FileMetricsStore({ workDir: root, retentionDays: 30 })
    const t = Date.now()
    for (let i = 0; i < 5; i++) {
      await store.record({ ...result("p", t + i, true), latencyMs: (i + 1) * 10 })
    }
    const s = await store.summary("p", 60_000)
    expect(s.total).toBe(5)
    expect(s.passed).toBe(5)
    expect(s.avgLatencyMs).toBeGreaterThan(0)
    await rm(root, { recursive: true, force: true })
  })
})
