import { defaultAdversarialConfig } from "@bollard/detect/src/concerns.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import { createPlannerAgent } from "../src/planner.js"
import { READ_ONLY_TOOLS } from "../src/tools/index.js"

function makeProfile(
  language: ToolchainProfile["language"],
  packageManager: NonNullable<ToolchainProfile["packageManager"]>,
  extra?: Partial<ToolchainProfile>,
): ToolchainProfile {
  return {
    language,
    packageManager,
    checks: {
      test: { label: "test", cmd: "npm", args: ["test"], source: "auto-detected" },
    },
    sourcePatterns: ["**/*.ts"],
    testPatterns: ["**/*.test.ts"],
    ignorePatterns: [],
    allowedCommands: ["npm", "npx"],
    adversarial: defaultAdversarialConfig({ language }),
    ...extra,
  }
}

describe("Feature: createPlannerAgent returns valid AgentDefinition", () => {
  it("should return an agent with required properties when called without profile", async () => {
    const agent = await createPlannerAgent()

    expect(agent.role).toBeTruthy()
    expect(typeof agent.systemPrompt).toBe("string")
    expect(agent.systemPrompt.length).toBeGreaterThan(0)
    expect(Array.isArray(agent.tools)).toBe(true)
    expect(agent.maxTurns).toBeGreaterThan(0)
    expect(typeof agent.temperature).toBe("number")
  })

  it("should return an agent with required properties when called with valid profile", async () => {
    const profile = makeProfile("typescript", "npm")
    const agent = await createPlannerAgent(profile)

    expect(agent.role).toBe("planner")
    expect(agent.systemPrompt.length).toBeGreaterThan(0)
    expect(agent.tools).toEqual(READ_ONLY_TOOLS)
  })

  it("should include planner-specific role identifier", async () => {
    const agent = await createPlannerAgent()
    expect(agent.role.toLowerCase()).toMatch(/plan/)
  })

  it("should include planning-related system prompt", async () => {
    const agent = await createPlannerAgent()
    expect(agent.systemPrompt.toLowerCase()).toMatch(/plan|step|task|break|analyze/)
  })

  it("should include read-only tools for analysis", async () => {
    const agent = await createPlannerAgent()
    expect(agent.tools.length).toBeGreaterThan(0)
    const toolNames = agent.tools.map((tool) => tool.name.toLowerCase())
    expect(toolNames.some((name) => name.includes("read") || name.includes("list"))).toBe(true)
  })
})

describe("Feature: createPlannerAgent handles different profile configurations", () => {
  it("should adapt system prompt based on package manager", async () => {
    const npmProfile = makeProfile("javascript", "npm")
    const yarnProfile = makeProfile("typescript", "yarn")

    const npmAgent = await createPlannerAgent(npmProfile)
    const yarnAgent = await createPlannerAgent(yarnProfile)

    expect(npmAgent.systemPrompt.toLowerCase()).toMatch(/npm/)
    expect(yarnAgent.systemPrompt.toLowerCase()).toMatch(/yarn/)
  })

  it("should adapt system prompt based on language / test tooling in template", async () => {
    const jsProfile = makeProfile("javascript", "npm")
    const tsProfile = makeProfile("typescript", "npm")

    const jsAgent = await createPlannerAgent(jsProfile)
    const tsAgent = await createPlannerAgent(tsProfile)

    expect(jsAgent.systemPrompt).not.toBe(tsAgent.systemPrompt)
  })
})

describe("Feature: createPlannerAgent property-based tests", () => {
  it("should always return consistent agent structure regardless of profile", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          language: fc.constantFrom<ToolchainProfile["language"]>(
            "javascript",
            "typescript",
          ),
          packageManager: fc.constantFrom("npm", "yarn", "pnpm"),
        }),
        async (fields) => {
          const profile = makeProfile(fields.language, fields.packageManager)
          const agent = await createPlannerAgent(profile)

          expect(typeof agent.role).toBe("string")
          expect(agent.role.length).toBeGreaterThan(0)
          expect(typeof agent.systemPrompt).toBe("string")
          expect(agent.systemPrompt.length).toBeGreaterThan(0)
          expect(Array.isArray(agent.tools)).toBe(true)
          expect(agent.tools.length).toBeGreaterThan(0)

          for (const tool of agent.tools) {
            expect(typeof tool.name).toBe("string")
            expect(tool.name.length).toBeGreaterThan(0)
            expect(typeof tool.description).toBe("string")
            expect(tool.description.length).toBeGreaterThan(0)
          }
        },
      ),
    )
  })
})

describe("Feature: createPlannerAgent error conditions", () => {
  it("should handle profile with minimal fields", async () => {
    const profile = makeProfile("javascript", "npm")
    const agent = await createPlannerAgent(profile)
    expect(agent.role).toBeTruthy()
    expect(agent.systemPrompt).toBeTruthy()
    expect(agent.tools.length).toBeGreaterThan(0)
  })

  it("should handle unusual but valid combinations", async () => {
    const unusual = makeProfile("typescript", "pnpm")
    const agent = await createPlannerAgent(unusual)
    expect(agent.role).toBeTruthy()
    expect(agent.systemPrompt).toBeTruthy()
  })

  it("should handle undefined profile gracefully", async () => {
    const agent = await createPlannerAgent(undefined)
    expect(agent.role).toBeTruthy()
    expect(agent.systemPrompt.length).toBeGreaterThan(0)
    expect(agent.tools.length).toBeGreaterThan(0)
  })
})

describe("Feature: createPlannerAgent domain-specific behavior", () => {
  it("should provide read-only tools only", async () => {
    const agent = await createPlannerAgent()
    const toolNames = agent.tools.map((tool) => tool.name.toLowerCase())
    const hasWriteTools = toolNames.some(
      (name) =>
        name.includes("write") ||
        name.includes("run_command") ||
        name.includes("edit"),
    )
    expect(hasWriteTools).toBe(false)
  })

  it("should generate different system prompts for different languages", async () => {
    const webProfile = makeProfile("typescript", "npm")
    const pyProfile = makeProfile("python", "pip")

    const webAgent = await createPlannerAgent(webProfile)
    const pyAgent = await createPlannerAgent(pyProfile)

    expect(webAgent.systemPrompt).not.toBe(pyAgent.systemPrompt)
  })
})
