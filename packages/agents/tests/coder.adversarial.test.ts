import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import { createCoderAgent } from "../src/coder.js"

describe("Feature: createCoderAgent function exists and returns AgentDefinition", () => {
  it("should return an AgentDefinition with required properties when called with no profile", async () => {
    const agent = await createCoderAgent()
    
    expect(agent).toBeDefined()
    expect(typeof agent).toBe("object")
    expect(typeof agent.name).toBe("string")
    expect(agent.name.length).toBeGreaterThan(0)
    expect(typeof agent.role).toBe("string")
    expect(agent.role.length).toBeGreaterThan(0)
    expect(typeof agent.systemPrompt).toBe("string")
    expect(agent.systemPrompt.length).toBeGreaterThan(0)
    expect(Array.isArray(agent.tools)).toBe(true)
  })

  it("should return an AgentDefinition when called with undefined profile", async () => {
    const agent = await createCoderAgent(undefined)
    
    expect(agent).toBeDefined()
    expect(typeof agent.name).toBe("string")
    expect(typeof agent.role).toBe("string")
    expect(typeof agent.systemPrompt).toBe("string")
    expect(Array.isArray(agent.tools)).toBe(true)
  })

  it("should return an AgentDefinition when called with valid ToolchainProfile", async () => {
    const profile = {
      language: "typescript",
      framework: "node",
      packageManager: "npm",
      testFramework: "vitest",
      buildTool: "tsc"
    }
    
    const agent = await createCoderAgent(profile)
    
    expect(agent).toBeDefined()
    expect(typeof agent.name).toBe("string")
    expect(typeof agent.role).toBe("string")
    expect(typeof agent.systemPrompt).toBe("string")
    expect(Array.isArray(agent.tools)).toBe(true)
  })
})

describe("Feature: AgentDefinition has domain-specific coder properties", () => {
  it("should have a role that indicates coding capability", async () => {
    const agent = await createCoderAgent()
    
    const role = agent.role.toLowerCase()
    expect(
      role.includes("code") || 
      role.includes("develop") || 
      role.includes("program") ||
      role.includes("engineer")
    ).toBe(true)
  })

  it("should have a system prompt that mentions coding or development", async () => {
    const agent = await createCoderAgent()
    
    const prompt = agent.systemPrompt.toLowerCase()
    expect(
      prompt.includes("code") ||
      prompt.includes("develop") ||
      prompt.includes("program") ||
      prompt.includes("implement") ||
      prompt.includes("software")
    ).toBe(true)
  })

  it("should have tools array with at least one tool", async () => {
    const agent = await createCoderAgent()
    
    expect(agent.tools.length).toBeGreaterThan(0)
  })
})

describe("Feature: ToolchainProfile integration affects agent configuration", () => {
  it("should produce different system prompts for different languages", async () => {
    const jsProfile = {
      language: "javascript",
      framework: "node",
      packageManager: "npm",
      testFramework: "jest",
      buildTool: "webpack"
    }
    
    const pyProfile = {
      language: "python",
      framework: "django",
      packageManager: "pip",
      testFramework: "pytest",
      buildTool: "setuptools"
    }
    
    const jsAgent = await createCoderAgent(jsProfile)
    const pyAgent = await createCoderAgent(pyProfile)
    
    expect(jsAgent.systemPrompt).not.toBe(pyAgent.systemPrompt)
  })

  it("should handle profile with all fields populated", async () => {
    const fullProfile = {
      language: "rust",
      framework: "actix-web",
      packageManager: "cargo",
      testFramework: "cargo-test",
      buildTool: "cargo",
      linter: "clippy",
      formatter: "rustfmt"
    }
    
    const agent = await createCoderAgent(fullProfile)
    
    expect(agent).toBeDefined()
    expect(typeof agent.systemPrompt).toBe("string")
    expect(agent.systemPrompt.length).toBeGreaterThan(0)
  })
})

describe("Property-based tests for ToolchainProfile variations", () => {
  it("should always return valid AgentDefinition regardless of profile content", async () => {
    await fc.assert(fc.asyncProperty(
      fc.record({
        language: fc.string({ minLength: 1, maxLength: 20 }),
        framework: fc.option(fc.string({ minLength: 1, maxLength: 20 })),
        packageManager: fc.option(fc.string({ minLength: 1, maxLength: 20 })),
        testFramework: fc.option(fc.string({ minLength: 1, maxLength: 20 })),
        buildTool: fc.option(fc.string({ minLength: 1, maxLength: 20 }))
      }),
      async (profile) => {
        const agent = await createCoderAgent(profile)
        
        expect(typeof agent.name).toBe("string")
        expect(agent.name.length).toBeGreaterThan(0)
        expect(typeof agent.role).toBe("string")
        expect(agent.role.length).toBeGreaterThan(0)
        expect(typeof agent.systemPrompt).toBe("string")
        expect(agent.systemPrompt.length).toBeGreaterThan(0)
        expect(Array.isArray(agent.tools)).toBe(true)
      }
    ))
  })
})

describe("Negative tests for edge cases", () => {
  it("should handle profile with empty strings", async () => {
    const emptyProfile = {
      language: "",
      framework: "",
      packageManager: "",
      testFramework: "",
      buildTool: ""
    }
    
    const agent = await createCoderAgent(emptyProfile)
    
    expect(agent).toBeDefined()
    expect(typeof agent.systemPrompt).toBe("string")
  })

  it("should handle profile with only language field", async () => {
    const minimalProfile = {
      language: "go"
    }
    
    const agent = await createCoderAgent(minimalProfile)
    
    expect(agent).toBeDefined()
    expect(typeof agent.name).toBe("string")
    expect(typeof agent.role).toBe("string")
    expect(typeof agent.systemPrompt).toBe("string")
    expect(Array.isArray(agent.tools)).toBe(true)
  })

  it("should handle profile with null/undefined optional fields", async () => {
    const sparseProfile = {
      language: "kotlin",
      framework: null,
      packageManager: undefined,
      testFramework: null,
      buildTool: undefined
    }
    
    const agent = await createCoderAgent(sparseProfile as any)
    
    expect(agent).toBeDefined()
    expect(typeof agent.systemPrompt).toBe("string")
  })
})