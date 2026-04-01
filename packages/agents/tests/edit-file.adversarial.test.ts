import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "@bollard/engine/src/context.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { editFileTool } from "../src/tools/edit-file.js"
import type { AgentContext } from "../src/types.js"

const TEST_CONFIG = {
  llm: { default: { provider: "mock", model: "test" } },
  agent: { max_cost_usd: 10, max_duration_minutes: 30 },
}

let tempDir: string
let ctx: AgentContext

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "bollard-edit-adversarial-"))
  ctx = {
    pipelineCtx: createContext("test", "test-bp", TEST_CONFIG),
    workDir: tempDir,
  }
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe("edit_file adversarial edge cases", () => {
  it("handles Unicode content in old_string and new_string", async () => {
    writeFileSync(join(tempDir, "unicode.ts"), "const greeting = \"こんにちは世界\"\n")
    const result = await editFileTool.execute(
      { path: "unicode.ts", old_string: "こんにちは世界", new_string: "你好世界 🌍" },
      ctx,
    )
    expect(result).toContain("Replaced")
    expect(readFileSync(join(tempDir, "unicode.ts"), "utf-8")).toBe("const greeting = \"你好世界 🌍\"\n")
  })

  it("treats regex metacharacters in old_string as literal strings", async () => {
    const content = "const re = /^foo\\.(bar)+[baz]*$/\n"
    writeFileSync(join(tempDir, "regex.ts"), content)
    const result = await editFileTool.execute(
      {
        path: "regex.ts",
        old_string: "/^foo\\.(bar)+[baz]*$/",
        new_string: "/^replaced$/",
      },
      ctx,
    )
    expect(result).toContain("Replaced")
    expect(readFileSync(join(tempDir, "regex.ts"), "utf-8")).toBe("const re = /^replaced$/\n")
  })

  it("matches old_string that spans multiple lines", async () => {
    const content = "function foo() {\n  const a = 1\n  const b = 2\n}\n"
    writeFileSync(join(tempDir, "multi.ts"), content)
    const result = await editFileTool.execute(
      {
        path: "multi.ts",
        old_string: "  const a = 1\n  const b = 2",
        new_string: "  const sum = 3",
      },
      ctx,
    )
    expect(result).toContain("Replaced 2 line(s) with 1 line(s)")
    expect(readFileSync(join(tempDir, "multi.ts"), "utf-8")).toBe("function foo() {\n  const sum = 3\n}\n")
  })

  it("returns not-found error for empty file", async () => {
    writeFileSync(join(tempDir, "empty.ts"), "")
    const result = await editFileTool.execute(
      { path: "empty.ts", old_string: "anything", new_string: "replacement" },
      ctx,
    )
    expect(result).toContain("old_string not found in file")
  })

  it("replaces entire file when old_string equals full content", async () => {
    const fullContent = "export const x = 42\n"
    writeFileSync(join(tempDir, "full.ts"), fullContent)
    const result = await editFileTool.execute(
      { path: "full.ts", old_string: fullContent, new_string: "export const x = 99\nexport const y = 100\n" },
      ctx,
    )
    expect(result).toContain("Replaced")
    expect(readFileSync(join(tempDir, "full.ts"), "utf-8")).toBe("export const x = 99\nexport const y = 100\n")
  })

  it("succeeds as no-op when new_string equals old_string", async () => {
    const content = "export const x = 42\n"
    writeFileSync(join(tempDir, "noop.ts"), content)
    const result = await editFileTool.execute(
      { path: "noop.ts", old_string: "export const x = 42", new_string: "export const x = 42" },
      ctx,
    )
    expect(result).toContain("Replaced")
    expect(readFileSync(join(tempDir, "noop.ts"), "utf-8")).toBe(content)
  })

  it("persists edit to disk (write-edit-read round trip)", async () => {
    writeFileSync(join(tempDir, "persist.ts"), "const version = 1\n")
    await editFileTool.execute(
      { path: "persist.ts", old_string: "version = 1", new_string: "version = 2" },
      ctx,
    )
    const onDisk = readFileSync(join(tempDir, "persist.ts"), "utf-8")
    expect(onDisk).toBe("const version = 2\n")
  })
})
