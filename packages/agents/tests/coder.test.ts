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

  it("has 80 max turns", async () => {
    const coder = await createCoderAgent()
    expect(coder.maxTurns).toBe(80)
  })

  it("has more turns than the planner", async () => {
    const coder = await createCoderAgent()
    const planner = await createPlannerAgent()
    expect(coder.maxTurns).toBeGreaterThan(planner.maxTurns)
  })
})
