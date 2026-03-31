import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import { createTesterAgent } from "../src/tester.js"

describe("Feature: createTesterAgent function exists and returns AgentDefinition", () => {
  it("should return an AgentDefinition with required properties", async () => {
    const agent = await createTesterAgent()
    
    expect(agent).toBeDefined()
    expect(typeof agent.role).toBe("string")
    expect(agent.role.length).toBeGreaterThan(0)
    expect(typeof agent.systemPrompt).toBe("string")
    expect(agent.systemPrompt.length).toBeGreaterThan(0)
    expect(Array.isArray(agent.tools)).toBe(true)
  })

  it("should return an AgentDefinition when profile is provided", async () => {
    const profile = {
      packageManager: "npm" as const,
      testFramework: "vitest" as const,
      language: "typescript" as const
    }
    
    const agent = await createTesterAgent(profile)
    
    expect(agent).toBeDefined()
    expect(typeof agent.role).toBe("string")
    expect(agent.role.length).toBeGreaterThan(0)
    expect(typeof agent.systemPrompt).toBe("string")
    expect(agent.systemPrompt.length).toBeGreaterThan(0)
    expect(Array.isArray(agent.tools)).toBe(true)
  })

  it("should return an AgentDefinition when profile is undefined", async () => {
    const agent = await createTesterAgent(undefined)
    
    expect(agent).toBeDefined()
    expect(typeof agent.role).toBe("string")
    expect(typeof agent.systemPrompt).toBe("string")
    expect(Array.isArray(agent.tools)).toBe(true)
  })
})

describe("Feature: AgentDefinition role property contains domain-specific content", () => {
  it("should have a role that indicates testing responsibility", async () => {
    const agent = await createTesterAgent()
    
    const role = agent.role.toLowerCase()
    expect(role).toMatch(/test|testing|spec|verification|quality/i)
  })
})

describe("Feature: AgentDefinition systemPrompt contains testing instructions", () => {
  it("should have a systemPrompt that mentions testing concepts", async () => {
    const agent = await createTesterAgent()
    
    const prompt = agent.systemPrompt.toLowerCase()
    expect(prompt).toMatch(/test|testing|spec|assert|verify|behavior/i)
  })

  it("should adapt systemPrompt based on toolchain profile", async () => {
    const vitestProfile = {
      packageManager: "npm" as const,
      testFramework: "vitest" as const,
      language: "typescript" as const
    }
    
    const jestProfile = {
      packageManager: "yarn" as const,
      testFramework: "jest" as const,
      language: "javascript" as const
    }
    
    const vitestAgent = await createTesterAgent(vitestProfile)
    const jestAgent = await createTesterAgent(jestProfile)
    
    // Prompts should be different when profiles differ
    expect(vitestAgent.systemPrompt).not.toBe(jestAgent.systemPrompt)
  })
})

describe("Feature: Property-based testing with various ToolchainProfile inputs", () => {
  it("should handle arbitrary valid ToolchainProfile configurations", async () => {
    await fc.assert(fc.asyncProperty(
      fc.record({
        packageManager: fc.constantFrom("npm", "yarn", "pnpm"),
        testFramework: fc.constantFrom("vitest", "jest", "mocha"),
        language: fc.constantFrom("typescript", "javascript")
      }),
      async (profile) => {
        const agent = await createTesterAgent(profile)
        
        expect(agent).toBeDefined()
        expect(typeof agent.role).toBe("string")
        expect(agent.role.length).toBeGreaterThan(0)
        expect(typeof agent.systemPrompt).toBe("string")
        expect(agent.systemPrompt.length).toBeGreaterThan(0)
        expect(Array.isArray(agent.tools)).toBe(true)
      }
    ))
  })
})

describe("Feature: Negative tests for edge cases", () => {
  it("should handle empty profile object", async () => {
    const emptyProfile = {} as any
    const agent = await createTesterAgent(emptyProfile)
    
    expect(agent).toBeDefined()
    expect(typeof agent.role).toBe("string")
    expect(typeof agent.systemPrompt).toBe("string")
    expect(Array.isArray(agent.tools)).toBe(true)
  })

  it("should handle profile with null values", async () => {
    const nullProfile = {
      packageManager: null,
      testFramework: null,
      language: null
    } as any
    
    const agent = await createTesterAgent(nullProfile)
    
    expect(agent).toBeDefined()
    expect(typeof agent.role).toBe("string")
    expect(typeof agent.systemPrompt).toBe("string")
    expect(Array.isArray(agent.tools)).toBe(true)
  })

  it("should handle profile with invalid enum values", async () => {
    const invalidProfile = {
      packageManager: "invalid-pm",
      testFramework: "invalid-framework",
      language: "invalid-lang"
    } as any
    
    const agent = await createTesterAgent(invalidProfile)
    
    expect(agent).toBeDefined()
    expect(typeof agent.role).toBe("string")
    expect(typeof agent.systemPrompt).toBe("string")
    expect(Array.isArray(agent.tools)).toBe(true)
  })
})

describe("Feature: AgentDefinition tools array contains testing tools", () => {
  it("should provide tools array with at least one tool", async () => {
    const agent = await createTesterAgent()
    
    expect(agent.tools.length).toBeGreaterThan(0)
  })

  it("should provide tools that have required properties", async () => {
    const agent = await createTesterAgent()
    
    for (const tool of agent.tools) {
      expect(typeof tool.name).toBe("string")
      expect(tool.name.length).toBeGreaterThan(0)
      expect(typeof tool.description).toBe("string")
      expect(tool.description.length).toBeGreaterThan(0)
      expect(typeof tool.inputSchema).toBe("object")
      expect(typeof tool.execute).toBe("function")
    }
  })
})