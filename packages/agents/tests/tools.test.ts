import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "@bollard/engine/src/context.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { editFileTool } from "../src/tools/edit-file.js"
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

  it("treats regex metacharacters as literal by default (fixed-string mode)", async () => {
    writeFileSync(join(tempDir, "code.ts"), "const foo(bar) = 1\n")
    const result = await searchTool.execute({ pattern: "foo(bar)" }, ctx)
    expect(result).toContain("foo(bar)")
  })

  it("matches regex patterns when regex is true", async () => {
    writeFileSync(join(tempDir, "code.ts"), "const foo123 = 1\n")
    const result = await searchTool.execute({ pattern: "foo\\d+", regex: true }, ctx)
    expect(result).toContain("foo123")
  })

  it("auto-falls back to literal search on regex parse errors", async () => {
    writeFileSync(join(tempDir, "code.ts"), "const pos[0] = value\n")
    const result = await searchTool.execute({ pattern: "pos[0", regex: true }, ctx)
    expect(result).toContain("[auto-fallback: regex parse error, searched as literal string]")
    expect(result).toContain("pos[0]")
  })

  it("auto-fallback reports no matches when literal search still finds nothing", async () => {
    writeFileSync(join(tempDir, "code.ts"), "const x = 1\n")
    const result = await searchTool.execute({ pattern: "pos[0", regex: true }, ctx)
    expect(result).toBe(
      "[auto-fallback: regex parse error, searched as literal string]\nNo matches found.",
    )
  })
})

describe("run_command", () => {
  it("runs an allowed command", async () => {
    const result = await runCommandTool.execute({ command: "node -v" }, ctx)
    expect(result).toContain("stdout:")
    expect(result).toMatch(/v\d+/)
  })

  it("rejects recursive rm", async () => {
    await expect(runCommandTool.execute({ command: "rm -rf /" }, ctx)).rejects.toThrow(
      "Recursive rm is not allowed",
    )
  })

  it("rejects rm -r", async () => {
    await expect(runCommandTool.execute({ command: "rm -r sub" }, ctx)).rejects.toThrow(
      "Recursive rm is not allowed",
    )
  })

  it("allows rm of a file inside workDir", async () => {
    writeFileSync(join(tempDir, "to-delete.txt"), "x")
    await runCommandTool.execute({ command: "rm to-delete.txt" }, ctx)
    const { existsSync } = await import("node:fs")
    expect(existsSync(join(tempDir, "to-delete.txt"))).toBe(false)
  })

  it("rejects rm of a path outside workDir", async () => {
    await expect(
      runCommandTool.execute({ command: "rm ../../../etc/passwd" }, ctx),
    ).rejects.toThrow('rm target "../../../etc/passwd" is outside the work directory')
  })

  it("rejects cwd path traversal", async () => {
    await expect(
      runCommandTool.execute({ command: "node -v", cwd: "../../../" }, ctx),
    ).rejects.toThrow("Path traversal")
  })
})

describe("edit_file", () => {
  it("replaces a unique string in a file", async () => {
    writeFileSync(join(tempDir, "code.ts"), "const x = 1\nconst y = 2\nconst z = 3\n")
    const result = await editFileTool.execute(
      { path: "code.ts", old_string: "const y = 2", new_string: "const y = 42" },
      ctx,
    )
    expect(result).toContain("Replaced")
    expect(readFileSync(join(tempDir, "code.ts"), "utf-8")).toBe(
      "const x = 1\nconst y = 42\nconst z = 3\n",
    )
  })

  it("returns error when old_string not found", async () => {
    writeFileSync(join(tempDir, "code.ts"), "const x = 1\n")
    const result = await editFileTool.execute(
      { path: "code.ts", old_string: "nonexistent", new_string: "replacement" },
      ctx,
    )
    expect(result).toContain("Error: old_string not found in file")
  })

  it("returns error when old_string appears multiple times", async () => {
    writeFileSync(join(tempDir, "code.ts"), "foo\nbar\nfoo\n")
    const result = await editFileTool.execute(
      { path: "code.ts", old_string: "foo", new_string: "baz" },
      ctx,
    )
    expect(result).toContain("appears 2 times")
  })

  it("rejects path traversal", async () => {
    await expect(
      editFileTool.execute({ path: "../../../etc/passwd", old_string: "x", new_string: "y" }, ctx),
    ).rejects.toThrow("Path traversal")
  })

  it("handles empty new_string for deletion", async () => {
    writeFileSync(join(tempDir, "code.ts"), "line1\nDELETE_ME\nline3\n")
    const result = await editFileTool.execute(
      { path: "code.ts", old_string: "DELETE_ME\n", new_string: "" },
      ctx,
    )
    expect(result).toContain("Replaced")
    expect(readFileSync(join(tempDir, "code.ts"), "utf-8")).toBe("line1\nline3\n")
  })

  it("handles replacement that changes line count", async () => {
    writeFileSync(join(tempDir, "code.ts"), "line1\nline2\nline3\n")
    const result = await editFileTool.execute(
      { path: "code.ts", old_string: "line2", new_string: "line2a\nline2b\nline2c" },
      ctx,
    )
    expect(result).toContain("Replaced 1 line(s) with 3 line(s)")
    expect(readFileSync(join(tempDir, "code.ts"), "utf-8")).toBe(
      "line1\nline2a\nline2b\nline2c\nline3\n",
    )
  })
})
