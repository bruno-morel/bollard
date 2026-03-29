import { createContext } from "@bollard/engine/src/context.js"
import { BollardError } from "@bollard/engine/src/errors.js"
import { MockProvider } from "@bollard/llm/src/mock.js"
import type { LLMResponse } from "@bollard/llm/src/types.js"
import { describe, expect, it } from "vitest"
import { executeAgent } from "../src/executor.js"
import type { AgentContext, AgentDefinition, AgentTool } from "../src/types.js"

function textResponse(text: string, costUsd = 0.001): LLMResponse {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 50 },
    costUsd,
  }
}

function toolUseResponse(
  toolName: string,
  input: Record<string, unknown>,
  toolUseId: string,
  costUsd = 0.001,
): LLMResponse {
  return {
    content: [{ type: "tool_use", toolName, toolInput: input, toolUseId }],
    stopReason: "tool_use",
    usage: { inputTokens: 100, outputTokens: 50 },
    costUsd,
  }
}

const TEST_CONFIG = {
  llm: { default: { provider: "mock", model: "test" } },
  agent: { max_cost_usd: 10, max_duration_minutes: 30 },
}

function makeCtx(): AgentContext {
  return {
    pipelineCtx: createContext("test task", "test-bp", TEST_CONFIG),
    workDir: "/tmp/test",
  }
}

function echoTool(): AgentTool {
  return {
    name: "echo",
    description: "Echoes input back",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    async execute(input) {
      return `echo: ${String(input["text"] ?? "")}`
    },
  }
}

function makeAgent(tools: AgentTool[] = [], overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    role: "test-agent",
    systemPrompt: "You are a test agent.",
    tools,
    maxTurns: 5,
    temperature: 0,
    ...overrides,
  }
}

describe("executeAgent", () => {
  it("returns text response with zero turns when no tools called", async () => {
    const provider = new MockProvider([textResponse("Hello world")])
    const agent = makeAgent()
    const result = await executeAgent(agent, "hi", provider, "test", makeCtx())

    expect(result.response).toBe("Hello world")
    expect(result.turns).toBe(0)
    expect(result.toolCalls).toHaveLength(0)
  })

  it("executes a tool-use loop and returns final text", async () => {
    const provider = new MockProvider([
      toolUseResponse("echo", { text: "hello" }, "call-1"),
      textResponse("Done"),
    ])
    const agent = makeAgent([echoTool()])
    const result = await executeAgent(agent, "test", provider, "test", makeCtx())

    expect(result.response).toBe("Done")
    expect(result.turns).toBe(1)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]?.tool).toBe("echo")
    expect(result.toolCalls[0]?.output).toBe("echo: hello")
  })

  it("handles multiple tool calls in one turn", async () => {
    const multiToolResponse: LLMResponse = {
      content: [
        { type: "tool_use", toolName: "echo", toolInput: { text: "a" }, toolUseId: "c1" },
        { type: "tool_use", toolName: "echo", toolInput: { text: "b" }, toolUseId: "c2" },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 100, outputTokens: 80 },
      costUsd: 0.002,
    }
    const provider = new MockProvider([multiToolResponse, textResponse("All done")])
    const agent = makeAgent([echoTool()])
    const result = await executeAgent(agent, "test", provider, "test", makeCtx())

    expect(result.turns).toBe(1)
    expect(result.toolCalls).toHaveLength(2)
    expect(result.response).toBe("All done")
  })

  it("throws NODE_EXECUTION_FAILED when max turns exceeded", async () => {
    const responses = Array.from({ length: 3 }, (_, i) =>
      toolUseResponse("echo", { text: `turn-${i}` }, `call-${i}`),
    )
    const provider = new MockProvider(responses)
    const agent = makeAgent([echoTool()], { maxTurns: 2 })

    await expect(executeAgent(agent, "test", provider, "test", makeCtx())).rejects.toThrow(
      BollardError,
    )

    try {
      await executeAgent(agent, "test", new MockProvider(responses), "test", makeCtx())
    } catch (err: unknown) {
      expect(BollardError.is(err)).toBe(true)
      if (BollardError.is(err)) {
        expect(err.code).toBe("NODE_EXECUTION_FAILED")
      }
    }
  })

  it("sends error for unknown tool and continues", async () => {
    const unknownToolResponse: LLMResponse = {
      content: [{ type: "tool_use", toolName: "nonexistent", toolInput: {}, toolUseId: "u1" }],
      stopReason: "tool_use",
      usage: { inputTokens: 50, outputTokens: 30 },
      costUsd: 0.001,
    }
    const provider = new MockProvider([unknownToolResponse, textResponse("Recovered")])
    const agent = makeAgent([echoTool()])
    const result = await executeAgent(agent, "test", provider, "test", makeCtx())

    expect(result.response).toBe("Recovered")
    expect(result.turns).toBe(1)
    expect(result.toolCalls).toHaveLength(0)
  })

  it("sends error for tool execution failure and continues", async () => {
    const failingTool: AgentTool = {
      name: "fail",
      description: "Always fails",
      inputSchema: { type: "object" },
      async execute() {
        throw new Error("Boom")
      },
    }
    const provider = new MockProvider([
      toolUseResponse("fail", {}, "f1"),
      textResponse("Recovered from failure"),
    ])
    const agent = makeAgent([failingTool])
    const result = await executeAgent(agent, "test", provider, "test", makeCtx())

    expect(result.response).toBe("Recovered from failure")
    expect(result.turns).toBe(1)
  })

  it("sums cost across all LLM calls", async () => {
    const provider = new MockProvider([
      toolUseResponse("echo", { text: "x" }, "c1", 0.003),
      textResponse("Done", 0.005),
    ])
    const agent = makeAgent([echoTool()])
    const result = await executeAgent(agent, "test", provider, "test", makeCtx())

    expect(result.totalCostUsd).toBeCloseTo(0.008)
  })
})
