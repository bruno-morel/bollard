import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { describe, expect, it } from "vitest"
import { createTesterAgent } from "../src/tester.js"

const PY_PROFILE: ToolchainProfile = {
  language: "python",
  packageManager: "poetry",
  checks: {
    test: {
      label: "pytest",
      cmd: "poetry",
      args: ["run", "pytest", "-v"],
      source: "auto-detected",
    },
  },
  sourcePatterns: ["**/*.py"],
  testPatterns: ["**/test_*.py"],
  ignorePatterns: ["__pycache__"],
  allowedCommands: ["python", "poetry"],
  adversarial: { mode: "blackbox" },
}

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

  it("with Python profile produces prompt mentioning pytest", async () => {
    const agent = await createTesterAgent(PY_PROFILE)
    expect(agent.systemPrompt).toContain("pytest")
    expect(agent.systemPrompt).toContain("import pytest")
    expect(agent.systemPrompt).not.toContain("vitest")
  })

  it("with Python profile includes Python output format", async () => {
    const agent = await createTesterAgent(PY_PROFILE)
    expect(agent.systemPrompt).toContain("hypothesis")
    expect(agent.systemPrompt).not.toContain("describe(")
  })
})
