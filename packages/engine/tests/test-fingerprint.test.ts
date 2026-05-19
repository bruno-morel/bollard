import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  extractFingerprint,
  isAlreadyPromoted,
  readPromotedManifest,
  writePromotedManifest,
} from "../src/test-fingerprint.js"

describe("extractFingerprint", () => {
  it("returns stable hash for identical content", () => {
    const content = `import { describe, it, expect } from "vitest"
describe("x", () => {
  it("rejects null", () => {
    expect(fn(null)).rejects.toThrow()
  })
})
`
    const a = extractFingerprint("cost-tracker.boundary.test.ts", content, "boundary")
    const b = extractFingerprint("cost-tracker.boundary.test.ts", content, "boundary")
    expect(a.hash).toBe(b.hash)
    expect(a.assertionTypes).toEqual(b.assertionTypes)
    expect(a.inputPatterns).toEqual(b.inputPatterns)
  })

  it("returns same hash when variable names differ but assertion types match", () => {
    const a = extractFingerprint("mod.test.ts", "expect(foo(null)).rejects.toThrow()", "boundary")
    const b = extractFingerprint("mod.test.ts", "expect(bar(null)).rejects.toThrow()", "boundary")
    expect(a.hash).toBe(b.hash)
  })

  it("detects null and undefined input patterns", () => {
    const fp = extractFingerprint(
      "mod.test.ts",
      "expect(x(null)).toBe(0)\nexpect(y(undefined)).toThrow()",
      "boundary",
    )
    expect(fp.inputPatterns).toContain("null")
    expect(fp.inputPatterns).toContain("undefined")
  })

  it("sorts assertionTypes and inputPatterns before hashing", () => {
    const contentA = "expect(a).toBe(1)\nexpect(b(null)).rejects\nexpect(c).toThrow()"
    const contentB = "expect(c).toThrow()\nexpect(b(null)).rejects\nexpect(a).toBe(1)"
    const fpA = extractFingerprint("mod.test.ts", contentA, "contract")
    const fpB = extractFingerprint("mod.test.ts", contentB, "contract")
    expect(fpA.assertionTypes).toEqual([...fpA.assertionTypes].sort())
    expect(fpA.inputPatterns).toEqual([...fpA.inputPatterns].sort())
    expect(fpA.hash).toBe(fpB.hash)
  })
})

describe("promoted manifest", () => {
  let workDir: string

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "bollard-fp-"))
  })

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  it("readPromotedManifest returns empty manifest for nonexistent file", async () => {
    const manifest = await readPromotedManifest(workDir)
    expect(manifest).toEqual({ schemaVersion: 1, promoted: [] })
  })

  it("writePromotedManifest round-trips with readPromotedManifest", async () => {
    const entry = {
      hash: "abc123",
      promotedAt: Date.now(),
      sourcePath: ".bollard/tests/boundary/x.test.ts",
      destPath: "tests/x.test.ts",
    }
    const written = { schemaVersion: 1 as const, promoted: [entry] }
    await writePromotedManifest(workDir, written)
    const read = await readPromotedManifest(workDir)
    expect(read.schemaVersion).toBe(1)
    expect(read.promoted).toHaveLength(1)
    expect(read.promoted[0]?.hash).toBe(entry.hash)
    expect(read.promoted[0]?.sourcePath).toBe(entry.sourcePath)
  })

  it("isAlreadyPromoted returns true when hash is in manifest", () => {
    const manifest = {
      schemaVersion: 1 as const,
      promoted: [
        {
          hash: "deadbeef",
          promotedAt: 1,
          sourcePath: "a",
          destPath: "b",
        },
      ],
    }
    expect(isAlreadyPromoted(manifest, "deadbeef")).toBe(true)
  })

  it("isAlreadyPromoted returns false when hash is absent", () => {
    const manifest = { schemaVersion: 1 as const, promoted: [] }
    expect(isAlreadyPromoted(manifest, randomUUID())).toBe(false)
  })
})
