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
  it("returns start directory when no root marker found", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ws-root-"))
    const sub = join(tempDir, "a", "b")
    await mkdir(sub, { recursive: true })
    expect(findWorkspaceRoot(sub)).toBe(sub)
  })

  it("walks up to pnpm-workspace.yaml", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ws-root-"))
    await writeFile(join(tempDir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf-8")
    const sub = join(tempDir, "packages", "cli")
    await mkdir(sub, { recursive: true })
    expect(findWorkspaceRoot(sub)).toBe(tempDir)
  })

  it("walks up to .bollard.yml", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ws-root-"))
    await writeFile(
      join(tempDir, ".bollard.yml"),
      "adversarial:\n  boundary:\n    enabled: true\n",
      "utf-8",
    )
    const sub = join(tempDir, "src", "lib")
    await mkdir(sub, { recursive: true })
    expect(findWorkspaceRoot(sub)).toBe(tempDir)
  })

  it("walks up to go.work", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ws-root-"))
    await writeFile(join(tempDir, "go.work"), "go 1.22\nuse ./cmd\n", "utf-8")
    const sub = join(tempDir, "cmd", "server")
    await mkdir(sub, { recursive: true })
    expect(findWorkspaceRoot(sub)).toBe(tempDir)
  })

  it("walks up to Cargo.toml", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ws-root-"))
    await writeFile(join(tempDir, "Cargo.toml"), '[workspace]\nmembers = ["crates/*"]\n', "utf-8")
    const sub = join(tempDir, "crates", "core", "src")
    await mkdir(sub, { recursive: true })
    expect(findWorkspaceRoot(sub)).toBe(tempDir)
  })

  it("walks up to nx.json", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ws-root-"))
    await writeFile(join(tempDir, "nx.json"), "{}\n", "utf-8")
    const sub = join(tempDir, "apps", "web")
    await mkdir(sub, { recursive: true })
    expect(findWorkspaceRoot(sub)).toBe(tempDir)
  })

  it("finds bollard repo root from packages/cli", () => {
    const cliDir = join(REPO_ROOT, "packages", "cli")
    expect(findWorkspaceRoot(cliDir)).toBe(REPO_ROOT)
  })
})
