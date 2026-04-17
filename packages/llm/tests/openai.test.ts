import { BollardError } from "@bollard/engine/src/errors.js"
import type OpenAI from "openai"
import { describe, expect, it } from "vitest"
import {
  OpenAIProvider,
  buildOpenAIMessages,
  openAIChunksToStreamEvents,
} from "../src/providers/openai.js"
import type { LLMStreamEvent } from "../src/types.js"

async function collectStream(gen: AsyncIterable<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
  const out: LLMStreamEvent[] = []
  for await (const ev of gen) {
    out.push(ev)
  }
  return out
}

function asChunk(partial: unknown): OpenAI.Chat.Completions.ChatCompletionChunk {
  return partial as OpenAI.Chat.Completions.ChatCompletionChunk
}

describe("OpenAIProvider", () => {
  it("has name set to openai", () => {
    const provider = new OpenAIProvider("test-key")
    expect(provider.name).toBe("openai")
  })

  it("exposes chatStream", () => {
    const provider = new OpenAIProvider("test-key")
    expect(provider.chatStream).toBeDefined()
  })

  it("maps a simple text request correctly", async () => {
    const provider = new OpenAIProvider("test-key")
    try {
      await provider.chat({
        system: "You are helpful.",
        messages: [{ role: "user", content: "Hello" }],
        maxTokens: 100,
        temperature: 0,
        model: "gpt-4o-mini",
      })
    } catch (err: unknown) {
      if (BollardError.is(err)) {
        expect(["LLM_AUTH", "LLM_PROVIDER_ERROR", "LLM_TIMEOUT"]).toContain(err.code)
      }
    }
  })
})

describe("buildOpenAIMessages", () => {
  it("includes system and user string message", () => {
    const messages = buildOpenAIMessages({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 10,
      temperature: 0,
      model: "gpt-4o-mini",
    })
    expect(messages[0]).toEqual({ role: "system", content: "sys" })
    expect(messages[1]).toEqual({ role: "user", content: "hi" })
  })
})

describe("openAIChunksToStreamEvents", () => {
  it("streams text-only response and completes", async () => {
    async function* chunks() {
      yield asChunk({
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Hello" },
            finish_reason: null,
          },
        ],
      })
      yield asChunk({
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      })
    }

    const events = await collectStream(openAIChunksToStreamEvents("gpt-4o-mini", chunks()))
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.text)).toEqual(["Hello"])
    const complete = events.find((e) => e.type === "message_complete")
    expect(complete?.type === "message_complete" && complete.response.stopReason).toBe("end_turn")
    expect(complete?.type === "message_complete" && complete.response.content[0]?.text).toBe(
      "Hello",
    )
  })

  it("streams tool calls with buffering by index", async () => {
    async function* chunks() {
      yield asChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_abc",
                  type: "function",
                  function: { name: "get_weather" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })
      yield asChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '{"city":"NYC"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })
      yield asChunk({
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
    }

    const events = await collectStream(openAIChunksToStreamEvents("gpt-4o-mini", chunks()))
    expect(events.some((e) => e.type === "tool_use_start" && e.toolName === "get_weather")).toBe(
      true,
    )
    expect(events.some((e) => e.type === "tool_input_delta" && e.toolUseId === "call_abc")).toBe(
      true,
    )
    const complete = events.find((e) => e.type === "message_complete")
    expect(complete?.type === "message_complete" && complete.response.stopReason).toBe("tool_use")
    expect(
      complete?.type === "message_complete" &&
        complete.response.content.find((b) => b.type === "tool_use")?.toolInput,
    ).toEqual({ city: "NYC" })
  })

  it("handles two tool calls at different indices", async () => {
    async function* chunks() {
      yield asChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "c1", type: "function", function: { name: "a" } },
                { index: 1, id: "c2", type: "function", function: { name: "b" } },
              ],
            },
            finish_reason: null,
          },
        ],
      })
      yield asChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: "{}" } },
                { index: 1, function: { arguments: "{}" } },
              ],
            },
            finish_reason: null,
          },
        ],
      })
      yield asChunk({
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      })
    }

    const events = await collectStream(openAIChunksToStreamEvents("gpt-4o-mini", chunks()))
    const starts = events.filter((e) => e.type === "tool_use_start")
    expect(starts).toHaveLength(2)
    const complete = events.find((e) => e.type === "message_complete")
    expect(
      complete?.type === "message_complete" &&
        complete.response.content.filter((b) => b.type === "tool_use"),
    ).toHaveLength(2)
  })

  it("throws LLM_INVALID_RESPONSE when stream has no finish_reason", async () => {
    async function* chunks() {
      yield asChunk({
        choices: [
          {
            index: 0,
            delta: { content: "x" },
            finish_reason: null,
          },
        ],
      })
    }

    let invalidErr: unknown
    try {
      await collectStream(openAIChunksToStreamEvents("gpt-4o-mini", chunks()))
    } catch (e) {
      invalidErr = e
    }
    expect(BollardError.is(invalidErr)).toBe(true)
    if (BollardError.is(invalidErr)) {
      expect(invalidErr.code).toBe("LLM_INVALID_RESPONSE")
    }
  })

  it("maps finish_reason length to max_tokens in message_complete", async () => {
    async function* chunks() {
      yield asChunk({
        choices: [{ index: 0, delta: { content: "..." }, finish_reason: "length" }],
        usage: { prompt_tokens: 1, completion_tokens: 100, total_tokens: 101 },
      })
    }

    const events = await collectStream(openAIChunksToStreamEvents("gpt-4o-mini", chunks()))
    const complete = events.find((e) => e.type === "message_complete")
    expect(complete?.type === "message_complete" && complete.response.stopReason).toBe("max_tokens")
  })

  it("propagates raw errors from chunk iterator (mapper does not wrap)", async () => {
    const throwingChunks: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            throw new Error("network reset")
          },
        }
      },
    }

    await expect(
      collectStream(openAIChunksToStreamEvents("gpt-4o-mini", throwingChunks)),
    ).rejects.toThrow("network reset")
  })
})

describe("OpenAIProvider (live)", () => {
  const apiKey = process.env["OPENAI_API_KEY"]
  const skip = !apiKey

  it.skipIf(skip)(
    "sends a message and gets a response",
    async () => {
      const provider = new OpenAIProvider(apiKey ?? "")
      const response = await provider.chat({
        system: "Reply with exactly: PONG",
        messages: [{ role: "user", content: "PING" }],
        maxTokens: 10,
        temperature: 0,
        model: "gpt-4o-mini",
      })

      expect(response.content.length).toBeGreaterThan(0)
      const text = response.content.find((b) => b.type === "text")?.text ?? ""
      expect(text.toUpperCase()).toContain("PONG")
      expect(response.usage.inputTokens).toBeGreaterThan(0)
      expect(response.stopReason).toBe("end_turn")
    },
    30_000,
  )

  it.skipIf(skip)(
    "chatStream yields message_complete",
    async () => {
      const provider = new OpenAIProvider(apiKey ?? "")
      const events: LLMStreamEvent[] = []
      for await (const ev of provider.chatStream({
        system: "Reply with exactly: STREAM_OK",
        messages: [{ role: "user", content: "Say STREAM_OK" }],
        maxTokens: 20,
        temperature: 0,
        model: "gpt-4o-mini",
      })) {
        events.push(ev)
      }
      const done = events.find((e) => e.type === "message_complete")
      expect(done?.type).toBe("message_complete")
      if (done?.type === "message_complete") {
        const text = done.response.content.find((b) => b.type === "text")?.text ?? ""
        expect(text.toUpperCase()).toContain("STREAM_OK")
      }
    },
    45_000,
  )
})
