import { execFile } from "node:child_process"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

import { FileDeploymentTracker } from "../src/deployment-tracker.js"
import { GitDriftDetector } from "../src/drift-detector.js"

const execFileAsync = promisify(execFile)

async function git(repo: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", repo, ...args])
}

async function gitInitIdentity(repo: string): Promise<void> {
  await git(repo, ["config", "user.email", "bollard@test.local"])
  await git(repo, ["config", "user.name", "Bollard Test"])
}

describe("GitDriftDetector", () => {
  it("reports no drift when shas match", async () => {
    const root = join(process.cwd(), `.bollard-drift-${Date.now()}`)
    await mkdir(root, { recursive: true })
    await git(root, ["init", "-b", "main"])
    await gitInitIdentity(root)
    await writeFile(join(root, "a.txt"), "1", "utf-8")
    await git(root, ["add", "."])
    await git(root, ["commit", "-m", "init", "--no-gpg-sign"])
    const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])
    const sha = stdout.trim()
    await mkdir(join(root, ".bollard", "observe"), { recursive: true })
    await writeFile(
      join(root, ".bollard", "observe", "last-verified.json"),
      JSON.stringify({ sha }),
      "utf-8",
    )
    const dep = new FileDeploymentTracker(root)
    await dep.record({
      deploymentId: sha,
      timestamp: Date.now(),
      sourceRunIds: [],
      relatedCommits: [sha],
      environment: "p",
    })
    const det = new GitDriftDetector({ workDir: root, deploymentTracker: dep })
    const r = await det.check()
    expect(r.hasDrift).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  it("detects drift when files differ between commits", async () => {
    const root = join(process.cwd(), `.bollard-drift2-${Date.now()}`)
    await mkdir(root, { recursive: true })
    await git(root, ["init", "-b", "main"])
    await gitInitIdentity(root)
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "x.ts"), "export const x = 1\n", "utf-8")
    await git(root, ["add", "."])
    await git(root, ["commit", "-m", "c1", "--no-gpg-sign"])
    const { stdout: s1 } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])
    const verified = s1.trim()
    await writeFile(join(root, "src", "x.ts"), "export const x = 2\n", "utf-8")
    await git(root, ["add", "."])
    await git(root, ["commit", "-m", "c2", "--no-gpg-sign"])
    const { stdout: s2 } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])
    const deployed = s2.trim()
    await mkdir(join(root, ".bollard", "observe"), { recursive: true })
    await writeFile(
      join(root, ".bollard", "observe", "last-verified.json"),
      JSON.stringify({ sha: verified }),
      "utf-8",
    )
    const dep = new FileDeploymentTracker(root)
    await dep.record({
      deploymentId: deployed,
      timestamp: Date.now(),
      sourceRunIds: [],
      relatedCommits: [deployed],
      environment: "p",
    })
    const det = new GitDriftDetector({ workDir: root, deploymentTracker: dep })
    const r = await det.check()
    expect(r.hasDrift).toBe(true)
    expect(r.driftedFiles.length).toBeGreaterThan(0)
    await rm(root, { recursive: true, force: true })
  })
})
