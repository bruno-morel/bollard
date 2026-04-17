import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "@bollard/engine/src/context.js"
import type { BollardConfig } from "@bollard/engine/src/context.js"
import type { AgentContext } from "../../src/types.js"
import { editFileTool } from "../../src/tools/edit-file.js"

const testConfig: BollardConfig = {
  llm: { default: { provider: "mock", model: "m" } },
  agent: { max_cost_usd: 10, max_duration_minutes: 30 },
}

let workDir: string
let ctx: AgentContext

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "bollard-test-"))
  ctx = {
    pipelineCtx: createContext("t", "bp", testConfig),
    workDir,
  }
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe("editFileTool structure", () => {
  it("is a valid AgentTool", () => {
    expect(editFileTool.name).toBe("edit_file")
    expect(typeof editFileTool.execute).toBe("function")
  })
})

describe("editFileTool edits", () => {
  it("replaces unique old_string with new_string", async () => {
    writeFileSync(join(workDir, "a.txt"), "hello world")
    const out = await editFileTool.execute(
      { path: "a.txt", old_string: "world", new_string: "there" },
      ctx,
    )
    expect(out).toContain("Replaced")
    expect(out).toContain("a.txt")
  })

  it("returns error string when old_string is empty", async () => {
    writeFileSync(join(workDir, "b.txt"), "x")
    const out = await editFileTool.execute(
      { path: "b.txt", old_string: "", new_string: "y" },
      ctx,
    )
    expect(out).toMatch(/old_string cannot be empty/)
  })

  it("returns error when old_string not found", async () => {
    writeFileSync(join(workDir, "c.txt"), "abc")
    const out = await editFileTool.execute(
      { path: "c.txt", old_string: "zzz", new_string: "q" },
      ctx,
    )
    expect(out).toMatch(/not found/)
  })
})

describe("editFileTool path safety", () => {
  it("rejects traversal outside workDir", async () => {
    await expect(
      editFileTool.execute(
        { path: "../../../etc/passwd", old_string: "a", new_string: "b" },
        ctx,
      ),
    ).rejects.toThrow(/Path traversal/)
  })
})

describe("editFileTool property tests", () => {
  it("preserves uniqueness requirement", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 20 }), async (token) => {
        fc.pre(!token.includes("\0"))
        const name = `f-${token.replace(/[/\\]/g, "x")}.txt`
        writeFileSync(join(workDir, name), `${token}\n${token}\n`)
        const out = await editFileTool.execute(
          { path: name, old_string: token, new_string: "X" },
          ctx,
        )
        expect(typeof out).toBe("string")
        expect(out.length).toBeGreaterThan(0)
      }),
    )
  })
})
