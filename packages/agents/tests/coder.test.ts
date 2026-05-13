import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { createCoderAgent } from "../src/coder.js"
import { createPlannerAgent } from "../src/planner.js"
import { ALL_TOOLS } from "../src/tools/index.js"

describe("createCoderAgent", () => {
  it("loads a non-empty system prompt", async () => {
    const agent = await createCoderAgent()
    expect(agent.systemPrompt.length).toBeGreaterThan(100)
    expect(agent.systemPrompt).toContain("code agent")
  })

  it("has the coder role", async () => {
    const agent = await createCoderAgent()
    expect(agent.role).toBe("coder")
  })

  it("uses all tools including write, edit, and command", async () => {
    const agent = await createCoderAgent()
    expect(agent.tools).toEqual(ALL_TOOLS)
    const toolNames = agent.tools.map((t) => t.name)
    expect(toolNames).toContain("read_file")
    expect(toolNames).toContain("write_file")
    expect(toolNames).toContain("edit_file")
    expect(toolNames).toContain("list_dir")
    expect(toolNames).toContain("search")
    expect(toolNames).toContain("run_command")
  })

  it("has 60 max turns", async () => {
    const coder = await createCoderAgent()
    expect(coder.maxTurns).toBe(60)
  })

  it("has more turns than the planner", async () => {
    const coder = await createCoderAgent()
    const planner = await createPlannerAgent()
    expect(coder.maxTurns).toBeGreaterThan(planner.maxTurns)
  })

  it("coder prompt template includes scope guard section", async () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const raw = await readFile(resolve(dir, "../prompts/coder.md"), "utf-8")
    expect(raw).toContain("Do NOT retrofit patterns to adjacent methods")
  })

  it("coder prompt template includes turn 52 hard exit signal", async () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const raw = await readFile(resolve(dir, "../prompts/coder.md"), "utf-8")
    expect(raw).toContain("TURN 52")
  })
})
