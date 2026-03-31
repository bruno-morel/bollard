import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import { createPlannerAgent } from "../src/planner.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"

describe("Feature: createPlannerAgent returns valid AgentDefinition", () => {
  it("should return an agent with required properties when called without profile", async () => {
    const agent = await createPlannerAgent()
    
    expect(agent).toHaveProperty("role")
    expect(typeof agent.role).toBe("string")
    expect(agent.role.length).toBeGreaterThan(0)
    
    expect(agent).toHaveProperty("instructions")
    expect(typeof agent.instructions).toBe("string")
    expect(agent.instructions.length).toBeGreaterThan(0)
    
    expect(agent).toHaveProperty("tools")
    expect(Array.isArray(agent.tools)).toBe(true)
  })

  it("should return an agent with required properties when called with valid profile", async () => {
    const profile: ToolchainProfile = {
      name: "test-project",
      packageManager: "npm",
      framework: "node",
      language: "typescript",
      buildTool: "tsc",
      testFramework: "vitest"
    }
    
    const agent = await createPlannerAgent(profile)
    
    expect(agent).toHaveProperty("role")
    expect(typeof agent.role).toBe("string")
    expect(agent.role.length).toBeGreaterThan(0)
    
    expect(agent).toHaveProperty("instructions")
    expect(typeof agent.instructions).toBe("string")
    expect(agent.instructions.length).toBeGreaterThan(0)
    
    expect(agent).toHaveProperty("tools")
    expect(Array.isArray(agent.tools)).toBe(true)
  })

  it("should include planner-specific role identifier", async () => {
    const agent = await createPlannerAgent()
    expect(agent.role.toLowerCase()).toMatch(/plan|architect|design/)
  })

  it("should include planning-related instructions", async () => {
    const agent = await createPlannerAgent()
    expect(agent.instructions.toLowerCase()).toMatch(/plan|step|task|break|analyze/)
  })

  it("should include read-only tools for analysis", async () => {
    const agent = await createPlannerAgent()
    expect(agent.tools.length).toBeGreaterThan(0)
    
    // Planner should have tools for reading/analyzing code
    const toolNames = agent.tools.map(tool => tool.name.toLowerCase())
    expect(toolNames.some(name => name.includes("read") || name.includes("list") || name.includes("analyze"))).toBe(true)
  })
})

describe("Feature: createPlannerAgent handles different profile configurations", () => {
  it("should adapt instructions based on package manager", async () => {
    const npmProfile: ToolchainProfile = {
      name: "npm-project",
      packageManager: "npm",
      framework: "node",
      language: "javascript",
      buildTool: "webpack",
      testFramework: "jest"
    }
    
    const yarnProfile: ToolchainProfile = {
      name: "yarn-project", 
      packageManager: "yarn",
      framework: "react",
      language: "typescript",
      buildTool: "vite",
      testFramework: "vitest"
    }
    
    const npmAgent = await createPlannerAgent(npmProfile)
    const yarnAgent = await createPlannerAgent(yarnProfile)
    
    // Instructions should reference the appropriate package manager
    expect(npmAgent.instructions.toLowerCase()).toMatch(/npm/)
    expect(yarnAgent.instructions.toLowerCase()).toMatch(/yarn/)
  })

  it("should adapt instructions based on test framework", async () => {
    const jestProfile: ToolchainProfile = {
      name: "jest-project",
      packageManager: "npm",
      framework: "node", 
      language: "javascript",
      buildTool: "webpack",
      testFramework: "jest"
    }
    
    const vitestProfile: ToolchainProfile = {
      name: "vitest-project",
      packageManager: "npm",
      framework: "node",
      language: "typescript", 
      buildTool: "vite",
      testFramework: "vitest"
    }
    
    const jestAgent = await createPlannerAgent(jestProfile)
    const vitestAgent = await createPlannerAgent(vitestProfile)
    
    // Instructions should reference the appropriate test framework
    expect(jestAgent.instructions.toLowerCase()).toMatch(/jest/)
    expect(vitestAgent.instructions.toLowerCase()).toMatch(/vitest/)
  })
})

describe("Feature: createPlannerAgent property-based tests", () => {
  it("should always return consistent agent structure regardless of profile", async () => {
    await fc.assert(fc.asyncProperty(
      fc.record({
        name: fc.string({ minLength: 1, maxLength: 50 }),
        packageManager: fc.constantFrom("npm", "yarn", "pnpm"),
        framework: fc.constantFrom("node", "react", "vue", "angular", "express"),
        language: fc.constantFrom("javascript", "typescript"),
        buildTool: fc.constantFrom("webpack", "vite", "rollup", "tsc", "esbuild"),
        testFramework: fc.constantFrom("jest", "vitest", "mocha", "tap")
      }),
      async (profile: ToolchainProfile) => {
        const agent = await createPlannerAgent(profile)
        
        // Agent structure invariants
        expect(typeof agent.role).toBe("string")
        expect(agent.role.length).toBeGreaterThan(0)
        expect(typeof agent.instructions).toBe("string") 
        expect(agent.instructions.length).toBeGreaterThan(0)
        expect(Array.isArray(agent.tools)).toBe(true)
        expect(agent.tools.length).toBeGreaterThan(0)
        
        // All tools should have required properties
        agent.tools.forEach(tool => {
          expect(typeof tool.name).toBe("string")
          expect(tool.name.length).toBeGreaterThan(0)
          expect(typeof tool.description).toBe("string")
          expect(tool.description.length).toBeGreaterThan(0)
        })
      }
    ))
  })
})

describe("Feature: createPlannerAgent error conditions", () => {
  it("should handle profile with empty string values", async () => {
    const emptyProfile: ToolchainProfile = {
      name: "",
      packageManager: "npm",
      framework: "node",
      language: "javascript", 
      buildTool: "webpack",
      testFramework: "jest"
    }
    
    const agent = await createPlannerAgent(emptyProfile)
    expect(agent).toHaveProperty("role")
    expect(agent).toHaveProperty("instructions")
    expect(agent).toHaveProperty("tools")
  })

  it("should handle profile with unusual but valid combinations", async () => {
    const unusualProfile: ToolchainProfile = {
      name: "weird-project",
      packageManager: "pnpm",
      framework: "angular",
      language: "typescript",
      buildTool: "esbuild", 
      testFramework: "tap"
    }
    
    const agent = await createPlannerAgent(unusualProfile)
    expect(agent.role).toBeTruthy()
    expect(agent.instructions).toBeTruthy()
    expect(agent.tools.length).toBeGreaterThan(0)
  })

  it("should handle undefined profile gracefully", async () => {
    const agent = await createPlannerAgent(undefined)
    expect(agent).toHaveProperty("role")
    expect(agent).toHaveProperty("instructions") 
    expect(agent).toHaveProperty("tools")
    expect(agent.tools.length).toBeGreaterThan(0)
  })
})

describe("Feature: createPlannerAgent domain-specific behavior", () => {
  it("should provide tools appropriate for planning phase", async () => {
    const agent = await createPlannerAgent()
    
    // Planner should not have write/modify tools - only read/analyze
    const toolNames = agent.tools.map(tool => tool.name.toLowerCase())
    const hasWriteTools = toolNames.some(name => 
      name.includes("write") || 
      name.includes("create") || 
      name.includes("modify") ||
      name.includes("delete") ||
      name.includes("execute")
    )
    
    expect(hasWriteTools).toBe(false)
  })

  it("should generate different instructions for different project types", async () => {
    const webProfile: ToolchainProfile = {
      name: "web-app",
      packageManager: "npm",
      framework: "react",
      language: "typescript",
      buildTool: "vite",
      testFramework: "vitest"
    }
    
    const nodeProfile: ToolchainProfile = {
      name: "api-server", 
      packageManager: "npm",
      framework: "express",
      language: "javascript",
      buildTool: "webpack",
      testFramework: "jest"
    }
    
    const webAgent = await createPlannerAgent(webProfile)
    const nodeAgent = await createPlannerAgent(nodeProfile)
    
    // Instructions should be contextually different
    expect(webAgent.instructions).not.toBe(nodeAgent.instructions)
    
    // Web project should mention frontend concerns
    expect(webAgent.instructions.toLowerCase()).toMatch(/component|ui|frontend|browser/)
    
    // Node project should mention backend concerns  
    expect(nodeAgent.instructions.toLowerCase()).toMatch(/server|api|backend|endpoint/)
  })
})