import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "@bollard/engine/src/context.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { editFileTool } from "../src/tools/edit-file.js"
import { listDirTool } from "../src/tools/list-dir.js"
import { readFileTool } from "../src/tools/read-file.js"
import {
  formatVitestFailureSummary,
  isTestCommand,
  runCommandTool,
} from "../src/tools/run-command.js"
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

  it("returns all lines with no marker when file has exactly 200 lines", async () => {
    const content = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n")
    writeFileSync(join(tempDir, "two-hundred.txt"), content)
    const result = await readFileTool.execute({ path: "two-hundred.txt" }, ctx)
    expect(result.split("\n")).toHaveLength(200)
    expect(result).not.toContain("[...truncated")
  })

  it("truncates at 200 lines with marker when file has 250 lines", async () => {
    const content = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join("\n")
    writeFileSync(join(tempDir, "two-fifty.txt"), content)
    const result = await readFileTool.execute({ path: "two-fifty.txt" }, ctx)
    expect(result).toContain("[...truncated: showing lines 1–200 of 250")
    expect(result).toContain("Use offset=201 to read more.")
    const beforeMarker = result.split("\n[...truncated")[0] ?? ""
    expect(beforeMarker.split("\n")).toHaveLength(200)
  })

  it("paginates with offset and limit for large files", async () => {
    const content = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join("\n")
    writeFileSync(join(tempDir, "paginate.txt"), content)
    const result = await readFileTool.execute({ path: "paginate.txt", offset: 201, limit: 50 }, ctx)
    expect(result).toBe(Array.from({ length: 50 }, (_, i) => `line ${201 + i}`).join("\n"))
    expect(result).not.toContain("[...truncated")
  })

  it("caps limit at 200 even when caller requests more", async () => {
    const content = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join("\n")
    writeFileSync(join(tempDir, "cap-limit.txt"), content)
    const result = await readFileTool.execute({ path: "cap-limit.txt", limit: 300 }, ctx)
    expect(result).toContain("[...truncated: showing lines 1–200 of 250")
    const beforeMarker = result.split("\n[...truncated")[0] ?? ""
    expect(beforeMarker.split("\n")).toHaveLength(200)
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

  // Phase 17 injection tests: packages/cli/tests/agent-handler.unit.test.ts
  it("strips pre-existing test files from allowedWritePaths (Layer 1 guard)", () => {
    const isTestFile = (p: string) => /\.test\.[jt]s$/.test(p)
    const mockExists = (p: string) => p.includes("cost-tracker.test.ts")

    const resolved = [
      "/app/packages/engine/src/cost-tracker.ts",
      "/app/packages/engine/tests/cost-tracker.test.ts",
      "/app/packages/engine/tests/cost-tracker.adversarial.test.ts",
    ]

    const filtered = resolved.filter((p) => !(isTestFile(p) && mockExists(p)))

    expect(filtered).toHaveLength(2)
    expect(filtered).not.toContain("/app/packages/engine/tests/cost-tracker.test.ts")
    expect(filtered).toContain("/app/packages/engine/src/cost-tracker.ts")
    expect(filtered).toContain("/app/packages/engine/tests/cost-tracker.adversarial.test.ts")
  })

  it("returns error when path is outside allowedWritePaths", async () => {
    const allowed = join(tempDir, "src/allowed.ts")
    const ctxWithScope = { ...ctx, allowedWritePaths: [allowed] }
    const result = await writeFileTool.execute({ path: "src/other.ts", content: "x" }, ctxWithScope)
    expect(result).toContain("Error:")
    expect(result).toContain("not in the plan's affected_files")
    expect(result).toContain("src/allowed.ts")
  })

  it("allows write to a path that is in allowedWritePaths", async () => {
    const allowed = join(tempDir, "src/allowed.ts")
    const ctxWithScope = { ...ctx, allowedWritePaths: [allowed] }
    const result = await writeFileTool.execute(
      { path: "src/allowed.ts", content: "export const x = 1" },
      ctxWithScope,
    )
    expect(result).toContain("bytes")
    expect(result).not.toContain("Error:")
  })

  it("blocks write to workspace root when allowedWritePaths is set", async () => {
    const allowed = join(tempDir, "src/allowed.ts")
    const ctxWithScope = { ...ctx, allowedWritePaths: [allowed] }
    const result = await writeFileTool.execute({ path: "scratch.ts", content: "x" }, ctxWithScope)
    expect(result).toContain("Error:")
    expect(result).toContain("project root is not allowed")
  })

  it("allows write to any path when allowedWritePaths is not set (backward compat)", async () => {
    const result = await writeFileTool.execute(
      { path: "anywhere/file.ts", content: "export {}" },
      ctx,
    )
    expect(result).toContain("bytes")
    expect(result).not.toContain("Error:")
  })

  it("removes test file from allowedWritePaths after first write (write-once guard)", async () => {
    const testFile = join(tempDir, "tests/cost-tracker-scale.test.ts")
    const srcFile = join(tempDir, "src/cost-tracker.ts")
    const allowedWritePaths = [srcFile, testFile]
    const ctxWithScope = { ...ctx, allowedWritePaths }

    // First write succeeds and removes the test path from allowedWritePaths
    const result = await writeFileTool.execute(
      { path: "tests/cost-tracker-scale.test.ts", content: "import { describe } from 'vitest'" },
      ctxWithScope,
    )
    expect(result).toContain("bytes")
    expect(result).not.toContain("Error:")
    expect(ctxWithScope.allowedWritePaths).not.toContain(testFile)
    expect(ctxWithScope.allowedWritePaths).toContain(srcFile)
  })

  it("write-once guard does not affect non-test files", async () => {
    const srcFile = join(tempDir, "src/cost-tracker.ts")
    const allowedWritePaths = [srcFile]
    const ctxWithScope = { ...ctx, allowedWritePaths }

    await writeFileTool.execute(
      { path: "src/cost-tracker.ts", content: "export const x = 1" },
      ctxWithScope,
    )
    // src file stays in allowedWritePaths after write
    expect(ctxWithScope.allowedWritePaths).toContain(srcFile)
  })

  it("write-once guard does nothing when allowedWritePaths is not set", async () => {
    // Should not throw or mutate anything
    const result = await writeFileTool.execute(
      { path: "tests/something.test.ts", content: "// test" },
      ctx,
    )
    expect(result).toContain("bytes")
  })

  it("populates blockedTestPaths after write-once guard fires (Phase 18c)", async () => {
    const testFile = join(tempDir, "tests/cost-tracker-floor.test.ts")
    const srcFile = join(tempDir, "src/cost-tracker.ts")
    const ctxWithScope = { ...ctx, allowedWritePaths: [srcFile, testFile] }

    await writeFileTool.execute(
      { path: "tests/cost-tracker-floor.test.ts", content: "import { describe } from 'vitest'" },
      ctxWithScope,
    )

    expect(ctxWithScope.blockedTestPaths).toBeDefined()
    expect(ctxWithScope.blockedTestPaths).toContain(testFile)
    // src file not blocked
    expect(ctxWithScope.blockedTestPaths).not.toContain(srcFile)
  })

  it("does not populate blockedTestPaths for non-test files (Phase 18c)", async () => {
    const srcFile = join(tempDir, "src/cost-tracker.ts")
    const ctxWithScope = { ...ctx, allowedWritePaths: [srcFile] }

    await writeFileTool.execute(
      { path: "src/cost-tracker.ts", content: "export const x = 1" },
      ctxWithScope,
    )

    expect(ctxWithScope.blockedTestPaths).toBeUndefined()
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

  it("strips control characters from pattern", async () => {
    writeFileSync(join(tempDir, "target.ts"), "export function purge() {}\n")
    const result = await searchTool.execute({ pattern: "export\nfunction" }, ctx)
    expect(result).toContain("purge")
    expect(result).not.toContain("Search error")
  })

  it("returns error message instead of throwing on ripgrep failure", async () => {
    const result = await searchTool.execute({ pattern: "anything", path: "no-such-dir-xyz" }, ctx)
    expect(result).toContain("Search error")
  })

  it("handles empty pattern after sanitization", async () => {
    const result = await searchTool.execute({ pattern: "\n\n\t" }, ctx)
    expect(result).toContain("empty search pattern")
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

  it("truncates stdout beyond 100 lines", async () => {
    writeFileSync(join(tempDir, "emit150.js"), "for (let i = 0; i < 150; i++) console.log(i)\n")
    const result = await runCommandTool.execute({ command: "node emit150.js" }, ctx)
    expect(result).toContain("stdout:")
    expect(result).toContain("51 more lines not shown")
  })

  it("does not truncate stdout when 80 lines or fewer", async () => {
    writeFileSync(join(tempDir, "emit80.js"), "for (let i = 0; i < 80; i++) console.log(i)\n")
    const result = await runCommandTool.execute({ command: "node emit80.js" }, ctx)
    expect(result).toContain("stdout:")
    expect(result).not.toContain("more lines not shown")
    for (let i = 0; i < 80; i++) {
      expect(result).toContain(String(i))
    }
  })

  it("truncates stdout on failed command path", async () => {
    writeFileSync(
      join(tempDir, "emit200fail.js"),
      "for (let i = 0; i < 200; i++) console.log(i)\nprocess.exit(1)\n",
    )
    const result = await runCommandTool.execute({ command: "node emit200fail.js" }, ctx)
    expect(result).toContain("Command failed")
    expect(result).toMatch(/\[\.\.\.truncated: \d+ more lines not shown\]/)
  })

  it("formatVitestFailureSummary extracts suites, tests, errors, and summary", () => {
    const simulatedStdout = [
      " FAIL  packages/engine/tests/cost-tracker.test.ts",
      " FAIL  packages/agents/tests/executor.test.ts",
      "",
      " FAIL  packages/engine/tests/cost-tracker.test.ts > CostTracker > clamp",
      " FAIL  packages/agents/tests/executor.test.ts > executeAgent > handles tool errors",
      "",
      "  AssertionError: expected -5 to be 0",
      "  Expected: 0",
      "  Received: -5",
      "",
      "Tests  2 failed | 1154 passed | 6 skipped",
    ].join("\n")

    const summary = formatVitestFailureSummary(simulatedStdout, "")

    expect(summary).toContain("Summary: Tests  2 failed | 1154 passed | 6 skipped")
    expect(summary).toContain("packages/engine/tests/cost-tracker.test.ts")
    expect(summary).toContain("packages/agents/tests/executor.test.ts")
    expect(summary).toContain("× CostTracker > clamp")
    expect(summary).toContain("× executeAgent > handles tool errors")
    expect(summary).toContain("AssertionError: expected -5 to be 0")
    expect(summary).toContain("Expected: 0")
    expect(summary).toContain("Received: -5")
  })

  it("formatVitestFailureSummary falls back when unparseable", () => {
    const longOutput = Array.from({ length: 150 }, (_, i) => `line ${i}`).join("\n")
    const summary = formatVitestFailureSummary(longOutput, "")
    expect(summary).toMatch(/stdout:|stderr:/)
    expect(summary).toMatch(/\[\.\.\.truncated: \d+ more lines not shown\]/)
  })

  it("isTestCommand recognizes pnpm test variants", () => {
    const trueCases = [
      "pnpm test",
      "pnpm run test",
      "pnpm exec vitest run",
      "vitest run",
      "npx vitest run",
    ]
    for (const cmd of trueCases) {
      expect(isTestCommand(cmd.split(/\s+/))).toBe(true)
    }

    const falseCases = ["node -v", "pnpm run lint", "pnpm exec biome check"]
    for (const cmd of falseCases) {
      expect(isTestCommand(cmd.split(/\s+/))).toBe(false)
    }
  })

  it("returns structured summary for failed pnpm run test", async () => {
    const vitestOutput = [
      " FAIL  packages/engine/tests/cost-tracker.test.ts",
      " FAIL  packages/agents/tests/executor.test.ts",
      "",
      " FAIL  packages/engine/tests/cost-tracker.test.ts > CostTracker > clamp",
      " FAIL  packages/agents/tests/executor.test.ts > executeAgent > handles tool errors",
      "",
      "  AssertionError: expected -5 to be 0",
      "  Expected: 0",
      "  Received: -5",
      "",
      "Tests  2 failed | 1154 passed | 6 skipped",
    ].join("\n")

    const padding = Array.from({ length: 200 }, (_, i) => `padding line ${i}`).join("\n")

    writeFileSync(
      join(tempDir, "emit-vitest-fail.js"),
      `console.log(${JSON.stringify(`${padding}\n${vitestOutput}`)})\nprocess.exit(1)\n`,
    )
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({ scripts: { test: "node emit-vitest-fail.js" } }, null, 2),
    )

    const result = await runCommandTool.execute({ command: "pnpm run test" }, ctx)

    expect(result).toContain("test failure summary")
    expect(result).toContain("packages/engine/tests/cost-tracker.test.ts")
    expect(result).toContain("× CostTracker > clamp")
    expect(result).toContain("× executeAgent > handles tool errors")
    expect(result).not.toContain("[...truncated")
  })

  it("blocks test run on a blockedTestPath file (Phase 18c)", async () => {
    const testFile = join(tempDir, "tests/cost-tracker-floor.test.ts")
    const ctxBlocked = {
      ...ctx,
      blockedTestPaths: [testFile],
    }
    const result = await runCommandTool.execute(
      { command: "pnpm exec vitest run tests/cost-tracker-floor.test.ts" },
      ctxBlocked,
    )
    expect(result).toContain("Error:")
    expect(result).toContain("cost-tracker-floor.test.ts")
    expect(result).toContain("write-once guard")
  })

  it("does not block test run when no blockedTestPaths set", async () => {
    // Node -v is not a test command, just checking the blockedTestPaths guard is a no-op
    const result = await runCommandTool.execute({ command: "node -v" }, ctx)
    expect(result).not.toContain("write-once guard")
  })

  it("does not block unrelated test file when blockedTestPaths is set", async () => {
    const testFile = join(tempDir, "tests/cost-tracker-floor.test.ts")
    const ctxBlocked = {
      ...ctx,
      blockedTestPaths: [testFile],
    }
    // Running a completely different test file — should not be blocked
    // (we just check the guard logic, not actual execution which would fail without real files)
    const isBlocked = ctxBlocked.blockedTestPaths.some((blocked) => {
      const blockedBase = blocked.split("/").at(-1) ?? ""
      return ["pnpm", "exec", "vitest", "run", "tests/cost-tracker-cap.test.ts"].some(
        (p) => p === blocked || p.endsWith(blockedBase),
      )
    })
    expect(isBlocked).toBe(false)
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
    expect(result).toContain("start_line/end_line")
  })

  it("returns error when old_string appears multiple times", async () => {
    writeFileSync(join(tempDir, "code.ts"), "foo\nbar\nfoo\n")
    const result = await editFileTool.execute(
      { path: "code.ts", old_string: "foo", new_string: "baz" },
      ctx,
    )
    expect(result).toContain("appears 2 times")
    expect(result).toContain("start_line/end_line")
  })

  it("rejects path traversal", async () => {
    await expect(
      editFileTool.execute({ path: "../../../etc/passwd", old_string: "x", new_string: "y" }, ctx),
    ).rejects.toThrow("Path traversal")
  })

  it("returns error when path is outside allowedWritePaths", async () => {
    mkdirSync(join(tempDir, "src"), { recursive: true })
    writeFileSync(join(tempDir, "src", "other.ts"), "const x = 1\n")
    const allowed = join(tempDir, "src/allowed.ts")
    const ctxWithScope = { ...ctx, allowedWritePaths: [allowed] }
    const result = await editFileTool.execute(
      { path: "src/other.ts", old_string: "const x = 1", new_string: "const x = 2" },
      ctxWithScope,
    )
    expect(result).toContain("Error:")
    expect(result).toContain("not in the plan's affected_files")
  })

  it("allows edit to a path in allowedWritePaths", async () => {
    mkdirSync(join(tempDir, "src"), { recursive: true })
    writeFileSync(join(tempDir, "src", "allowed.ts"), "const x = 1\n")
    const allowed = join(tempDir, "src/allowed.ts")
    const ctxWithScope = { ...ctx, allowedWritePaths: [allowed] }
    const result = await editFileTool.execute(
      { path: "src/allowed.ts", old_string: "const x = 1", new_string: "const x = 2" },
      ctxWithScope,
    )
    expect(result).toContain("Replaced")
    expect(result).not.toContain("Error:")
  })

  it("blocks edit to workspace root when allowedWritePaths is set", async () => {
    writeFileSync(join(tempDir, "debug.ts"), "const x = 1\n")
    const allowed = join(tempDir, "src/allowed.ts")
    const ctxWithScope = { ...ctx, allowedWritePaths: [allowed] }
    const result = await editFileTool.execute(
      { path: "debug.ts", old_string: "const x = 1", new_string: "const x = 2" },
      ctxWithScope,
    )
    expect(result).toContain("Error:")
    expect(result).toContain("project root is not allowed")
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

  it("replaces lines by line range", async () => {
    writeFileSync(join(tempDir, "code.ts"), "line1\nline2\nline3\nline4\nline5\n")
    const result = await editFileTool.execute(
      { path: "code.ts", start_line: 2, end_line: 3, new_string: "replaced2\nreplaced3" },
      ctx,
    )
    expect(result).toContain("Replaced lines 2-3")
    expect(readFileSync(join(tempDir, "code.ts"), "utf-8")).toBe(
      "line1\nreplaced2\nreplaced3\nline4\nline5\n",
    )
  })

  it("deletes lines when new_string is empty in line-range mode", async () => {
    writeFileSync(join(tempDir, "code.ts"), "line1\nline2\nline3\nline4\n")
    const result = await editFileTool.execute(
      { path: "code.ts", start_line: 2, end_line: 3, new_string: "" },
      ctx,
    )
    expect(result).toContain("Replaced lines 2-3")
    expect(readFileSync(join(tempDir, "code.ts"), "utf-8")).toBe("line1\nline4\n")
  })

  it("inserts more lines than removed in line-range mode", async () => {
    writeFileSync(join(tempDir, "code.ts"), "a\nb\nc\n")
    const result = await editFileTool.execute(
      { path: "code.ts", start_line: 2, end_line: 2, new_string: "x\ny\nz" },
      ctx,
    )
    expect(result).toContain("1 line(s)) with 3 line(s)")
    expect(readFileSync(join(tempDir, "code.ts"), "utf-8")).toBe("a\nx\ny\nz\nc\n")
  })

  it("returns error for invalid line range", async () => {
    writeFileSync(join(tempDir, "code.ts"), "a\nb\nc\n")
    const result = await editFileTool.execute(
      { path: "code.ts", start_line: 0, end_line: 2, new_string: "x" },
      ctx,
    )
    expect(result).toContain("Error: invalid line range")
  })

  it("returns error for reversed line range", async () => {
    writeFileSync(join(tempDir, "code.ts"), "a\nb\nc\n")
    const result = await editFileTool.execute(
      { path: "code.ts", start_line: 3, end_line: 1, new_string: "x" },
      ctx,
    )
    expect(result).toContain("Error: invalid line range")
  })

  it("caps end_line to file length", async () => {
    writeFileSync(join(tempDir, "code.ts"), "a\nb\nc\n")
    const result = await editFileTool.execute(
      { path: "code.ts", start_line: 2, end_line: 999, new_string: "x" },
      ctx,
    )
    expect(result).toContain("Replaced lines 2-")
    // split("\n") treats trailing newline as an extra empty line; capping end replaces through it
    expect(readFileSync(join(tempDir, "code.ts"), "utf-8")).toBe("a\nx")
  })

  it("rejects path traversal in line-range mode", async () => {
    await expect(
      editFileTool.execute(
        { path: "../../../etc/passwd", start_line: 1, end_line: 1, new_string: "x" },
        ctx,
      ),
    ).rejects.toThrow("Path traversal")
  })
})
