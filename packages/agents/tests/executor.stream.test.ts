import type { PipelineContext } from "@bollard/engine/src/context.js"
import { CostTracker } from "@bollard/engine/src/cost-tracker.js"
import { BollardError } from "@bollard/engine/src/errors.js"
import { MockProvider } from "@bollard/llm/src/mock.js"
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
} from "@bollard/llm/src/types.js"
import { describe, expect, it, vi } from "vitest"
import { executeAgent } from "../src/executor.js"
import type { AgentContext, AgentDefinition, AgentProgressEvent } from "../src/types.js"

function makeCtx(onProgress?: (e: AgentProgressEvent) => void): AgentContext {
  const pipelineCtx: PipelineContext = {
    runId: "r1",
    task: "t",
    blueprintId: "b",
    config: {
      llm: { default: { provider: "mock", model: "m" } },
      agent: { max_cost_usd: 10, max_duration_minutes: 30 },
    },
    currentNode: "n",
    results: {},
    changedFiles: [],
    costTracker: new CostTracker(10),
    startedAt: Date.now(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    upgradeRunId: vi.fn(),
  }
  return {
    pipelineCtx,
    workDir: "/tmp",
    ...(onProgress ? { progress: onProgress } : {}),
  }
}

const TEXT_RESPONSE: LLMResponse = {
  content: [{ type: "text", text: "done" }],
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 1 },
  costUsd: 0.001,
}

describe("executeAgent streaming", () => {
  it("uses chatStream when provider implements it", async () => {
    const mock = new MockProvider([TEXT_RESPONSE])
    let sawStream = false
    const chatStream = async function* (_req: LLMRequest): AsyncIterable<LLMStreamEvent> {
      sawStream = true
      yield { type: "text_delta", text: "done" }
      yield { type: "message_complete", response: TEXT_RESPONSE }
    }
    const provider: LLMProvider = {
      name: "hybrid",
      chat: (r) => mock.chat(r),
      chatStream,
    }

    const agent: AgentDefinition = {
      role: "tester",
      systemPrompt: "sys",
      tools: [],
      maxTurns: 3,
      temperature: 0,
    }

    const result = await executeAgent(agent, "hello", provider, "m", makeCtx())
    expect(sawStream).toBe(true)
    expect(result.response).toBe("done")
  })

  it("falls back to chat when no chatStream", async () => {
    const mock = new MockProvider([TEXT_RESPONSE])
    const provider: LLMProvider = {
      name: "chat-only",
      chat: (r) => mock.chat(r),
    }
    const agent: AgentDefinition = {
      role: "tester",
      systemPrompt: "sys",
      tools: [],
      maxTurns: 3,
      temperature: 0,
    }
    const result = await executeAgent(agent, "hello", provider, "m", makeCtx())
    expect(result.response).toBe("done")
  })

  it("emits stream_delta during streaming", async () => {
    const events: AgentProgressEvent[] = []
    const mock = new MockProvider([TEXT_RESPONSE])
    const provider: LLMProvider = {
      name: "hybrid",
      chat: (r) => mock.chat(r),
      chatStream: async function* () {
        yield { type: "text_delta", text: "ab" }
        yield { type: "message_complete", response: TEXT_RESPONSE }
      },
    }
    const agent: AgentDefinition = {
      role: "tester",
      systemPrompt: "sys",
      tools: [],
      maxTurns: 3,
      temperature: 0,
    }
    await executeAgent(
      agent,
      "hello",
      provider,
      "m",
      makeCtx((e) => events.push(e)),
    )
    const deltas = events.filter((e) => e.type === "stream_delta")
    expect(deltas.length).toBeGreaterThan(0)
    expect(deltas[0]?.type === "stream_delta" && deltas[0].totalTokensSoFar).toBeGreaterThan(0)
  })

  it("stream path returns tool_use response from message_complete", async () => {
    const toolResponse: LLMResponse = {
      content: [
        {
          type: "tool_use",
          toolName: "read_file",
          toolInput: { path: "x" },
          toolUseId: "tu1",
        },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 2 },
      costUsd: 0,
    }
    const finalText: LLMResponse = {
      content: [{ type: "text", text: "ok" }],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: 0,
    }
    let streamCall = 0
    const provider: LLMProvider = {
      name: "stream-tools",
      chat: async () => finalText,
      chatStream: async function* () {
        streamCall++
        if (streamCall === 1) {
          yield { type: "message_complete", response: toolResponse }
        } else {
          yield { type: "message_complete", response: finalText }
        }
      },
    }
    const readTool = {
      name: "read_file",
      description: "read",
      inputSchema: {},
      execute: async () => "contents",
    }
    const agent: AgentDefinition = {
      role: "coder",
      systemPrompt: "sys",
      tools: [readTool],
      maxTurns: 3,
      temperature: 0,
    }
    const result = await executeAgent(agent, "go", provider, "m", makeCtx())
    expect(result.toolCalls.length).toBeGreaterThan(0)
    expect(result.response).toBe("ok")
  })

  it("throws LLM_INVALID_RESPONSE when stream omits message_complete", async () => {
    const provider: LLMProvider = {
      name: "broken-stream",
      chat: async () => TEXT_RESPONSE,
      chatStream: async function* () {
        yield { type: "text_delta", text: "only" }
      },
    }
    const agent: AgentDefinition = {
      role: "tester",
      systemPrompt: "sys",
      tools: [],
      maxTurns: 3,
      temperature: 0,
    }
    let caught: unknown
    try {
      await executeAgent(agent, "hello", provider, "m", makeCtx())
    } catch (e) {
      caught = e
    }
    expect(BollardError.is(caught) && caught.code === "LLM_INVALID_RESPONSE").toBe(true)
  })
})
