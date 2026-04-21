import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BollardError } from "@bollard/engine/src/errors.js"
import { afterEach, describe, expect, it } from "vitest"
import { ALL_IDE_PLATFORMS, detectIdeEnvironment, parseIdePlatform } from "../src/ide-detect.js"

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

describe("detectIdeEnvironment", () => {
  it("returns empty array for empty directory", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ide-detect-"))
    expect(detectIdeEnvironment(tempDir)).toEqual([])
  })

  it("returns cursor when .cursor exists", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ide-detect-"))
    await mkdir(join(tempDir, ".cursor"), { recursive: true })
    expect(detectIdeEnvironment(tempDir)).toEqual(["cursor"])
  })

  it("returns claude-code when .claude exists", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ide-detect-"))
    await mkdir(join(tempDir, ".claude"), { recursive: true })
    expect(detectIdeEnvironment(tempDir)).toEqual(["claude-code"])
  })
})

describe("parseIdePlatform", () => {
  it("returns single platform for cursor", () => {
    expect(parseIdePlatform("cursor")).toEqual(["cursor"])
  })

  it("returns all platforms for all", () => {
    expect(parseIdePlatform("all")).toEqual([...ALL_IDE_PLATFORMS])
  })

  it("throws BollardError IDE_CONFIG_INVALID for invalid value", () => {
    expect(() => parseIdePlatform("invalid")).toThrow(BollardError)
    try {
      parseIdePlatform("invalid")
    } catch (e) {
      expect(BollardError.is(e) && e.code).toBe("IDE_CONFIG_INVALID")
    }
  })
})
