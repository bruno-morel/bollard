import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { FileFlagProvider, emergencyKillFlag } from "../src/flag-manager.js"

describe("FileFlagProvider", () => {
  it("set get list roundtrip", async () => {
    const root = join(process.cwd(), `.bollard-flag-${Date.now()}`)
    await mkdir(root, { recursive: true })
    const p = new FileFlagProvider(root)
    await p.set("f1", {
      id: "f1",
      enabled: true,
      percent: 50,
      updatedAt: 1,
      updatedBy: "human",
    })
    const g = await p.get("f1")
    expect(g?.percent).toBe(50)
    const all = await p.list()
    expect(all).toHaveLength(1)
    await rm(root, { recursive: true, force: true })
  })

  it("emergencyKillFlag throws FLAG_NOT_FOUND for missing", async () => {
    const root = join(process.cwd(), `.bollard-flag2-${Date.now()}`)
    await mkdir(root, { recursive: true })
    const p = new FileFlagProvider(root)
    await expect(emergencyKillFlag(p, "nope")).rejects.toMatchObject({ code: "FLAG_NOT_FOUND" })
    await rm(root, { recursive: true, force: true })
  })

  it("emergencyKillFlag disables flag", async () => {
    const root = join(process.cwd(), `.bollard-flag3-${Date.now()}`)
    await mkdir(root, { recursive: true })
    const p = new FileFlagProvider(root)
    await p.set("x", {
      id: "x",
      enabled: true,
      percent: 100,
      updatedAt: 1,
      updatedBy: "human",
    })
    await emergencyKillFlag(p, "x")
    const g = await p.get("x")
    expect(g?.enabled).toBe(false)
    expect(g?.percent).toBe(0)
    await rm(root, { recursive: true, force: true })
  })
})
