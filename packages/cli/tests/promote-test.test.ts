import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { readPromotedManifest } from "@bollard/engine/src/test-fingerprint.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { promoteTest, rewriteImportsForPromotion } from "../src/promote-test.js"

describe("rewriteImportsForPromotion", () => {
  it("adjusts relative imports correctly when moving up one directory", () => {
    const workDir = "/app"
    const from = join(workDir, ".bollard/tests/boundary/foo.boundary.test.ts")
    const to = join(workDir, "tests/foo.boundary.test.ts")
    const content = `import { CostTracker } from "../../../packages/engine/src/cost-tracker.js"
import { describe, it, expect } from "vitest"
`
    const out = rewriteImportsForPromotion(content, from, to)
    expect(out).toContain('from "../packages/engine/src/cost-tracker.js"')
    expect(out).toContain('from "vitest"')
  })

  it("leaves @bollard/ package imports unchanged", () => {
    const from = "/app/.bollard/tests/boundary/x.test.ts"
    const to = "/app/tests/x.test.ts"
    const content = `import { BollardError } from "@bollard/engine/src/errors.js"
`
    const out = rewriteImportsForPromotion(content, from, to)
    expect(out).toBe(content)
  })

  it("handles no-import files without error", () => {
    const content = `describe("x", () => { it("works", () => {}) })`
    const out = rewriteImportsForPromotion(content, "/a/b.test.ts", "/c/d.test.ts")
    expect(out).toBe(content)
  })
})

describe("promoteTest", () => {
  let workDir: string

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "bollard-promote-"))
    await mkdir(join(workDir, ".bollard", "tests", "boundary"), { recursive: true })
  })

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  it("copies file, strips markers, writes promoted.json", async () => {
    const rel = ".bollard/tests/boundary/sample.boundary.test.ts"
    const sourceContent = `// @bollard-generated adversarial boundary test
import { describe, it, expect } from "vitest"
import { fn } from "../../packages/core/src/fn.js"

describe("sample", () => {
  it("rejects null", () => {
    expect(fn(null)).rejects.toThrow()
  })
})
`
    await writeFile(resolve(workDir, rel), sourceContent, "utf-8")

    const result = await promoteTest(workDir, rel)
    expect(result.alreadyPromoted).toBe(false)
    expect(result.destRel).toBe("tests/sample.boundary.test.ts")

    const destContent = await readFile(result.destPath, "utf-8")
    expect(destContent).not.toContain("@bollard-generated")
    expect(destContent).toContain("expect(fn(null)).rejects.toThrow()")

    const manifest = await readPromotedManifest(workDir)
    expect(manifest.promoted).toHaveLength(1)
    expect(manifest.promoted[0]?.hash).toBe(result.fingerprintHash)
    expect(manifest.promoted[0]?.sourcePath).toBe(rel)
    expect(manifest.promoted[0]?.destPath).toBe("tests/sample.boundary.test.ts")

    const second = await promoteTest(workDir, rel)
    expect(second.alreadyPromoted).toBe(true)
  })
})
