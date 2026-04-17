import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ProbeDefinition } from "@bollard/engine/src/blueprint.js"
import { describe, expect, it } from "vitest"

import { DefaultProbeScheduler } from "../src/probe-scheduler.js"

function probe(id: string): ProbeDefinition {
  return {
    id,
    name: "n",
    endpoint: "/",
    method: "GET",
    assertions: [{ type: "status", expected: 200 }],
    intervalSeconds: 3600,
    riskTier: "low",
  }
}

describe("DefaultProbeScheduler", () => {
  it("loadProbes reads json files", async () => {
    const root = join(process.cwd(), `.bollard-sched-${Date.now()}`)
    await mkdir(join(root, ".bollard", "probes"), { recursive: true })
    await writeFile(
      join(root, ".bollard", "probes", "probe-a.json"),
      JSON.stringify(probe("probe-a")),
      "utf-8",
    )
    const s = new DefaultProbeScheduler({ workDir: root })
    const loaded = await s.loadProbes()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.id).toBe("probe-a")
    await rm(root, { recursive: true, force: true })
  })

  it("watch stop clears intervals", async () => {
    const root = join(process.cwd(), `.bollard-sched2-${Date.now()}`)
    await mkdir(join(root, ".bollard", "probes"), { recursive: true })
    await writeFile(join(root, ".bollard", "probes", "p.json"), JSON.stringify(probe("p")), "utf-8")
    const s = new DefaultProbeScheduler({ workDir: root })
    const h = s.watch("http://127.0.0.1:9", () => {})
    await new Promise((r) => setTimeout(r, 50))
    h.stop()
    await rm(root, { recursive: true, force: true })
  })
})
