import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { findNearestTsconfig, runStrykerPreflight } from "../src/mutation.js"

describe("runStrykerPreflight", () => {
  it("returns null for empty files list", async () => {
    const result = await runStrykerPreflight("/tmp", [])
    expect(result).toBeNull()
  })

  it("returns null for non-TS files", async () => {
    const result = await runStrykerPreflight("/tmp", ["src/main.go"])
    expect(result).toBeNull()
  })

  it("returns error string when tsc fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bollard-preflight-"))
    const tempFile = join(dir, "broken.ts")
    await writeFile(tempFile, "const x = (", "utf-8")

    const result = await runStrykerPreflight(dir, [tempFile])

    expect(result).not.toBeNull()
    expect(result).toContain("tsc preflight failed")
  })

  it("finds tsconfig.json when present in the file's parent directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bollard-preflight-tsconfig-"))
    const tsconfigPath = join(dir, "tsconfig.json")
    await writeFile(tsconfigPath, JSON.stringify({ compilerOptions: { strict: true } }), "utf-8")
    const result = findNearestTsconfig(join(dir, "src", "foo.ts"), dir)
    // No tsconfig in src/ — should find the one in dir
    // Note: src/ doesn't exist but findNearestTsconfig only checks dirname, not existence
    expect(result).toBe(tsconfigPath)
  })

  it("returns null when no tsconfig.json exists between file and root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bollard-preflight-noconfig-"))
    const result = findNearestTsconfig(join(dir, "src", "foo.ts"), dir)
    expect(result).toBeNull()
  })
})
