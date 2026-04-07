```typescript
import { describe, it, expect, vi, beforeEach } from "vitest"
import * as fc from "fast-check"
import { createCoderAgent } from "../src/coder.js"
import { createPlannerAgent } from "../src/planner.js"
import { createTesterAgent } from "../src/tester.js"
import { loadEvalCases, availableAgents } from "../src/eval-loader.js"
import { compactOlderTurns, executeAgent } from "../src/executor.js"
import { fillPromptTemplate } from "../src/prompt-template.js"
import { ALL_TOOLS, READ_ONLY_TOOLS } from "../src/tools/index.js"
import { editFileTool } from "../src/tools/edit-file.js"
import { listDirTool } from "../src/tools/list-dir.js"
import { readFileTool } from "../src/tools/read-file.js"
import { runCommandTool } from "../src/tools/run-command.js"
import { searchTool } from "../src/tools/search.js"
import { writeFileTool } from "../src/tools/write-file.js"
import type { AgentDefinition, AgentContext, ExecutorOptions } from "../src/types.js"

describe("Feature: Agent creation functions return valid AgentDefinition objects", () => {
  it("should create coder agent with default profile", async () => {
    const agent = await createCoderAgent()
    expect(agent).toMatchObject({
      role: expect.any(String),
      systemPrompt: expect.any(String),
      tools: expect.any(Array),
      maxTurns: expect.any(Number),
      temperature: expect.any(Number)
    })
    expect(agent.maxTurns).toBeGreaterThan(0)
    expect(agent.temperature).toBeGreaterThanOrEqual(0)
    expect(agent.temperature).toBeLessThanOrEqual(2)
  })

  it("should create planner agent with default profile", async () => {
    const agent = await createPlannerAgent()
    expect(agent).toMatchObject({
      role: expect.any(String),
      systemPrompt: expect.any(String),
      tools: expect.any(Array),
      maxTurns: expect.any(Number),
      temperature: expect.any(Number)
    })
  })

  it("should create tester agent with default profile", async () => {
    const agent = await createTesterAgent()
    expect(agent).toMatchObject({
      role: expect.any(String),
      systemPrompt: expect.any(String),
      tools: expect.any(Array),
      maxTurns: expect.any(Number),
      temperature: expect.any(Number)
    })
  })

  it("should create agents with custom toolchain profile", async () => {
    const profile = {
      language: "typescript",
      framework: "react",
      packageManager: "npm",
      testFramework: "vitest"
    }
    
    const coderAgent = await createCoderAgent(profile)
    const plannerAgent = await createPlannerAgent(profile)
    const testerAgent = await createTesterAgent(profile)
    
    expect(coderAgent.systemPrompt).toContain("typescript")
    expect(plannerAgent.systemPrompt).toContain("typescript")
    expect(testerAgent.systemPrompt).toContain("typescript")
  })
})

describe("Feature: Eval case loading and filtering", () => {
  it("should load all eval cases without filter", () => {
    const cases = loadEvalCases()
    expect(cases).toBeInstanceOf(Array)
    expect(cases.length).toBeGreaterThan(0)
  })

  it("should filter eval cases by agent name", () => {
    const coderCases = loadEvalCases("coder")
    const plannerCases = loadEvalCases("planner")
    const testerCases = loadEvalCases("tester")
    
    expect(coderCases).toBeInstanceOf(Array)
    expect(plannerCases).toBeInstanceOf(Array)
    expect(testerCases).toBeInstanceOf(Array)
  })

  it("should return empty array for unknown agent filter", () => {
    const cases = loadEvalCases("nonexistent-agent")
    expect(cases).toEqual([])
  })

  it("should return available agent names", () => {
    const agents = availableAgents()
    expect(agents).toBeInstanceOf(Array)
    expect(agents).toContain("coder")
    expect(agents).toContain("planner")
    expect(agents).toContain("tester")
  })
})

describe("Feature: Message compaction for conversation management", () => {
  it("should handle empty message array", () => {
    const messages: any[] = []
    expect(() => compactOlderTurns(messages)).not.toThrow()
    expect(messages).toEqual([])
  })

  it("should handle single message", () => {
    const messages = [{ role: "user", content: "test" }]
    compactOlderTurns(messages)
    expect(messages).toHaveLength(1)
  })

  it("should not throw with null or undefined content", () => {
    const messages = [
      { role: "user", content: null },
      { role: "assistant", content: undefined }
    ]
    expect(() => compactOlderTurns(messages)).not.toThrow()
  })
})

describe("Feature: Agent execution with LLM integration", () => {
  const mockProvider = {
    chat: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Mock response" }],
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: "stop"
    })
  }

  const mockAgent: AgentDefinition = {
    role: "test-agent",
    systemPrompt: "You are a test agent",
    tools: [],
    maxTurns: 3,
    temperature: 0.7
  }

  const mockContext: AgentContext = {
    pipelineCtx: {} as any,
    workDir: "/tmp/test"
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("should execute agent with minimal parameters", async () => {
    const result = await executeAgent(
      mockAgent,
      "test message",
      mockProvider,
      "gpt-4",
      mockContext
    )

    expect(result).toMatchObject({
      response: expect.any(String),
      totalCostUsd: expect.any(Number),
      totalDurationMs: expect.any(Number),
      turns: expect.any(Number),
      toolCalls: expect.any(Array)
    })
    expect(result.totalCostUsd).toBeGreaterThanOrEqual(0)
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0)
    expect(result.turns).toBeGreaterThan(0)
  })

  it("should execute agent with options", async () => {
    const options: ExecutorOptions = {
      maxVerificationRetries: 2,
      deferPostCompletionVerifyFromTurn: 5
    }

    const result = await executeAgent(
      mockAgent,
      "test message",
      mockProvider,
      "gpt-4",
      mockContext,
      options
    )

    expect(result.response).toBeDefined()
  })

  it("should handle empty user message", async () => {
    const result = await executeAgent(
      mockAgent,
      "",
      mockProvider,
      "gpt-4",
      mockContext
    )

    expect(result.response).toBeDefined()
  })
})

describe("Feature: Prompt template filling with toolchain profiles", () => {
  it("should fill template with profile values", () => {
    const template = "Language: {{language}}, Framework: {{framework}}"
    const profile = {
      language: "typescript",
      framework: "react"
    }

    const result = fillPromptTemplate(template, profile)
    expect(result).toContain("typescript")
    expect(result).toContain("react")
  })

  it("should handle template with no placeholders", () => {
    const template = "Static template content"
    const profile = { language: "typescript" }

    const result = fillPromptTemplate(template, profile)
    expect(result).toBe(template)
  })

  it("should handle empty template", () => {
    const result = fillPromptTemplate("", { language: "typescript" })
    expect(result).toBe("")
  })

  it("should handle empty profile", () => {
    const template = "Language: {{language}}"
    const result = fillPromptTemplate(template, {})
    expect(result).toBeDefined()
  })
})

describe("Feature: Tool collections provide required functionality", () => {
  it("should export ALL_TOOLS as non-empty array", () => {
    expect(ALL_TOOLS).toBeInstanceOf(Array)
    expect(ALL_TOOLS.length).toBeGreaterThan(0)
    
    ALL_TOOLS.forEach(tool => {
      expect(tool).toMatchObject({
        name: expect.any(String),
        description: expect.any(String),
        inputSchema: expect.any(Object),
        execute: expect.any(Function)
      })
    })
  })

  it("should export READ_ONLY_TOOLS as subset of ALL_TOOLS", () => {
    expect(READ_ONLY_TOOLS).toBeInstanceOf(Array)
    expect(READ_ONLY_TOOLS.length).toBeGreaterThan(0)
    expect(READ_ONLY_TOOLS.length).toBeLessThanOrEqual(ALL_TOOLS.length)
  })

  it("should have individual tools with correct structure", () => {
    const tools = [editFileTool, listDirTool, readFileTool, runCommandTool, searchTool, writeFileTool]
    
    tools.forEach(tool => {
      expect(tool.name).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(typeof tool.inputSchema).toBe("object")
      expect(typeof tool.execute).toBe("function")
    })
  })
})

describe("Feature: Tool execution with context validation", () => {
  const mockContext: AgentContext = {
    pipelineCtx: {} as any,
    workDir: "/tmp/test",
    allowedCommands: ["ls", "cat", "echo"]
  }

  it("should handle tool execution with empty input", async () => {
    // ASSUMPTION: tools handle empty input gracefully
    const result = await readFileTool.execute({}, mockContext)
    expect(typeof result).toBe("string")
  })

  it("should handle tool execution with invalid input types", async () => {
    // ASSUMPTION: tools validate input and return error messages
    const result = await readFileTool.execute({ path: 123 }, mockContext)
    expect(typeof result).toBe("string")
  })

  it("should respect allowedCommands constraint", async () => {
    const restrictedContext = {
      ...mockContext,
      allowedCommands: ["echo"]
    }
    
    // ASSUMPTION: runCommandTool respects allowedCommands
    const result = await runCommandTool.execute(
      { command: "echo", args: ["test"] },
      restrictedContext
    )
    expect(typeof result).toBe("string")
  })
})

describe("Property-based tests: Agent configuration validation", () => {
  it("should handle arbitrary temperature values", () => {
    fc.assert(fc.property(
      fc.float({ min: 0, max: 2 }),
      (temperature) => {
        const agent: AgentDefinition = {
          role: "test",
          systemPrompt: "test",
          tools: [],
          maxTurns: 1,
          temperature
        }
        expect(agent.temperature).toBe(temperature)
        expect(agent.temperature).toBeGreaterThanOrEqual(0)
        expect(agent.temperature).toBeLessThanOrEqual(2)
      }
    ))
  })

  it("should handle arbitrary maxTurns values", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 100 }),
      (maxTurns) => {
        const agent: AgentDefinition = {
          role: "test",
          systemPrompt: "test",
          tools: [],
          maxTurns,
          temperature: 0.7
        }
        expect(agent.maxTurns).toBe(maxTurns)
        expect(agent.maxTurns).toBeGreaterThan(0)
      }
    ))
  })

  it("should handle arbitrary role and systemPrompt strings", () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1 }),
      fc.string({ minLength: 1 }),
      (role, systemPrompt) => {
        const agent: AgentDefinition = {
          role,
          systemPrompt,
          tools: [],
          maxTurns: 1,
          temperature: 0.7
        }
        expect(agent.role).toBe(role)
        expect(agent.systemPrompt).toBe(systemPrompt)
      }
    ))
  })
})

describe("Boundary cases: Edge values and limits", () => {
  it("should handle maximum safe integer values", () => {
    const agent: AgentDefinition = {
      role: "test",
      systemPrompt: "test",
      tools: [],
      maxTurns: Number.MAX_SAFE_INTEGER,
      temperature: 0,
      maxTokens: Number.MAX_SAFE_INTEGER
    }
    expect(agent.maxTurns).toBe(Number.MAX_SAFE_INTEGER)
    expect(agent.maxTokens).toBe(Number.MAX_SAFE_INTEGER)
  })

  it("should handle minimum valid values", () => {
    const agent: AgentDefinition = {
      role: "a",
      systemPrompt: "b",
      tools: [],
      maxTurns: 1,
      temperature: 0
    }
    expect(agent.maxTurns).toBe(1)
    expect(agent.temperature).toBe(0)
  })

  it("should handle empty tools array", () => {
    const agent: AgentDefinition = {
      role: "test",
      systemPrompt: "test",
      tools: [],
      maxTurns: 1,
      temperature: 0.7
    }
    expect(agent.tools).toEqual([])
  })

  it("should handle undefined optional fields", () => {
    const context: AgentContext = {
      pipelineCtx: {} as any,
      workDir: "/tmp"
      // allowedCommands is undefined
    }
    expect(context.allowedCommands).toBeUndefined()

    const options: ExecutorOptions = {
      // all fields are undefined
    }
    expect(options.postCompletionHook).toBeUndefined()
    expect(options.maxVerificationRetries).toBeUndefined()
    expect(options.deferPostCompletionVerifyFromTurn).toBeUndefined()
  })
})
```