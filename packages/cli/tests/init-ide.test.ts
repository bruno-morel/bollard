import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultAdversarialConfig } from "@bollard/detect/src/concerns.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { afterEach, describe, expect, it } from "vitest"
import { ALL_IDE_PLATFORMS } from "../src/ide-detect.js"
import { generateIdeConfigs, mergeJsonFile, writeGeneratedFiles } from "../src/init-ide.js"

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

function minimalProfile(): ToolchainProfile {
  return {
    language: "typescript",
    checks: {},
    sourcePatterns: [],
    testPatterns: [],
    ignorePatterns: [],
    allowedCommands: [],
    adversarial: defaultAdversarialConfig({ language: "typescript" }),
  }
}

describe("mergeJsonFile", () => {
  it("produces merged JSON when file does not exist", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "init-ide-"))
    const path = join(tempDir, "new.json")
    const merged = await mergeJsonFile(path, { foo: { bar: 1 } })
    expect(JSON.parse(merged)).toEqual({ foo: { bar: 1 } })
  })

  it("deep-merges into existing JSON (e.g. mcpServers)", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "init-ide-"))
    const path = join(tempDir, "mcp.json")
    await writeFile(
      path,
      JSON.stringify({
        mcpServers: { existing: { command: "echo", args: [] } },
      }),
      "utf-8",
    )
    const merged = await mergeJsonFile(path, {
      mcpServers: {
        bollard: { command: "pnpm", args: ["x"] },
      },
    })
    const parsed = JSON.parse(merged) as {
      mcpServers: Record<string, { command: string; args: string[] }>
    }
    expect(parsed.mcpServers.existing).toEqual({ command: "echo", args: [] })
    expect(parsed.mcpServers.bollard).toEqual({ command: "pnpm", args: ["x"] })
  })
})

describe("writeGeneratedFiles", () => {
  it("writes new files", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "init-ide-"))
    const { written, skipped } = await writeGeneratedFiles(tempDir, {
      platform: "cursor",
      files: [{ path: "a/b.txt", content: "hello" }],
      messages: [],
    })
    expect(written).toEqual(["a/b.txt"])
    expect(skipped).toEqual([])
    expect(await readFile(join(tempDir, "a/b.txt"), "utf-8")).toBe("hello")
  })

  it("skips existing files when merge is not set", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "init-ide-"))
    const p = join(tempDir, "x.txt")
    await writeFile(p, "original", "utf-8")
    const { written, skipped } = await writeGeneratedFiles(tempDir, {
      platform: "cursor",
      files: [{ path: "x.txt", content: "new" }],
      messages: [],
    })
    expect(written).toEqual([])
    expect(skipped).toEqual(["x.txt"])
    expect(await readFile(p, "utf-8")).toBe("original")
  })

  it("merges JSON when merge is true and file exists", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "init-ide-"))
    const rel = "cfg.json"
    await writeFile(join(tempDir, rel), JSON.stringify({ a: 1 }), "utf-8")
    const { written } = await writeGeneratedFiles(tempDir, {
      platform: "cursor",
      files: [{ path: rel, content: JSON.stringify({ b: 2 }), merge: true }],
      messages: [],
    })
    expect(written).toEqual([rel])
    const parsed = JSON.parse(await readFile(join(tempDir, rel), "utf-8")) as {
      a: number
      b: number
    }
    expect(parsed).toEqual({ a: 1, b: 2 })
  })

  it("appends text when appendText is true and file exists", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "init-ide-"))
    const rel = "notes.md"
    await writeFile(join(tempDir, rel), "line one\n\n", "utf-8")
    const { written } = await writeGeneratedFiles(tempDir, {
      platform: "cursor",
      files: [{ path: rel, content: "line two", appendText: true }],
      messages: [],
    })
    expect(written).toEqual([rel])
    expect(await readFile(join(tempDir, rel), "utf-8")).toBe("line one\n\nline two")
  })

  it("creates file when appendText is true and file does not exist", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "init-ide-"))
    const rel = "new-append.txt"
    const { written, skipped } = await writeGeneratedFiles(tempDir, {
      platform: "cursor",
      files: [{ path: rel, content: "fresh", appendText: true }],
      messages: [],
    })
    expect(written).toEqual([rel])
    expect(skipped).toEqual([])
    expect(await readFile(join(tempDir, rel), "utf-8")).toBe("fresh")
  })
})

describe("generateIdeConfigs", () => {
  it("returns non-empty files for every built-in IDE platform", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "init-ide-"))
    const results = await generateIdeConfigs(tempDir, [...ALL_IDE_PLATFORMS], minimalProfile())
    expect(results).toHaveLength(ALL_IDE_PLATFORMS.length)
    for (const r of results) {
      expect(r.files.length).toBeGreaterThan(0)
    }
  })
})
