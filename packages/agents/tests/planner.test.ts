import { describe, expect, it } from "vitest"
import { createPlannerAgent } from "../src/planner.js"
import { READ_ONLY_TOOLS } from "../src/tools/index.js"

describe("createPlannerAgent", () => {
  it("loads a non-empty system prompt", async () => {
    const agent = await createPlannerAgent()
    expect(agent.systemPrompt.length).toBeGreaterThan(100)
    expect(agent.systemPrompt).toContain("planning agent")
  })

  it("has the planner role", async () => {
    const agent = await createPlannerAgent()
    expect(agent.role).toBe("planner")
  })

  it("uses read-only tools only", async () => {
    const agent = await createPlannerAgent()
    expect(agent.tools).toEqual(READ_ONLY_TOOLS)
    const toolNames = agent.tools.map((t) => t.name)
    expect(toolNames).toContain("read_file")
    expect(toolNames).toContain("list_dir")
    expect(toolNames).toContain("search")
    expect(toolNames).not.toContain("write_file")
    expect(toolNames).not.toContain("run_command")
  })

  it("has conservative temperature and reasonable turn limit", async () => {
    const agent = await createPlannerAgent()
    expect(agent.temperature).toBeLessThanOrEqual(0.3)
    expect(agent.maxTurns).toBeGreaterThanOrEqual(10)
  })

  it("plan JSON can be parsed from mock response", () => {
    const mockPlanResponse = JSON.stringify({
      summary: "Add health check endpoint",
      acceptance_criteria: ["GET /health returns 200"],
      affected_files: { modify: ["src/app.ts"], create: ["src/health.ts"], delete: [] },
      risk_assessment: {
        blast_radius: 1,
        reversibility: 0,
        dollars_at_risk: 0,
        security_sensitivity: 0,
        novelty: 1,
        rationale: "Low-risk addition",
      },
      steps: [
        {
          description: "Create health endpoint",
          files: ["src/health.ts"],
          tests: "GET /health returns 200",
        },
      ],
      notes: "None",
    })

    const parsed: unknown = JSON.parse(mockPlanResponse)
    expect(parsed).toHaveProperty("summary")
    expect(parsed).toHaveProperty("acceptance_criteria")
    expect(parsed).toHaveProperty("affected_files")
    expect(parsed).toHaveProperty("risk_assessment")
    expect(parsed).toHaveProperty("steps")
  })
})
