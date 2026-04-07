import { createContext } from "@bollard/engine/src/context.js"
import { BollardError } from "@bollard/engine/src/errors.js"
import { MockProvider } from "@bollard/llm/src/mock.js"
import type { LLMProvider, LLMRequest, LLMResponse } from "@bollard/llm/src/types.js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { executeAgent } from "../src/executor.js"
import type { AgentContext, AgentDefinition, AgentProgressEvent, AgentTool } from "../src/types.js"

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

function makeCtx(overrides?: Partial<AgentContext>): AgentContext {
  return {
    pipelineCtx: createContext("test task", "test-bp", TEST_CONFIG),
    workDir: "/tmp/test",
    ...overrides,
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

class RateLimitOnceProvider implements LLMProvider {
  readonly name = "rate-limit-mock"
  private call = 0
  constructor(private readonly ok: LLMResponse) {}

  async chat(_request: LLMRequest): Promise<LLMResponse> {
    if (this.call++ === 0) {
      throw new BollardError({ code: "LLM_RATE_LIMIT", message: "slow down" })
    }
    return this.ok
  }
}

class AuthFailProvider implements LLMProvider {
  readonly name = "auth-fail"
  async chat(_request: LLMRequest): Promise<LLMResponse> {
    throw new BollardError({ code: "LLM_AUTH", message: "denied" })
  }
}

describe("executeAgent progress", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("emits turn_start and turn_end for a single text turn with correct numbers", async () => {
    const events: AgentProgressEvent[] = []
    const provider = new MockProvider([textResponse("hi")])
    await executeAgent(
      makeAgent(),
      "x",
      provider,
      "m",
      makeCtx({ progress: (e) => events.push(e) }),
    )

    const starts = events.filter((e) => e.type === "turn_start")
    const ends = events.filter((e) => e.type === "turn_end")
    expect(starts).toHaveLength(1)
    expect(ends).toHaveLength(1)
    expect(starts[0]).toMatchObject({ turn: 1, maxTurns: 5, role: "test-agent" })
    expect(ends[0]).toMatchObject({
      type: "turn_end",
      turn: 1,
      maxTurns: 5,
      role: "test-agent",
      toolCallsThisTurn: 0,
      stopReason: "end_turn",
    })
    if (ends[0]?.type === "turn_end") {
      expect(ends[0].costUsd).toBeGreaterThanOrEqual(0)
      expect(ends[0].durationMs).toBeGreaterThanOrEqual(0)
    }
  })

  it("turn_end reports toolCallsThisTurn for multiple tools in one response", async () => {
    const events: AgentProgressEvent[] = []
    const multi: LLMResponse = {
      content: [
        { type: "tool_use", toolName: "echo", toolInput: { text: "a" }, toolUseId: "c1" },
        { type: "tool_use", toolName: "echo", toolInput: { text: "b" }, toolUseId: "c2" },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 100, outputTokens: 80 },
      costUsd: 0.002,
    }
    const provider = new MockProvider([multi, textResponse("done")])
    await executeAgent(
      makeAgent([echoTool()]),
      "x",
      provider,
      "m",
      makeCtx({ progress: (e) => events.push(e) }),
    )
    const end = events.find((e) => e.type === "turn_end" && e.toolCallsThisTurn === 2)
    expect(end?.type).toBe("turn_end")
  })

  it("emits matched tool_call_start and tool_call_end pairs", async () => {
    const events: AgentProgressEvent[] = []
    const provider = new MockProvider([
      toolUseResponse("echo", { text: "a" }, "c1"),
      textResponse("done"),
    ])
    await executeAgent(
      makeAgent([echoTool()]),
      "x",
      provider,
      "m",
      makeCtx({ progress: (e) => events.push(e) }),
    )

    const starts = events.filter((e) => e.type === "tool_call_start")
    const ends = events.filter((e) => e.type === "tool_call_end")
    expect(starts).toHaveLength(1)
    expect(ends).toHaveLength(1)
    expect(starts[0]).toMatchObject({ tool: "echo", turn: 1 })
    expect(ends[0]).toMatchObject({ tool: "echo", ok: true })
  })

  it("emits tool_call_end ok false when tool throws", async () => {
    const failingTool: AgentTool = {
      name: "fail",
      description: "x",
      inputSchema: { type: "object" },
      async execute() {
        throw new Error("Boom")
      },
    }
    const events: AgentProgressEvent[] = []
    const provider = new MockProvider([toolUseResponse("fail", {}, "f1"), textResponse("ok")])
    await executeAgent(
      makeAgent([failingTool]),
      "x",
      provider,
      "m",
      makeCtx({ progress: (e) => events.push(e) }),
    )

    const end = events.find((e) => e.type === "tool_call_end")
    expect(end?.type).toBe("tool_call_end")
    if (end?.type === "tool_call_end") {
      expect(end.ok).toBe(false)
      expect(end.error).toContain("Boom")
    }
  })

  it("emits tool_call_end ok false for unknown tool", async () => {
    const events: AgentProgressEvent[] = []
    const unknown: LLMResponse = {
      content: [{ type: "tool_use", toolName: "missing", toolInput: {}, toolUseId: "u1" }],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: 0,
    }
    const provider = new MockProvider([unknown, textResponse("ok")])
    await executeAgent(
      makeAgent([echoTool()]),
      "x",
      provider,
      "m",
      makeCtx({ progress: (e) => events.push(e) }),
    )
    const end = events.find((e) => e.type === "tool_call_end")
    expect(end?.type).toBe("tool_call_end")
    if (end?.type === "tool_call_end") {
      expect(end.ok).toBe(false)
    }
  })

  it("rate-limit retry yields single turn_start and turn_end (no extra pair for failed attempt)", async () => {
    vi.useFakeTimers()
    const events: AgentProgressEvent[] = []
    const provider = new RateLimitOnceProvider(textResponse("recovered"))
    const p = executeAgent(
      makeAgent(),
      "x",
      provider,
      "m",
      makeCtx({ progress: (e) => events.push(e) }),
    )
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(20_000)
    await p

    expect(events.filter((e) => e.type === "turn_start")).toHaveLength(1)
    expect(events.filter((e) => e.type === "turn_end")).toHaveLength(1)
  })

  it("swallows progress listener errors without failing the agent", async () => {
    const provider = new MockProvider([textResponse("ok")])
    const result = await executeAgent(
      makeAgent(),
      "x",
      provider,
      "m",
      makeCtx({
        progress: () => {
          throw new Error("listener boom")
        },
      }),
    )
    expect(result.response).toBe("ok")
  })

  it("does not emit turn_end when chat fails with non-retryable error", async () => {
    const events: AgentProgressEvent[] = []
    const provider = new AuthFailProvider()
    await expect(
      executeAgent(makeAgent(), "x", provider, "m", makeCtx({ progress: (e) => events.push(e) })),
    ).rejects.toThrow()

    expect(events.some((e) => e.type === "turn_start")).toBe(true)
    expect(events.some((e) => e.type === "turn_end")).toBe(false)
  })

  it("works with no progress callback (backward compat)", async () => {
    const provider = new MockProvider([textResponse("plain")])
    const result = await executeAgent(makeAgent(), "x", provider, "m", makeCtx())
    expect(result.response).toBe("plain")
  })
})
