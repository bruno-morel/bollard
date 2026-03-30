import { describe, expect, it } from "vitest"
import { createTesterAgent } from "../src/tester.js"

describe("createTesterAgent", () => {
  it("loads the tester prompt successfully", async () => {
    const agent = await createTesterAgent()
    expect(agent.systemPrompt).toBeTruthy()
    expect(agent.systemPrompt.length).toBeGreaterThan(100)
    expect(agent.systemPrompt).toContain("test engineer")
  })

  it("has zero tools for information isolation", async () => {
    const agent = await createTesterAgent()
    expect(agent.tools).toHaveLength(0)
  })

  it("has role set to tester", async () => {
    const agent = await createTesterAgent()
    expect(agent.role).toBe("tester")
  })

  it("has a conservative maxTurns", async () => {
    const agent = await createTesterAgent()
    expect(agent.maxTurns).toBeLessThanOrEqual(10)
    expect(agent.maxTurns).toBeGreaterThanOrEqual(1)
  })

  it("prompt instructs spec-based testing, not implementation testing", async () => {
    const agent = await createTesterAgent()
    expect(agent.systemPrompt).toContain("NOT seen the implementation")
    expect(agent.systemPrompt).toContain("BEHAVIOR")
    expect(agent.systemPrompt).toContain("fast-check")
  })
})
