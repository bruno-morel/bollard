import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "@bollard/engine/src/context.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { listDirTool } from "../src/tools/list-dir.js"
import { readFileTool } from "../src/tools/read-file.js"
import { runCommandTool } from "../src/tools/run-command.js"
import { searchTool } from "../src/tools/search.js"
import { writeFileTool } from "../src/tools/write-file.js"
import type { AgentContext } from "../src/types.js"

const TEST_CONFIG = {
  llm: { default: { provider: "mock", model: "test" } },
  agent: { max_cost_usd: 10, max_duration_minutes: 30 },
}

let tempDir: string
let ctx: AgentContext

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "bollard-tools-"))
  ctx = {
    pipelineCtx: createContext("test", "test-bp", TEST_CONFIG),
    workDir: tempDir,
  }
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe("read_file", () => {
  it("reads file contents", async () => {
    writeFileSync(join(tempDir, "hello.txt"), "hello world")
    const result = await readFileTool.execute({ path: "hello.txt" }, ctx)
    expect(result).toBe("hello world")
  })

  it("rejects path traversal", async () => {
    await expect(readFileTool.execute({ path: "../../etc/passwd" }, ctx)).rejects.toThrow(
      "Path traversal",
    )
  })
})

describe("write_file", () => {
  it("writes content to a file", async () => {
    const result = await writeFileTool.execute({ path: "out.txt", content: "data here" }, ctx)
    expect(result).toContain("9 bytes")
    const { readFileSync } = await import("node:fs")
    expect(readFileSync(join(tempDir, "out.txt"), "utf-8")).toBe("data here")
  })

  it("creates nested directories", async () => {
    await writeFileTool.execute({ path: "nested/deep/file.ts", content: "export {}" }, ctx)
    const { readFileSync } = await import("node:fs")
    expect(readFileSync(join(tempDir, "nested/deep/file.ts"), "utf-8")).toBe("export {}")
  })

  it("rejects path traversal", async () => {
    await expect(
      writeFileTool.execute({ path: "../../../tmp/evil", content: "x" }, ctx),
    ).rejects.toThrow("Path traversal")
  })
})

describe("list_dir", () => {
  it("lists files and directories", async () => {
    writeFileSync(join(tempDir, "file.txt"), "")
    mkdirSync(join(tempDir, "subdir"))
    const result = await listDirTool.execute({ path: "." }, ctx)
    expect(result).toContain("file.txt")
    expect(result).toContain("subdir/")
  })
})

describe("search", () => {
  it("finds matching lines", async () => {
    writeFileSync(join(tempDir, "code.ts"), "const foo = 42\nconst bar = 99\n")
    const result = await searchTool.execute({ pattern: "foo" }, ctx)
    expect(result).toContain("foo")
    expect(result).toContain("42")
  })

  it("returns no matches for nonexistent pattern", async () => {
    writeFileSync(join(tempDir, "code.ts"), "const foo = 42\n")
    const result = await searchTool.execute({ pattern: "zzz_nonexistent" }, ctx)
    expect(result).toBe("No matches found.")
  })
})

describe("run_command", () => {
  it("runs an allowed command", async () => {
    const result = await runCommandTool.execute({ command: "node -v" }, ctx)
    expect(result).toContain("stdout:")
    expect(result).toMatch(/v\d+/)
  })

  it("rejects a disallowed command", async () => {
    await expect(runCommandTool.execute({ command: "rm -rf /" }, ctx)).rejects.toThrow(
      "not allowed",
    )
  })

  it("rejects cwd path traversal", async () => {
    await expect(
      runCommandTool.execute({ command: "node -v", cwd: "../../../" }, ctx),
    ).rejects.toThrow("Path traversal")
  })
})
