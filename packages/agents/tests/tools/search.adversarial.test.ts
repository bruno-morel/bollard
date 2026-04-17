import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "@bollard/engine/src/context.js"
import type { BollardConfig } from "@bollard/engine/src/context.js"
import type { AgentContext } from "../../src/types.js"
import { searchTool } from "../../src/tools/search.js"

const testConfig: BollardConfig = {
  llm: { default: { provider: "mock", model: "m" } },
  agent: { max_cost_usd: 10, max_duration_minutes: 30 },
}

let workDir: string
let ctx: AgentContext

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "bollard-search-"))
  ctx = {
    pipelineCtx: createContext("t", "bp", testConfig),
    workDir,
  }
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe("searchTool", () => {
  it("finds literal substring", async () => {
    writeFileSync(join(workDir, "a.txt"), "hello unique-token-xyz")
    const out = await searchTool.execute({ pattern: "unique-token-xyz" }, ctx)
    expect(out).toContain("a.txt")
    expect(out).toContain("unique-token-xyz")
  })

  it("supports regex mode for dollar amounts", async () => {
    writeFileSync(join(workDir, "price.txt"), "cost $100")
    const out = await searchTool.execute({ pattern: String.raw`\$\d+`, regex: true }, ctx)
    expect(out).toContain("$100")
  })

  it("rejects path traversal", async () => {
    await expect(searchTool.execute({ pattern: "x", path: "../../../etc" }, ctx)).rejects.toThrow(/traversal/)
  })
})

describe("searchTool property tests", () => {
  it("returns a string for any safe literal pattern", async () => {
    const sub = join(workDir, "sub")
    mkdirSync(sub)
    writeFileSync(join(sub, "f.txt"), "needle")
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ minLength: 1, maxLength: 12 })
          .filter((p) => !/[\\"]/.test(p) && !p.startsWith("-")),
        async (pat) => {
        fc.pre(!pat.includes("\0"))
        const out = await searchTool.execute({ pattern: pat, path: "sub" }, ctx)
        expect(typeof out).toBe("string")
      }),
      { numRuns: 8 },
    )
  })
})
