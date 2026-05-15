import { createContext } from "@bollard/engine/src/context.js"
import { BollardError } from "@bollard/engine/src/errors.js"
import { MockProvider } from "@bollard/llm/src/mock.js"
import type {
  LLMContentBlock,
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from "@bollard/llm/src/types.js"
import { describe, expect, it } from "vitest"
import { compactOlderTurns, executeAgent } from "../src/executor.js"
import type { AgentContext, AgentDefinition, AgentTool, ExecutorOptions } from "../src/types.js"

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

function cloneMessages(messages: LLMMessage[]): LLMMessage[] {
  return JSON.parse(JSON.stringify(messages)) as LLMMessage[]
}

function hardExitUserMessageCountInTranscript(messages: LLMMessage[]): number {
  let n = 0
  for (const m of messages) {
    if (
      m.role === "user" &&
      typeof m.content === "string" &&
      m.content.includes("SYSTEM: You have")
    ) {
      n++
    }
  }
  return n
}

const noopTool: AgentTool = {
  name: "noop",
  description: "No-op",
  inputSchema: { type: "object" },
  async execute() {
    return "ok"
  },
}

describe("executeAgent", () => {
  it("throws CONFIG_INVALID when maxTurns is missing or not positive", async () => {
    const provider = new MockProvider([textResponse("x")])
    const bad = { ...makeAgent(), maxTurns: 0 as unknown as number }
    await expect(executeAgent(bad, "hi", provider, "test", makeCtx())).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    })
  })

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
        expect(err.context?.["totalCostUsd"]).toBeTypeOf("number")
        expect((err.context?.["totalCostUsd"] as number) ?? 0).toBeGreaterThanOrEqual(0)
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

  it("throws COST_LIMIT_EXCEEDED before max turns when live cost exceeds agent cap", async () => {
    const lowCapConfig = {
      llm: { default: { provider: "mock", model: "test" } },
      agent: { max_cost_usd: 0.05, max_duration_minutes: 30 },
    }
    const ctx: AgentContext = {
      pipelineCtx: createContext("test", "bp", lowCapConfig),
      workDir: "/tmp/test",
    }

    let callId = 0
    const provider: LLMProvider = {
      name: "burn-per-turn",
      async chat() {
        callId++
        return {
          content: [
            {
              type: "tool_use",
              toolName: "noop",
              toolInput: {},
              toolUseId: `id-${callId}`,
            },
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 10 },
          costUsd: 0.01,
        }
      },
    }

    const agent = makeAgent([noopTool], { maxTurns: 50 })

    await expect(executeAgent(agent, "go", provider, "m", ctx)).rejects.toMatchObject({
      code: "COST_LIMIT_EXCEEDED",
    })
    expect(callId).toBeLessThan(10)
  })

  it("injects forced-completion user message once at maxTurns-8 when stuck in tool_use", async () => {
    const recorded: LLMMessage[][] = []
    let callId = 0
    const provider: LLMProvider = {
      name: "record-tool-loop",
      async chat(req: LLMRequest) {
        recorded.push(cloneMessages(req.messages))
        callId++
        return {
          content: [
            {
              type: "tool_use",
              toolName: "noop",
              toolInput: {},
              toolUseId: `id-${callId}`,
            },
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1 },
          costUsd: 0,
        }
      },
    }
    const agent = makeAgent([noopTool], { maxTurns: 10 })

    await expect(executeAgent(agent, "go", provider, "m", makeCtx())).rejects.toMatchObject({
      code: "NODE_EXECUTION_FAILED",
    })

    const lastTranscript = recorded[recorded.length - 1] ?? []
    expect(hardExitUserMessageCountInTranscript(lastTranscript)).toBe(1)

    let injectionSeenAt = -1
    for (let i = 0; i < recorded.length; i++) {
      const prev = i > 0 ? hardExitUserMessageCountInTranscript(recorded[i - 1] ?? []) : 0
      const cur = hardExitUserMessageCountInTranscript(recorded[i] ?? [])
      if (cur > prev) {
        injectionSeenAt = i
        break
      }
    }
    expect(injectionSeenAt).toBeGreaterThanOrEqual(0)
    for (let i = injectionSeenAt + 1; i < recorded.length; i++) {
      expect(hardExitUserMessageCountInTranscript(recorded[i] ?? [])).toBe(1)
    }
  })

  it("throws COST_LIMIT_EXCEEDED from per-attempt cap before maxTurns", async () => {
    let callId = 0
    const provider: LLMProvider = {
      name: "burn-per-attempt",
      async chat() {
        callId++
        return {
          content: [
            {
              type: "tool_use",
              toolName: "noop",
              toolInput: {},
              toolUseId: `id-${callId}`,
            },
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 10 },
          costUsd: 0.01,
        }
      },
    }
    const agent = makeAgent([noopTool], { maxTurns: 50 })

    await expect(
      executeAgent(agent, "go", provider, "m", makeCtx(), { maxCostUsd: 0.025 }),
    ).rejects.toMatchObject({
      code: "COST_LIMIT_EXCEEDED",
    })

    expect(callId).toBe(3)
  })

  it("applies per-attempt cost cap before aggregate pipeline cap", async () => {
    const highAggregateConfig = {
      llm: { default: { provider: "mock", model: "test" } },
      agent: { max_cost_usd: 1, max_duration_minutes: 30 },
    }
    const ctx: AgentContext = {
      pipelineCtx: createContext("test", "bp", highAggregateConfig),
      workDir: "/tmp/test",
    }

    let callId = 0
    const provider: LLMProvider = {
      name: "burn-under-high-aggregate",
      async chat() {
        callId++
        return {
          content: [
            {
              type: "tool_use",
              toolName: "noop",
              toolInput: {},
              toolUseId: `id-${callId}`,
            },
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 10 },
          costUsd: 0.01,
        }
      },
    }
    const agent = makeAgent([noopTool], { maxTurns: 200 })

    let caught: unknown
    try {
      await executeAgent(agent, "go", provider, "m", ctx, { maxCostUsd: 0.049 })
    } catch (e: unknown) {
      caught = e
    }

    expect(BollardError.is(caught)).toBe(true)
    if (BollardError.is(caught)) {
      expect(caught.message).toContain("Per-attempt cost limit")
    }
    expect(callId).toBe(5)
  })

  it("does not inject hard exit after end_turn with hook continuation", async () => {
    const recorded: LLMMessage[][] = []
    let callId = 0
    let hookRound = 0
    const provider: LLMProvider = {
      name: "completion-then-tools",
      async chat(req: LLMRequest) {
        recorded.push(cloneMessages(req.messages))
        callId++
        if (callId === 1) {
          return textResponse("phase1", 0.001)
        }
        return {
          content: [
            {
              type: "tool_use",
              toolName: "noop",
              toolInput: {},
              toolUseId: `id-${callId}`,
            },
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1 },
          costUsd: 0.001,
        }
      },
    }
    const options: ExecutorOptions = {
      postCompletionHook: async () => {
        hookRound++
        return hookRound === 1 ? "fix tests" : null
      },
    }
    const agent = makeAgent([noopTool], { maxTurns: 10 })

    await expect(
      executeAgent(agent, "go", provider, "m", makeCtx(), options),
    ).rejects.toMatchObject({
      code: "NODE_EXECUTION_FAILED",
    })

    expect(hardExitUserMessageCountInTranscript(recorded[recorded.length - 1] ?? [])).toBe(0)
  })

  it("caps large tool results at MAX_TOOL_RESULT_CHARS", async () => {
    const largeTool: AgentTool = {
      name: "large",
      description: "Returns large output",
      inputSchema: { type: "object" },
      async execute() {
        return "x".repeat(20_000)
      },
    }
    const provider = new MockProvider([toolUseResponse("large", {}, "l1"), textResponse("Done")])
    const agent = makeAgent([largeTool])
    const result = await executeAgent(agent, "test", provider, "test", makeCtx())

    expect(result.response).toBe("Done")
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]?.output.length).toBeLessThanOrEqual(2000)
  })
})

describe("executeAgent with postCompletionHook", () => {
  it("returns immediately when hook returns null (verification passed)", async () => {
    const provider = new MockProvider([textResponse("All done")])
    const agent = makeAgent()
    const hookCalls: string[] = []
    const options: ExecutorOptions = {
      postCompletionHook: async (text) => {
        hookCalls.push(text)
        return null
      },
    }

    const result = await executeAgent(agent, "hi", provider, "test", makeCtx(), options)

    expect(result.response).toBe("All done")
    expect(hookCalls).toEqual(["All done"])
    expect(result.turns).toBe(0)
  })

  it("feeds back to LLM when hook returns feedback string", async () => {
    const provider = new MockProvider([
      textResponse("First attempt"),
      textResponse("Fixed version"),
    ])
    const agent = makeAgent([], { maxTurns: 5 })
    let hookCallCount = 0
    const options: ExecutorOptions = {
      postCompletionHook: async () => {
        hookCallCount++
        if (hookCallCount === 1) return "Tests failed: 2 errors found"
        return null
      },
    }

    const result = await executeAgent(agent, "hi", provider, "test", makeCtx(), options)

    expect(result.response).toBe("Fixed version")
    expect(hookCallCount).toBe(2)
    expect(result.turns).toBe(1)
  })

  it("stops retrying after maxVerificationRetries", async () => {
    const responses = [
      textResponse("Attempt 1"),
      textResponse("Attempt 2"),
      textResponse("Attempt 3"),
    ]
    const provider = new MockProvider(responses)
    const agent = makeAgent([], { maxTurns: 10 })
    const options: ExecutorOptions = {
      postCompletionHook: async () => "Still failing",
      maxVerificationRetries: 2,
    }

    const result = await executeAgent(agent, "hi", provider, "test", makeCtx(), options)

    expect(result.response).toBe("Attempt 3")
    expect(result.turns).toBe(2)
  })

  it("continues gracefully when hook throws", async () => {
    const provider = new MockProvider([textResponse("Hello")])
    const agent = makeAgent()
    const options: ExecutorOptions = {
      postCompletionHook: async () => {
        throw new Error("Hook exploded")
      },
    }

    const result = await executeAgent(agent, "hi", provider, "test", makeCtx(), options)

    expect(result.response).toBe("Hello")
  })
})

describe("compactOlderTurns", () => {
  it("does nothing when messages array is small", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]
    compactOlderTurns(messages)
    const block = (messages[1]?.content as LLMContentBlock[])[0]
    expect(block?.text).toBe("hi")
  })

  it("truncates old tool_result texts beyond threshold", () => {
    const longText = "x".repeat(2000)
    const messages: LLMMessage[] = [
      { role: "user", content: "initial" },
      { role: "assistant", content: [{ type: "tool_use", toolName: "echo", toolUseId: "t1" }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", text: longText }] },
      { role: "assistant", content: [{ type: "tool_use", toolName: "echo", toolUseId: "t2" }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t2", text: longText }] },
      { role: "assistant", content: [{ type: "tool_use", toolName: "echo", toolUseId: "t3" }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t3", text: longText }] },
      { role: "assistant", content: [{ type: "tool_use", toolName: "echo", toolUseId: "t4" }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t4", text: longText }] },
    ]

    compactOlderTurns(messages)

    const oldResult = (messages[2]?.content as LLMContentBlock[])[0]
    expect(oldResult?.text?.length).toBeLessThan(900)
    expect(oldResult?.text).toContain("[...truncated for token efficiency]")

    const recentResult = (messages[8]?.content as LLMContentBlock[])[0]
    expect(recentResult?.text).toBe(longText)
  })

  it("truncates write_file content in old assistant messages", () => {
    const largeContent = "y".repeat(1000)
    const messages: LLMMessage[] = [
      { role: "user", content: "initial" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            toolName: "write_file",
            toolUseId: "w1",
            toolInput: { path: "test.ts", content: largeContent },
          },
        ],
      },
      { role: "user", content: [{ type: "tool_result", toolUseId: "w1", text: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "padding" }] },
      { role: "user", content: "padding" },
      { role: "assistant", content: [{ type: "text", text: "padding" }] },
      { role: "user", content: "padding" },
      { role: "assistant", content: [{ type: "text", text: "padding" }] },
      { role: "user", content: "padding" },
    ]

    compactOlderTurns(messages)

    const writeBlock = (messages[1]?.content as LLMContentBlock[])[0]
    const content = writeBlock?.toolInput?.["content"] as string
    expect(content.length).toBeLessThan(300)
    expect(content).toContain("[...file content truncated]")
  })

  it("truncates early tool_result after five tool rounds (keep window = 4)", () => {
    const longText = "x".repeat(2000)
    const messages: LLMMessage[] = [
      { role: "user", content: "task" },
      { role: "assistant", content: [{ type: "tool_use", toolName: "read", toolUseId: "t1" }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", text: longText }] },
      { role: "assistant", content: [{ type: "tool_use", toolName: "read", toolUseId: "t2" }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t2", text: longText }] },
      { role: "assistant", content: [{ type: "tool_use", toolName: "read", toolUseId: "t3" }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t3", text: longText }] },
      { role: "assistant", content: [{ type: "tool_use", toolName: "read", toolUseId: "t4" }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t4", text: longText }] },
      { role: "assistant", content: [{ type: "tool_use", toolName: "read", toolUseId: "t5" }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t5", text: longText }] },
    ]

    compactOlderTurns(messages)

    const firstRoundResult = (messages[2]?.content as LLMContentBlock[])[0]
    expect(firstRoundResult?.text?.length).toBeLessThanOrEqual(900)
    expect(firstRoundResult?.text).toContain("[...truncated for token efficiency]")

    const lastRoundResult = (messages[10]?.content as LLMContentBlock[])[0]
    expect(lastRoundResult?.text).toBe(longText)
  })

  it("preserves the initial user message", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "This is the initial task message with lots of context" },
      { role: "assistant", content: [{ type: "tool_use", toolName: "echo", toolUseId: "t1" }] },
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "t1", text: "x".repeat(2000) }],
      },
      { role: "assistant", content: [{ type: "text", text: "p" }] },
      { role: "user", content: "p" },
      { role: "assistant", content: [{ type: "text", text: "p" }] },
      { role: "user", content: "p" },
      { role: "assistant", content: [{ type: "text", text: "p" }] },
      { role: "user", content: "p" },
    ]

    compactOlderTurns(messages)

    expect(messages[0]?.content).toBe("This is the initial task message with lots of context")
  })
})

describe("deterministic verification consumes zero extra LLM calls", () => {
  it("passing hook adds zero LLM calls beyond the agent's own", async () => {
    let chatCallCount = 0
    const trackingProvider = {
      name: "tracking-mock",
      async chat(): Promise<LLMResponse> {
        chatCallCount++
        return textResponse("done")
      },
    }

    const agent = makeAgent([], { maxTurns: 5 })
    const options: ExecutorOptions = {
      postCompletionHook: async () => null,
    }

    await executeAgent(agent, "task", trackingProvider, "test", makeCtx(), options)

    expect(chatCallCount).toBe(1)
  })

  it("failing hook adds exactly one LLM call per retry to fix errors", async () => {
    let chatCallCount = 0
    const trackingProvider = {
      name: "tracking-mock",
      async chat(): Promise<LLMResponse> {
        chatCallCount++
        return textResponse(`attempt ${chatCallCount}`)
      },
    }

    const agent = makeAgent([], { maxTurns: 10 })
    let hookCalls = 0
    const options: ExecutorOptions = {
      postCompletionHook: async () => {
        hookCalls++
        if (hookCalls <= 2) return "tests failed"
        return null
      },
      maxVerificationRetries: 3,
    }

    const result = await executeAgent(agent, "task", trackingProvider, "test", makeCtx(), options)

    expect(chatCallCount).toBe(3)
    expect(result.response).toBe("attempt 3")
    expect(hookCalls).toBe(3)
  })

  it("tool-use turns only invoke LLM for creative decisions, not verification", async () => {
    let chatCallCount = 0
    const responses = [
      {
        content: [
          {
            type: "tool_use" as const,
            toolName: "echo",
            toolInput: { text: "hi" },
            toolUseId: "t1",
          },
        ],
        stopReason: "tool_use" as const,
        usage: { inputTokens: 100, outputTokens: 50 },
        costUsd: 0.001,
      },
      textResponse("all done"),
    ]
    let responseIdx = 0

    const trackingProvider = {
      name: "tracking-mock",
      async chat(): Promise<LLMResponse> {
        chatCallCount++
        const r = responses[responseIdx]
        responseIdx++
        return r as LLMResponse
      },
    }

    const agent = makeAgent([echoTool()], { maxTurns: 5 })
    const hookCalled: boolean[] = []
    const options: ExecutorOptions = {
      postCompletionHook: async () => {
        hookCalled.push(true)
        return null
      },
    }

    const result = await executeAgent(agent, "task", trackingProvider, "test", makeCtx(), options)

    expect(chatCallCount).toBe(2)
    expect(hookCalled).toHaveLength(1)
    expect(result.turns).toBe(1)
    expect(result.response).toBe("all done")
  })
})
