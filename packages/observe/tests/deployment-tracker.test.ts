import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { FileDeploymentTracker } from "../src/deployment-tracker.js"

describe("FileDeploymentTracker", () => {
  it("records and reads current", async () => {
    const root = join(process.cwd(), `.bollard-deploy-${Date.now()}`)
    await mkdir(root, { recursive: true })
    const tr = new FileDeploymentTracker(root)
    await tr.record({
      deploymentId: "abc",
      timestamp: 1,
      sourceRunIds: [],
      relatedCommits: ["abc"],
      environment: "staging",
    })
    const cur = await tr.getCurrent()
    expect(cur?.deploymentId).toBe("abc")
    await rm(root, { recursive: true, force: true })
  })

  it("getHistory returns reverse order", async () => {
    const root = join(process.cwd(), `.bollard-deploy2-${Date.now()}`)
    await mkdir(root, { recursive: true })
    const tr = new FileDeploymentTracker(root)
    await tr.record({
      deploymentId: "a",
      timestamp: 1,
      sourceRunIds: [],
      relatedCommits: [],
      environment: "p",
    })
    await tr.record({
      deploymentId: "b",
      timestamp: 2,
      sourceRunIds: [],
      relatedCommits: [],
      environment: "p",
    })
    const h = await tr.getHistory(10)
    expect(h[0]?.deploymentId).toBe("b")
    await rm(root, { recursive: true, force: true })
  })
})
