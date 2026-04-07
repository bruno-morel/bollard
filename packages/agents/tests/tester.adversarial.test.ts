import { defaultAdversarialConfig } from "@bollard/detect/src/concerns.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import { createBoundaryTesterAgent } from "../src/boundary-tester.js"

const baseProfile = (lang: ToolchainProfile["language"]): ToolchainProfile => ({
  language: lang,
  checks: {},
  sourcePatterns: [],
  testPatterns: [],
  ignorePatterns: [],
  allowedCommands: [],
  adversarial: defaultAdversarialConfig({ language: lang }),
})

describe("Feature: createBoundaryTesterAgent returns AgentDefinition", () => {
  it("returns required properties with empty tools", async () => {
    const agent = await createBoundaryTesterAgent()
    expect(agent.role).toBe("boundary-tester")
    expect(agent.systemPrompt.length).toBeGreaterThan(0)
    expect(agent.tools).toHaveLength(0)
  })

  it("accepts a full ToolchainProfile", async () => {
    const profile = baseProfile("typescript")
    profile.checks.test = {
      label: "Vitest",
      cmd: "pnpm",
      args: ["exec", "vitest", "run"],
      source: "auto-detected",
    }
    const agent = await createBoundaryTesterAgent(profile)
    expect(agent.role).toBe("boundary-tester")
    expect(agent.systemPrompt.toLowerCase()).toMatch(/test|vitest|adversarial|boundary/)
  })

  it("uses different prompts for TypeScript vs JavaScript profiles", async () => {
    const tsAgent = await createBoundaryTesterAgent(baseProfile("typescript"))
    const jsAgent = await createBoundaryTesterAgent(baseProfile("javascript"))
    expect(tsAgent.systemPrompt).not.toBe(jsAgent.systemPrompt)
  })
})

describe("Feature: property-based profile language variants", () => {
  it("handles typescript and javascript languages", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("typescript", "javascript" as const), async (lang) => {
        const agent = await createBoundaryTesterAgent(baseProfile(lang))
        expect(agent.role).toBe("boundary-tester")
        expect(agent.systemPrompt.length).toBeGreaterThan(0)
        expect(agent.tools).toHaveLength(0)
      }),
    )
  })
})
