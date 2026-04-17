import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "@bollard/engine/src/context.js"
import type { BollardConfig } from "@bollard/engine/src/context.js"
import type { AgentContext } from "../../src/types.js"
import { writeFileTool } from "../../src/tools/write-file.js"

const testConfig: BollardConfig = {
  llm: { default: { provider: "mock", model: "m" } },
  agent: { max_cost_usd: 10, max_duration_minutes: 30 },
}

let workDir: string
let ctx: AgentContext

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "bollard-wf-"))
  ctx = {
    pipelineCtx: createContext("t", "bp", testConfig),
    workDir,
  }
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe("writeFileTool", () => {
  it("writes content and reports byte count", async () => {
    const msg = "hello"
    const out = await writeFileTool.execute({ path: "out.txt", content: msg }, ctx)
    expect(out).toContain(`Written ${msg.length} bytes`)
    expect(readFileSync(join(workDir, "out.txt"), "utf-8")).toBe(msg)
  })

  it("rejects traversal paths", async () => {
    await expect(
      writeFileTool.execute({ path: "../../../etc/passwd", content: "x" }, ctx),
    ).rejects.toThrow(/traversal/)
  })

  it("coerces null content to empty string", async () => {
    const out = await writeFileTool.execute({ path: "empty.txt", content: null as unknown as string }, ctx)
    expect(out).toContain("Written 0 bytes")
  })
})

describe("writeFileTool property tests", () => {
  it("round-trips arbitrary content", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 500 }), async (content) => {
        const name = "p.txt"
        await writeFileTool.execute({ path: name, content }, ctx)
        expect(readFileSync(join(workDir, name), "utf-8")).toBe(content)
      }),
      { numRuns: 10 },
    )
  })
})
