import { describe, expect, it, vi } from "vitest"

const { makeToolStream } = vi.hoisted(() => {
  function makeToolStream() {
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "content_block_start",
          content_block: { type: "tool_use" as const, id: "toolu_01", name: "demo" },
        }
        yield {
          type: "content_block_delta",
          delta: { type: "input_json_delta" as const, partial_json: "{}" },
        }
        yield { type: "content_block_stop", index: 0 }
        yield {
          type: "message_delta",
          delta: { stop_reason: "tool_use" as const },
          usage: { output_tokens: 2 },
        }
      },
      finalMessage: async () => ({
        id: "msg_1",
        type: "message" as const,
        role: "assistant" as const,
        model: "claude-haiku-3-5-20241022",
        content: [
          {
            type: "tool_use" as const,
            id: "toolu_01",
            name: "demo",
            input: {},
          },
        ],
        stop_reason: "tool_use" as const,
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    }
  }
  return { makeToolStream }
})

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      stream: () => makeToolStream(),
    }
  },
  RateLimitError: class extends Error {
    override name = "RateLimitError"
  },
  AuthenticationError: class extends Error {
    override name = "AuthenticationError"
  },
  APIConnectionTimeoutError: class extends Error {
    override name = "APIConnectionTimeoutError"
  },
}))

import { AnthropicProvider } from "../src/providers/anthropic.js"
import type { LLMStreamEvent } from "../src/types.js"

describe("AnthropicProvider chatStream (mocked SDK)", () => {
  it("passes toolUseId through tool_input_delta", async () => {
    const provider = new AnthropicProvider("test-key")
    const events: LLMStreamEvent[] = []
    for await (const ev of provider.chatStream({
      system: "You are a test assistant.",
      messages: [{ role: "user", content: "Call demo" }],
      tools: [
        {
          name: "demo",
          description: "demo tool",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      maxTokens: 100,
      temperature: 0,
      model: "claude-haiku-3-5-20241022",
    })) {
      events.push(ev)
    }

    const inputDelta = events.find((e) => e.type === "tool_input_delta")
    expect(inputDelta?.type).toBe("tool_input_delta")
    if (inputDelta?.type === "tool_input_delta") {
      expect(inputDelta.toolUseId).toBe("toolu_01")
    }
  })
})
