import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { findWorkspaceRoot } from "../src/workspace-root.js"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

describe("findWorkspaceRoot", () => {
  it("returns start when no marker is found anywhere up the tree", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bollard-ws-root-"))
    const deep = join(tempDir, "a", "b", "c")
    await mkdir(deep, { recursive: true })
    expect(findWorkspaceRoot(deep)).toBe(deep)
  })

  it("walks up to pnpm-workspace.yaml", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bollard-ws-root-"))
    const root = tempDir
    const deep = join(root, "a", "b", "c")
    await mkdir(deep, { recursive: true })
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n", "utf-8")
    expect(findWorkspaceRoot(deep)).toBe(root)
  })

  it("walks up to go.work", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bollard-ws-root-"))
    const root = tempDir
    const deep = join(root, "a", "b", "c")
    await mkdir(deep, { recursive: true })
    await writeFile(join(root, "go.work"), "go 1.22\n", "utf-8")
    expect(findWorkspaceRoot(deep)).toBe(root)
  })

  it("walks up to Cargo.toml", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bollard-ws-root-"))
    const root = tempDir
    const deep = join(root, "a", "b", "c")
    await mkdir(deep, { recursive: true })
    await writeFile(join(root, "Cargo.toml"), "[workspace]\nmembers = []\n", "utf-8")
    expect(findWorkspaceRoot(deep)).toBe(root)
  })

  it("finds the bollard repo root from packages/cli", () => {
    const cliDir = resolve(REPO_ROOT, "packages/cli")
    expect(findWorkspaceRoot(cliDir)).toBe(REPO_ROOT)
  })
})
