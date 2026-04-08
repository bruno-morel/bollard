import { describe, it, expect, vi, beforeEach } from "vitest"
import * as fc from "fast-check"
import { buildProjectTree, createAgenticHandler } from "../src/agent-handler.js"
import type { BollardConfig, PipelineContext } from "@bollard/engine/src/context.js"
import type { BlueprintNode, NodeResult } from "@bollard/engine/src/blueprint.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { executeAgent } from "@bollard/agents/src/executor.js"
import { CostTracker } from "@bollard/engine/src/cost-tracker.js"

// Mock external dependencies
vi.mock("@bollard/agents/src/executor.js", () => ({
  executeAgent: vi.fn().mockResolvedValue({
    response: "Mock response",
    totalCostUsd: 0.01,
    totalDurationMs: 1000,
    turns: 1,
    toolCalls: []
  })
}))

vi.mock("@bollard/agents/src/planner.js", () => ({
  createPlannerAgent: vi.fn().mockReturnValue({
    role: "planner",
    instructions: "Mock planner",
    tools: []
  })
}))

vi.mock("@bollard/agents/src/coder.js", () => ({
  createCoderAgent: vi.fn().mockReturnValue({
    role: "coder", 
    instructions: "Mock coder",
    tools: []
  })
}))

vi.mock("@bollard/agents/src/boundary-tester.js", () => ({
  createBoundaryTesterAgent: vi.fn().mockReturnValue({
    role: "boundary-tester",
    instructions: "Mock boundary tester", 
    tools: []
  })
}))

vi.mock("@bollard/agents/src/contract-tester.js", () => ({
  createContractTesterAgent: vi.fn().mockReturnValue({
    role: "contract-tester",
    instructions: "Mock contract tester",
    tools: [],
    maxTurns: 10,
    temperature: 0.4,
  })
}))

vi.mock("@bollard/llm/src/client.js", () => ({
  LLMClient: vi.fn().mockImplementation(() => ({
    forAgent: vi.fn().mockReturnValue({
      provider: "openai",
      model: "gpt-4"
    })
  }))
}))

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue("mock file content"),
  readdir: vi.fn().mockResolvedValue(["file1.js", "file2.ts"])
}))

vi.mock("node:child_process", () => ({
  execFile: vi.fn()
}))

describe("Feature: buildProjectTree returns project structure as string", () => {
  it("should return a string representation of project structure", async () => {
    const result = await buildProjectTree("/test/dir")
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })

  it("should handle workDir with profile parameter", async () => {
    const profile: ToolchainProfile = {
      name: "node",
      packageManager: "npm",
      testFramework: "vitest",
      buildTool: "vite"
    }
    const result = await buildProjectTree("/test/dir", profile)
    expect(typeof result).toBe("string")
  })

  it("should work with various directory paths", () => {
    return fc.assert(fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 100 }).filter(s => !s.includes('\0')),
      async (workDir) => {
        const result = await buildProjectTree(workDir)
        expect(typeof result).toBe("string")
      }
    ))
  })
})

describe("Feature: buildProjectTree handles invalid inputs", () => {
  it("should handle empty string workDir", async () => {
    const result = await buildProjectTree("")
    expect(typeof result).toBe("string")
  })

  it("should handle null bytes in path", async () => {
    await expect(buildProjectTree("/test\0/dir")).rejects.toThrow()
  })

  it("should handle very long paths", async () => {
    const longPath = "/".repeat(5000)
    const result = await buildProjectTree(longPath)
    expect(typeof result).toBe("string")
  })
})

describe("Feature: createAgenticHandler returns node execution function", () => {
  let mockConfig: BollardConfig
  let mockNode: BlueprintNode
  let mockContext: PipelineContext

  beforeEach(() => {
    mockConfig = {
      llm: {
        default: {
          provider: "openai",
          model: "gpt-4"
        }
      }
    } as BollardConfig

    mockNode = {
      id: "test-node",
      type: "plan",
      description: "Test node",
      dependencies: []
    }

    mockContext = {
      workDir: "/test/work",
      config: mockConfig,
      results: new Map()
    }
  })

  it("should return a function that processes blueprint nodes", async () => {
    const handler = await createAgenticHandler(mockConfig, "/test/work")
    expect(typeof handler).toBe("function")
    
    const result = await handler(mockNode, mockContext)
    expect(result).toBeDefined()
    expect(typeof result.success).toBe("boolean")
  })

  it("should handle different node types", async () => {
    const handler = await createAgenticHandler(mockConfig, "/test/work")
    
    const nodeTypes = ["plan", "code", "test", "verify"]
    for (const type of nodeTypes) {
      const node = { ...mockNode, type }
      const result = await handler(node, mockContext)
      expect(result).toBeDefined()
    }
  })

  it("should work with profile parameter", async () => {
    const profile: ToolchainProfile = {
      name: "node",
      packageManager: "npm", 
      testFramework: "vitest",
      buildTool: "vite"
    }
    
    const handler = await createAgenticHandler(mockConfig, "/test/work", profile)
    const result = await handler(mockNode, mockContext)
    expect(result).toBeDefined()
  })
})

describe("Feature: createAgenticHandler handles various node configurations", () => {
  let mockConfig: BollardConfig

  beforeEach(() => {
    mockConfig = {
      llm: {
        default: {
          provider: "openai",
          model: "gpt-4"
        }
      }
    } as BollardConfig
  })

  it("should handle nodes with dependencies", async () => {
    const handler = await createAgenticHandler(mockConfig, "/test/work")
    
    const nodeWithDeps: BlueprintNode = {
      id: "dependent-node",
      type: "code",
      description: "Node with dependencies",
      dependencies: ["dep1", "dep2"]
    }

    const context: PipelineContext = {
      workDir: "/test/work",
      config: mockConfig,
      results: new Map([
        ["dep1", { success: true, output: "dep1 result" }],
        ["dep2", { success: true, output: "dep2 result" }]
      ])
    }

    const result = await handler(nodeWithDeps, context)
    expect(result.success).toBeDefined()
  })

  it("should process nodes with property-based inputs", () => {
    return fc.assert(fc.asyncProperty(
      fc.record({
        id: fc.string({ minLength: 1, maxLength: 50 }),
        type: fc.constantFrom("plan", "code", "test", "verify"),
        description: fc.string({ minLength: 1, maxLength: 200 }),
        dependencies: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 5 })
      }),
      async (nodeData) => {
        const handler = await createAgenticHandler(mockConfig, "/test/work")
        const context: PipelineContext = {
          workDir: "/test/work", 
          config: mockConfig,
          results: new Map()
        }
        
        const result = await handler(nodeData, context)
        expect(typeof result.success).toBe("boolean")
      }
    ))
  })
})

describe("Feature: createAgenticHandler error conditions", () => {
  it("should handle invalid config", async () => {
    const invalidConfig = {} as BollardConfig
    await expect(createAgenticHandler(invalidConfig, "/test/work")).rejects.toThrow()
  })

  it("should handle empty workDir", async () => {
    const config: BollardConfig = {
      llm: {
        default: {
          provider: "openai",
          model: "gpt-4"
        }
      }
    } as BollardConfig

    const handler = await createAgenticHandler(config, "")
    expect(typeof handler).toBe("function")
  })

  it("should handle malformed node objects", async () => {
    const config: BollardConfig = {
      llm: {
        default: {
          provider: "openai", 
          model: "gpt-4"
        }
      }
    } as BollardConfig

    const handler = await createAgenticHandler(config, "/test/work")
    const context: PipelineContext = {
      workDir: "/test/work",
      config,
      results: new Map()
    }

    const malformedNode = {
      id: "",
      type: "invalid-type",
      description: "",
      dependencies: []
    } as BlueprintNode

    const result = await handler(malformedNode, context)
    expect(typeof result.success).toBe("boolean")
  })
})

describe("contract-tester risk-gate guard", () => {
  it("skips contract-tester agent when risk gate fires with skipContract", async () => {
    const config: BollardConfig = {
      llm: {
        default: {
          provider: "anthropic",
          model: "claude-3-5-sonnet-20241022",
        },
      },
      agent: { max_cost_usd: 10, max_duration_minutes: 30 },
    }

    const scopeConfig = (enabled: boolean) => ({
      enabled,
      integration: "independent" as const,
      lifecycle: "ephemeral" as const,
      concerns: {
        correctness: "high" as const,
        security: "medium" as const,
        performance: "low" as const,
        resilience: "off" as const,
      },
    })

    const profile: ToolchainProfile = {
      language: "typescript",
      packageManager: "pnpm",
      checks: {},
      sourcePatterns: ["src/**/*.ts"],
      testPatterns: ["tests/**/*.test.ts"],
      ignorePatterns: ["node_modules"],
      allowedCommands: ["pnpm"],
      adversarial: {
        boundary: scopeConfig(true),
        contract: scopeConfig(true),
        behavioral: scopeConfig(false),
      },
    }

    const { handler } = await createAgenticHandler(config, "/test/work", profile)

    const node: BlueprintNode = {
      id: "generate-contract-tests",
      name: "Generate Contract Tests",
      type: "agentic",
      agent: "contract-tester",
    }

    const ctx: PipelineContext = {
      runId: "test-run-rg",
      task: "test task",
      blueprintId: "implement-feature",
      config,
      currentNode: "generate-contract-tests",
      results: {
        "assess-contract-risk": {
          status: "ok",
          data: { skipContract: true },
        },
      } as Record<string, PipelineContext["results"][string]>,
      changedFiles: [],
      toolchainProfile: profile,
      costTracker: new CostTracker(10),
      startedAt: Date.now(),
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      upgradeRunId: vi.fn(),
    }

    const result = await handler(node, ctx)

    expect(result).toEqual({
      status: "ok",
      data: "",
      cost_usd: 0,
      duration_ms: 0,
    })
    expect(executeAgent).not.toHaveBeenCalled()
  })
})