import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "@bollard/engine/src/context.js"
import type { BollardConfig } from "@bollard/engine/src/context.js"
import type { AgentContext } from "../../src/types.js"
import { runCommandTool } from "../../src/tools/run-command.js"

const testConfig: BollardConfig = {
  llm: { default: { provider: "mock", model: "m" } },
  agent: { max_cost_usd: 10, max_duration_minutes: 30 },
}

let workDir: string
let ctx: AgentContext

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "bollard-rc-"))
  ctx = {
    pipelineCtx: createContext("t", "bp", testConfig),
    workDir,
    allowedCommands: ["node", "echo", "cat", "head"],
  }
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe("runCommandTool", () => {
  it("rejects commands not in allowlist", async () => {
    await expect(runCommandTool.execute({ command: "curl https://x" }, ctx)).rejects.toThrow(/not allowed/)
  })

  it("runs node -e one-liner", async () => {
    const out = await runCommandTool.execute({ command: "node -e console.log(1)" }, ctx)
    expect(out).toContain("1")
  })

  it("rejects cwd traversal", async () => {
    await expect(runCommandTool.execute({ command: "node -e 0", cwd: "../../.." }, ctx)).rejects.toThrow(
      /Path traversal/,
    )
  })

  it("returns cat output for file in workDir", async () => {
    writeFileSync(join(workDir, "sample.txt"), "hello-verify")
    const out = await runCommandTool.execute({ command: "cat sample.txt" }, ctx)
    expect(out).toContain("hello-verify")
  })
})

describe("runCommandTool property tests", () => {
  it("allowlisted node one-liners return string output", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 40 }), async (s) => {
        const esc = JSON.stringify(s)
        const out = await runCommandTool.execute({ command: `node -e "console.log(${esc})"` }, ctx)
        expect(typeof out).toBe("string")
        expect(out.length).toBeGreaterThan(0)
      }),
      { numRuns: 5 },
    )
  })
})
