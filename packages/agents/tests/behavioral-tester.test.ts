import { defaultAdversarialConfig } from "@bollard/detect/src/concerns.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { describe, expect, it } from "vitest"
import { createBehavioralTesterAgent } from "../src/behavioral-tester.js"

const TS_PROFILE: ToolchainProfile = {
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

describe("createBehavioralTesterAgent", () => {
  it("loads prompt and sets role and tuning", async () => {
    const agent = await createBehavioralTesterAgent(TS_PROFILE)
    expect(agent.role).toBe("behavioral-tester")
    expect(agent.tools).toHaveLength(0)
    expect(agent.maxTurns).toBe(15)
    expect(agent.temperature).toBe(0.5)
  })

  it("renders behavioral concern sections with weights", async () => {
    const agent = await createBehavioralTesterAgent(TS_PROFILE)
    expect(agent.systemPrompt).toContain("### Correctness [MEDIUM]")
    expect(agent.systemPrompt).toContain("BehavioralContext")
  })

  it("includes JSON claims output instructions", async () => {
    const agent = await createBehavioralTesterAgent(TS_PROFILE)
    expect(agent.systemPrompt).toContain("claims")
    expect(agent.systemPrompt).toContain("grounding")
  })

  it("strips concern blocks when weight is off", async () => {
    const p: ToolchainProfile = {
      ...TS_PROFILE,
      adversarial: {
        ...TS_PROFILE.adversarial,
        behavioral: {
          ...TS_PROFILE.adversarial.behavioral,
          concerns: {
            correctness: "off",
            security: "high",
            performance: "off",
            resilience: "high",
          },
        },
      },
    }
    const agent = await createBehavioralTesterAgent(p)
    expect(agent.systemPrompt).not.toContain("### Correctness")
    expect(agent.systemPrompt).toContain("### Security [HIGH]")
  })

  it("works without profile (fallback)", async () => {
    const agent = await createBehavioralTesterAgent()
    expect(agent.role).toBe("behavioral-tester")
    expect(agent.systemPrompt.length).toBeGreaterThan(100)
  })
})
