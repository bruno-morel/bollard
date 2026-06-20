import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  classifyDocPath,
  isDocAtHome,
  parseDocFrontMatter,
  resolveCuratableDocs,
  resolveCurateScope,
} from "../src/docs-resolver.js"

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

describe("parseDocFrontMatter", () => {
  it("returns undefined when no front-matter block", () => {
    expect(parseDocFrontMatter("# Title\n\nBody")).toBeUndefined()
  })

  it("parses curate: false as boolean", () => {
    expect(parseDocFrontMatter("---\ncurate: false\n---\n# Body")).toEqual({ curate: false })
  })

  it("parses tier: detect-only as string", () => {
    expect(parseDocFrontMatter("---\ntier: detect-only\n---\n# Body")).toEqual({
      tier: "detect-only",
    })
  })

  it("ignores unknown keys", () => {
    expect(parseDocFrontMatter("---\nstatus: Accepted\ntier: curate\n---\n# Body")).toEqual({
      tier: "curate",
    })
  })

  it("strips optional quotes from string values", () => {
    expect(parseDocFrontMatter('---\ntier: "detect-only"\n---\n# Body')).toEqual({
      tier: "detect-only",
    })
  })
})

describe("classifyDocPath", () => {
  it("classifies agent prompt path as never-touch (zone)", () => {
    const result = classifyDocPath("packages/agents/prompts/planner.md")
    expect(result.eligible).toBe(false)
    expect(result.tier).toBe("never-touch")
    expect(result.reason).toBe("exclusion zone")
  })

  it("classifies verify test fixtures as never-touch (zone)", () => {
    const result = classifyDocPath("packages/verify/tests/fixtures/docs-curation/spot-check.md")
    expect(result.eligible).toBe(false)
    expect(result.reason).toBe("exclusion zone")
  })

  it("classifies self-test results as never-touch (denylist)", () => {
    const result = classifyDocPath("spec/self-test-cap-results.md")
    expect(result.eligible).toBe(false)
    expect(result.tier).toBe("never-touch")
    expect(result.reason).toBe("content-class denylist")
  })

  it("classifies spec/01-architecture.md as detect-only", () => {
    const result = classifyDocPath("spec/01-architecture.md")
    expect(result.eligible).toBe(true)
    expect(result.tier).toBe("detect-only")
  })

  it("classifies README.md as curate", () => {
    const result = classifyDocPath("README.md")
    expect(result.eligible).toBe(true)
    expect(result.tier).toBe("curate")
  })

  it("honors curate: false front-matter marker", () => {
    const result = classifyDocPath("README.md", { frontMatter: { curate: false } })
    expect(result.eligible).toBe(false)
    expect(result.reason).toBe("front-matter curate: false")
  })

  it("front-matter tier overrides path-tier default", () => {
    const result = classifyDocPath("spec/01-architecture.md", {
      frontMatter: { tier: "curate" },
    })
    expect(result.eligible).toBe(true)
    expect(result.tier).toBe("curate")
    expect(result.reason).toBe("front-matter tier: curate")
  })

  it("tier on root doc overrides curate default", () => {
    const result = classifyDocPath("README.md", { frontMatter: { tier: "detect-only" } })
    expect(result.tier).toBe("detect-only")
  })
})

describe("isDocAtHome", () => {
  it("treats root-level docs as at home", () => {
    expect(isDocAtHome("README.md")).toBe(true)
    expect(isDocAtHome("CONTRIBUTING.md")).toBe(true)
  })

  it("treats docs under spec/ and docs/ as at home", () => {
    expect(isDocAtHome("spec/01-architecture.md")).toBe(true)
    expect(isDocAtHome("docs/context-hints.md")).toBe(true)
  })

  it("flags nested paths outside homes", () => {
    expect(isDocAtHome("packages/engine/notes.md")).toBe(false)
  })
})

describe("resolveCuratableDocs", () => {
  it("reads front-matter from disk for classification", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "docs-resolver-"))
    await writeFile(join(tempDir, "opt-out.md"), "---\ncurate: false\n---\n# Opt out\n", "utf-8")
    const results = await resolveCuratableDocs(tempDir)
    const optOut = results.find((r) => r.path === "opt-out.md")
    expect(optOut?.eligible).toBe(false)
    expect(optOut?.reason).toBe("front-matter curate: false")
  })
})

describe("resolveCurateScope", () => {
  it("splits editable curate tier from detect-only and excludes never-touch", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "docs-resolver-scope-"))
    await writeFile(join(tempDir, "README.md"), "# README\n", "utf-8")
    await writeFile(join(tempDir, "CONTRIBUTING.md"), "# Contributing\n", "utf-8")
    await mkdir(join(tempDir, "spec/adr"), { recursive: true })
    await writeFile(join(tempDir, "spec/01-architecture.md"), "# Architecture\n", "utf-8")
    await writeFile(join(tempDir, "spec/ROADMAP.md"), "# Roadmap\n", "utf-8")
    await mkdir(join(tempDir, "spec/archive"), { recursive: true })
    await writeFile(join(tempDir, "spec/archive/old.md"), "# Old\n", "utf-8")
    await mkdir(join(tempDir, "packages/engine"), { recursive: true })
    await writeFile(join(tempDir, "packages/engine/README.md"), "# Engine\n", "utf-8")

    const scope = await resolveCurateScope(tempDir)
    expect(scope.editable).toContain("README.md")
    expect(scope.editable).toContain("CONTRIBUTING.md")
    expect(scope.editable).toContain("packages/engine/README.md")
    expect(scope.detectOnly).toContain("spec/01-architecture.md")
    expect(scope.detectOnly).toContain("spec/ROADMAP.md")
    expect(scope.editable).not.toContain("spec/01-architecture.md")
    expect(scope.editable).not.toContain("spec/archive/old.md")
    expect(scope.detectOnly).not.toContain("spec/archive/old.md")
  })
})
