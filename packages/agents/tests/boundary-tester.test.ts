import { defaultAdversarialConfig } from "@bollard/detect/src/concerns.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { describe, expect, it } from "vitest"
import { createBoundaryTesterAgent } from "../src/boundary-tester.js"

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
  adversarial: defaultAdversarialConfig({ language: "python" }),
}

describe("createBoundaryTesterAgent", () => {
  it("loads the boundary-tester prompt successfully", async () => {
    const agent = await createBoundaryTesterAgent()
    expect(agent.systemPrompt).toBeTruthy()
    expect(agent.systemPrompt.length).toBeGreaterThan(100)
    expect(agent.systemPrompt).toContain("boundary-scope")
  })

  it("has zero tools for information isolation", async () => {
    const agent = await createBoundaryTesterAgent()
    expect(agent.tools).toHaveLength(0)
  })

  it("has role set to boundary-tester", async () => {
    const agent = await createBoundaryTesterAgent()
    expect(agent.role).toBe("boundary-tester")
  })

  it("has a conservative maxTurns", async () => {
    const agent = await createBoundaryTesterAgent()
    expect(agent.maxTurns).toBeLessThanOrEqual(10)
    expect(agent.maxTurns).toBeGreaterThanOrEqual(1)
  })

  it("prompt instructs spec-based testing, not implementation testing", async () => {
    const agent = await createBoundaryTesterAgent()
    expect(agent.systemPrompt).toContain("NOT seen the implementation")
    expect(agent.systemPrompt).toContain("BEHAVIOR")
    expect(agent.systemPrompt).toContain("fast-check")
  })

  it("renders default boundary concern weights (HIGH/MEDIUM/LOW)", async () => {
    const profile: ToolchainProfile = {
      language: "typescript",
      packageManager: "pnpm",
      checks: {
        test: { label: "Vitest", cmd: "pnpm", args: ["run", "test"], source: "auto-detected" },
      },
      sourcePatterns: ["**/*.ts"],
      testPatterns: ["**/*.test.ts"],
      ignorePatterns: [],
      allowedCommands: ["pnpm"],
      adversarial: defaultAdversarialConfig({ language: "typescript" }),
    }
    const agent = await createBoundaryTesterAgent(profile)
    expect(agent.systemPrompt).toContain("### Correctness [HIGH]")
    expect(agent.systemPrompt).toContain("### Security [HIGH]")
    expect(agent.systemPrompt).toContain("### Performance [LOW]")
    expect(agent.systemPrompt).toContain("Input validation bypasses")
  })

  it("strips concern block when weight is off", async () => {
    const base = defaultAdversarialConfig({ language: "typescript" })
    const profile: ToolchainProfile = {
      language: "typescript",
      checks: {},
      sourcePatterns: [],
      testPatterns: [],
      ignorePatterns: [],
      allowedCommands: [],
      adversarial: {
        ...base,
        boundary: {
          ...base.boundary,
          concerns: {
            correctness: "high",
            security: "off",
            performance: "off",
            resilience: "off",
          },
        },
      },
    }
    const agent = await createBoundaryTesterAgent(profile)
    expect(agent.systemPrompt).toContain("### Correctness [HIGH]")
    expect(agent.systemPrompt).not.toContain("### Security [")
    expect(agent.systemPrompt).not.toContain("Input validation bypasses")
  })

  it("with Python profile produces prompt mentioning pytest", async () => {
    const agent = await createBoundaryTesterAgent(PY_PROFILE)
    expect(agent.systemPrompt).toContain("pytest")
    expect(agent.systemPrompt).toContain("Output Format")
    expect(agent.systemPrompt).not.toContain("vitest")
  })

  it("Output Format uses claims JSON protocol with bnd ids and grounding", async () => {
    const agent = await createBoundaryTesterAgent()
    expect(agent.systemPrompt).toContain('"claims"')
    expect(agent.systemPrompt).toContain("grounding")
    expect(agent.systemPrompt).toContain("bnd")
    expect(agent.systemPrompt).not.toContain("Output ONLY the test file content")
  })
})
