import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  readWorkspacePackageRoots,
  resolveWorkspaceSpecifier,
  workspacePackageIdFromImportSpec,
} from "../src/workspace-resolver.js"

const testsDir = dirname(fileURLToPath(import.meta.url))
const here = join(testsDir, "fixtures", "workspace-resolver")

describe("workspacePackageIdFromImportSpec", () => {
  it("maps scoped subpath to package id", () => {
    expect(workspacePackageIdFromImportSpec("@scope/pkg")).toBe("@scope/pkg")
    expect(workspacePackageIdFromImportSpec("@scope/pkg/sub/x.js")).toBe("@scope/pkg")
  })

  it("returns undefined for non-scoped", () => {
    expect(workspacePackageIdFromImportSpec("lodash")).toBeUndefined()
    expect(workspacePackageIdFromImportSpec("./rel")).toBeUndefined()
  })
})

describe("resolveWorkspaceSpecifier", () => {
  it("returns undefined when package is not in workspace map", async () => {
    const m = new Map<string, string>()
    expect(await resolveWorkspaceSpecifier("@unknown/pkg", m)).toBeUndefined()
  })

  it("resolves package root via exports string", async () => {
    const root = join(here, "exports-string")
    const m = await readWorkspacePackageRoots(root)
    const abs = await resolveWorkspaceSpecifier("@wr/a", m)
    expect(abs).toBeDefined()
    expect(abs?.endsWith("index.ts")).toBe(true)
  })

  it("resolves subpath with .js to .ts", async () => {
    const root = join(here, "subpath")
    const m = await readWorkspacePackageRoots(root)
    const abs = await resolveWorkspaceSpecifier("@wr/b/src/lib.js", m)
    expect(abs).toBeDefined()
    expect(abs?.includes("lib.ts")).toBe(true)
  })

  it("falls back to main when exports missing", async () => {
    const root = join(here, "legacy-main")
    const m = await readWorkspacePackageRoots(root)
    const abs = await resolveWorkspaceSpecifier("@wr/legacy", m)
    expect(abs).toBeDefined()
    expect(abs?.endsWith("old.ts")).toBe(true)
  })
})

describe("readWorkspacePackageRoots", () => {
  it("returns empty map when pnpm-workspace.yaml is missing", async () => {
    const m = await readWorkspacePackageRoots(
      join(testsDir, "fixtures", "context-expansion", "linear"),
    )
    expect(m.size).toBe(0)
  })
})
