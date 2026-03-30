import { describe, it, expect, vi, beforeEach } from "vitest"
import * as fc from "fast-check"
import { buildProjectTree, createAgenticHandler } from "../src/agent-handler.js"
import type { BlueprintNode, NodeResult } from "@bollard/engine/src/blueprint.js"
import type { BollardConfig, PipelineContext } from "@bollard/engine/src/context.js"

// Mock external dependencies
vi.mock("@bollard/agents/src/executor.js", () => ({
  executeAgent: vi.fn().mockResolvedValue({
    response: "Mock agent response",
    totalCostUsd: 0.05,
    totalDurationMs: 1500,
    turns: 3,
    toolCalls: []
  })
}))

vi.mock("@bollard/agents/src/planner.js", () => ({
  createPlannerAgent: vi.fn().mockReturnValue({
    role: "planner",
    instructions: "Mock planner instructions",
    tools: []
  })
}))

vi.mock("@bollard/agents/src/coder.js", () => ({
  createCoderAgent: vi.fn().mockReturnValue({
    role: "coder", 
    instructions: "Mock coder instructions",
    tools: []
  })
}))

vi.mock("@bollard/agents/src/tester.js", () => ({
  createTesterAgent: vi.fn().mockReturnValue({
    role: "tester",
    instructions: "Mock tester instructions", 
    tools: []
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
  readFile: vi.fn(),
  readdir: vi.fn()
}))

vi.mock("node:child_process", () => ({
  execFile: vi.fn()
}))

describe("Feature: buildProjectTree returns string representation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("should return a string for valid directory", async () => {
    const { readdir, readFile } = await import("node:fs/promises")
    vi.mocked(readdir).mockResolvedValue(["file1.ts", "file2.js"] as any)
    vi.mocked(readFile).mockResolvedValue("mock file content")

    const result = await buildProjectTree("/valid/path")
    
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })

  it("should handle empty directories", async () => {
    const { readdir } = await import("node:fs/promises")
    vi.mocked(readdir).mockResolvedValue([] as any)

    const result = await buildProjectTree("/empty/dir")
    
    expect(typeof result).toBe("string")
  })

  it("should handle filesystem errors gracefully", async () => {
    const { readdir } = await import("node:fs/promises")
    vi.mocked(readdir).mockRejectedValue(new Error("ENOENT: no such file or directory"))

    await expect(buildProjectTree("/nonexistent")).rejects.toThrow()
  })
})

describe("Feature: buildProjectTree property-based tests", () => {
  it("should always return non-empty string for any valid path", async () => {
    const { readdir, readFile } = await import("node:fs/promises")
    vi.mocked(readdir).mockResolvedValue(["test.js"] as any)
    vi.mocked(readFile).mockResolvedValue("content")

    await fc.assert(fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 100 }).filter(s => !s.includes('\0')),
      async (workDir) => {
        const result = await buildProjectTree(workDir)
        expect(typeof result).toBe("string")
        expect(result.length).toBeGreaterThan(0)
      }
    ))
  })
})

describe("Feature: createAgenticHandler returns function", () => {
  const mockConfig: BollardConfig = {
    llm: {
      default: {
        provider: "openai",
        model: "gpt-4"
      }
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("should return a function", async () => {
    const handler = await createAgenticHandler(mockConfig, "/test/dir")
    
    expect(typeof handler).toBe("function")
  })

  it("should create handler that processes blueprint nodes", async () => {
    const { readdir, readFile } = await import("node:fs/promises")
    vi.mocked(readdir).mockResolvedValue(["test.ts"] as any)
    vi.mocked(readFile).mockResolvedValue("test content")

    const handler = await createAgenticHandler(mockConfig, "/test/dir")
    
    const mockNode: BlueprintNode = {
      id: "test-node",
      type: "planner",
      dependencies: [],
      metadata: {}
    }
    
    const mockContext: PipelineContext = {
      workDir: "/test/dir",
      config: mockConfig
    }

    const result = await handler(mockNode, mockContext)
    
    expect(result).toBeDefined()
    expect(typeof result).toBe("object")
  })

  it("should handle different node types", async () => {
    const { readdir, readFile } = await import("node:fs/promises")
    vi.mocked(readdir).mockResolvedValue([] as any)
    vi.mocked(readFile).mockResolvedValue("")

    const handler = await createAgenticHandler(mockConfig, "/test/dir")
    
    const nodeTypes = ["planner", "coder", "tester"]
    
    for (const nodeType of nodeTypes) {
      const mockNode: BlueprintNode = {
        id: `${nodeType}-node`,
        type: nodeType as any,
        dependencies: [],
        metadata: {}
      }
      
      const mockContext: PipelineContext = {
        workDir: "/test/dir", 
        config: mockConfig
      }

      const result = await handler(mockNode, mockContext)
      expect(result).toBeDefined()
    }
  })

  it("should reject invalid config", async () => {
    const invalidConfig = {} as BollardConfig

    await expect(createAgenticHandler(invalidConfig, "/test/dir")).rejects.toThrow()
  })

  it("should reject invalid work directory", async () => {
    const { readdir } = await import("node:fs/promises")
    vi.mocked(readdir).mockRejectedValue(new Error("ENOENT"))

    await expect(createAgenticHandler(mockConfig, "/nonexistent/dir")).rejects.toThrow()
  })
})

describe("Feature: createAgenticHandler property-based tests", () => {
  it("should always return function for valid inputs", async () => {
    const { readdir, readFile } = await import("node:fs/promises")
    vi.mocked(readdir).mockResolvedValue([] as any)
    vi.mocked(readFile).mockResolvedValue("")

    const validConfig: BollardConfig = {
      llm: {
        default: {
          provider: "openai",
          model: "gpt-4"
        }
      }
    }

    await fc.assert(fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes('\0')),
      async (workDir) => {
        const handler = await createAgenticHandler(validConfig, workDir)
        expect(typeof handler).toBe("function")
      }
    ))
  })
})

describe("Feature: handler function processes nodes correctly", () => {
  it("should handle nodes with complex metadata", async () => {
    const { readdir, readFile } = await import("node:fs/promises")
    vi.mocked(readdir).mockResolvedValue(["complex.ts"] as any)
    vi.mocked(readFile).mockResolvedValue("complex content")

    const mockConfig: BollardConfig = {
      llm: {
        default: {
          provider: "anthropic",
          model: "claude-3"
        }
      }
    }

    const handler = await createAgenticHandler(mockConfig, "/complex/dir")
    
    const complexNode: BlueprintNode = {
      id: "complex-node",
      type: "coder",
      dependencies: ["dep1", "dep2"],
      metadata: {
        task: "Complex coding task",
        files: ["src/main.ts", "src/utils.ts"],
        requirements: ["TypeScript", "ESLint"]
      }
    }
    
    const mockContext: PipelineContext = {
      workDir: "/complex/dir",
      config: mockConfig
    }

    const result = await handler(complexNode, mockContext)
    
    expect(result).toBeDefined()
    expect(typeof result).toBe("object")
  })

  it("should handle empty metadata", async () => {
    const { readdir, readFile } = await import("node:fs/promises")
    vi.mocked(readdir).mockResolvedValue([] as any)
    vi.mocked(readFile).mockResolvedValue("")

    const mockConfig: BollardConfig = {
      llm: {
        default: {
          provider: "openai",
          model: "gpt-3.5-turbo"
        }
      }
    }

    const handler = await createAgenticHandler(mockConfig, "/empty/dir")
    
    const emptyNode: BlueprintNode = {
      id: "empty-node", 
      type: "planner",
      dependencies: [],
      metadata: {}
    }
    
    const mockContext: PipelineContext = {
      workDir: "/empty/dir",
      config: mockConfig
    }

    const result = await handler(emptyNode, mockContext)
    
    expect(result).toBeDefined()
  })

  it("should handle nodes with many dependencies", async () => {
    const { readdir, readFile } = await import("node:fs/promises")
    vi.mocked(readdir).mockResolvedValue(["dep.ts"] as any)
    vi.mocked(readFile).mockResolvedValue("dependency content")

    const mockConfig: BollardConfig = {
      llm: {
        default: {
          provider: "openai",
          model: "gpt-4"
        }
      }
    }

    const handler = await createAgenticHandler(mockConfig, "/deps/dir")
    
    const depNode: BlueprintNode = {
      id: "dep-heavy-node",
      type: "tester", 
      dependencies: Array.from({ length: 10 }, (_, i) => `dep-${i}`),
      metadata: { testType: "integration" }
    }
    
    const mockContext: PipelineContext = {
      workDir: "/deps/dir",
      config: mockConfig
    }

    const result = await handler(depNode, mockContext)
    
    expect(result).toBeDefined()
  })
})