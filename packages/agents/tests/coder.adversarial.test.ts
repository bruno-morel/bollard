import { defaultAdversarialConfig } from "@bollard/detect/src/concerns.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import { createCoderAgent } from "../src/coder.js"
import { ALL_TOOLS } from "../src/tools/index.js"

function makeProfile(language: ToolchainProfile["language"]): ToolchainProfile {
  return {
    language,
    packageManager: "npm",
    checks: {
      typecheck: { label: "tsc", cmd: "npx", args: ["tsc"], source: "auto-detected" },
      lint: { label: "eslint", cmd: "npx", args: ["eslint"], source: "auto-detected" },
      test: { label: "vitest", cmd: "npm", args: ["test"], source: "auto-detected" },
    },
    sourcePatterns: ["**/*.ts"],
    testPatterns: ["**/*.test.ts"],
    ignorePatterns: [],
    allowedCommands: ["npm", "npx", "node"],
    adversarial: defaultAdversarialConfig({ language }),
  }
}

describe("Feature: createCoderAgent returns AgentDefinition", () => {
  it("should return required properties when called with no profile", async () => {
    const agent = await createCoderAgent()

    expect(agent).toBeDefined()
    expect(agent.role).toBe("coder")
    expect(typeof agent.systemPrompt).toBe("string")
    expect(agent.systemPrompt.length).toBeGreaterThan(0)
    expect(Array.isArray(agent.tools)).toBe(true)
    expect(agent.maxTurns).toBeGreaterThan(0)
    expect(typeof agent.temperature).toBe("number")
  })

  it("should return an AgentDefinition when called with undefined profile", async () => {
    const agent = await createCoderAgent(undefined)

    expect(agent.role).toBe("coder")
    expect(typeof agent.systemPrompt).toBe("string")
    expect(Array.isArray(agent.tools)).toBe(true)
  })

  it("should return an AgentDefinition when called with valid ToolchainProfile", async () => {
    const profile = makeProfile("typescript")
    const agent = await createCoderAgent(profile)

    expect(agent.role).toBe("coder")
    expect(agent.tools).toEqual(ALL_TOOLS)
    expect(agent.systemPrompt.length).toBeGreaterThan(0)
  })
})

describe("Feature: AgentDefinition has domain-specific coder properties", () => {
  it("should have coder role", async () => {
    const agent = await createCoderAgent()
    expect(agent.role).toBe("coder")
  })

  it("should have a system prompt that mentions implementation work", async () => {
    const agent = await createCoderAgent()
    const prompt = agent.systemPrompt.toLowerCase()
    expect(
      prompt.includes("code") ||
        prompt.includes("implement") ||
        prompt.includes("file") ||
        prompt.includes("tool"),
    ).toBe(true)
  })

  it("should include full tool set", async () => {
    const agent = await createCoderAgent()
    expect(agent.tools.length).toBe(ALL_TOOLS.length)
  })
})

describe("Feature: createCoderAgent property-based tests", () => {
  it("should preserve structure for supported language profiles", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<ToolchainProfile["language"]>("typescript", "javascript", "python"),
        async (language) => {
          const agent = await createCoderAgent(makeProfile(language))
          expect(agent.role).toBe("coder")
          expect(agent.tools.length).toBeGreaterThan(0)
          expect(agent.maxTurns).toBeGreaterThan(0)
        },
      ),
    )
  })
})
