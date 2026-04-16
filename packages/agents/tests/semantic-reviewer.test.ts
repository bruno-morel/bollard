import { defaultAdversarialConfig } from "@bollard/detect/src/concerns.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { describe, expect, it } from "vitest"
import { createSemanticReviewerAgent } from "../src/semantic-reviewer.js"

const PROFILE: ToolchainProfile = {
  language: "python",
  packageManager: "pip",
  checks: {
    test: { label: "pytest", cmd: "pytest", args: [], source: "auto-detected" },
  },
  sourcePatterns: ["**/*.py"],
  testPatterns: ["**/*.py"],
  ignorePatterns: [],
  allowedCommands: ["pytest"],
  adversarial: defaultAdversarialConfig({ language: "python" }),
}

describe("createSemanticReviewerAgent", () => {
  it("creates agent with role semantic-reviewer", async () => {
    const agent = await createSemanticReviewerAgent(PROFILE)
    expect(agent.role).toBe("semantic-reviewer")
  })

  it("loads prompt from semantic-reviewer.md", async () => {
    const agent = await createSemanticReviewerAgent(PROFILE)
    expect(agent.systemPrompt.length).toBeGreaterThan(100)
    expect(agent.systemPrompt).toContain("semantic reviewer")
  })

  it("has no tools", async () => {
    const agent = await createSemanticReviewerAgent(PROFILE)
    expect(agent.tools).toHaveLength(0)
  })

  it("fills template placeholders from profile", async () => {
    const agent = await createSemanticReviewerAgent(PROFILE)
    expect(agent.systemPrompt).toContain("Python")
    expect(agent.systemPrompt).toContain("pytest")
  })
})
