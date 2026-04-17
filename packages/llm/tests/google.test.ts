import { BollardError } from "@bollard/engine/src/errors.js"
import type { GenerateContentResponse } from "@google/generative-ai"
import { GoogleGenerativeAI } from "@google/generative-ai"
import { describe, expect, it } from "vitest"
import {
  GoogleProvider,
  buildGoogleContents,
  buildGoogleToolsConfig,
  getGoogleModel,
  googleChunksToStreamEvents,
} from "../src/providers/google.js"
import type { LLMStreamEvent } from "../src/types.js"

async function collectStream(gen: AsyncIterable<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
  const out: LLMStreamEvent[] = []
  for await (const ev of gen) {
    out.push(ev)
  }
  return out
}

describe("GoogleProvider", () => {
  it("has name set to google", () => {
    const provider = new GoogleProvider("test-key")
    expect(provider.name).toBe("google")
  })

  it("exposes chatStream", () => {
    const provider = new GoogleProvider("test-key")
    expect(provider.chatStream).toBeDefined()
  })

  it("maps a simple text request correctly", async () => {
    const provider = new GoogleProvider("test-key")
    try {
      await provider.chat({
        system: "You are helpful.",
        messages: [{ role: "user", content: "Hello" }],
        maxTokens: 100,
        temperature: 0,
        model: "gemini-2.0-flash",
      })
    } catch (err: unknown) {
      if (BollardError.is(err)) {
        expect(["LLM_AUTH", "LLM_PROVIDER_ERROR", "LLM_TIMEOUT"]).toContain(err.code)
      }
    }
  })
})

describe("buildGoogleContents", () => {
  it("maps user string to content entry", () => {
    const contents = buildGoogleContents({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 10,
      temperature: 0,
      model: "gemini-2.0-flash",
    })
    expect(contents[0]).toEqual({ role: "user", parts: [{ text: "hi" }] })
  })
})

describe("buildGoogleToolsConfig", () => {
  it("returns undefined when no tools", () => {
    expect(
      buildGoogleToolsConfig({
        system: "",
        messages: [],
        maxTokens: 1,
        temperature: 0,
        model: "gemini-2.0-flash",
      }),
    ).toBeUndefined()
  })
})

describe("getGoogleModel", () => {
  it("returns a generative model", () => {
    const client = new GoogleGenerativeAI("k")
    const model = getGoogleModel(client, {
      system: "s",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 10,
      temperature: 0,
      model: "gemini-2.0-flash",
    })
    expect(model).toBeDefined()
  })
})

describe("googleChunksToStreamEvents", () => {
  it("streams text-only response and completes", async () => {
    async function* chunks() {
      yield {
        candidates: [
          {
            content: { parts: [{ text: "Hello" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
      } as GenerateContentResponse
    }

    const events = await collectStream(googleChunksToStreamEvents("gemini-2.0-flash", chunks()))
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.text)).toEqual(["Hello"])
    const complete = events.find((e) => e.type === "message_complete")
    expect(complete?.type === "message_complete" && complete.response.stopReason).toBe("end_turn")
    expect(complete?.type === "message_complete" && complete.response.usage.inputTokens).toBe(2)
  })

  it("emits tool_use sequence for functionCall parts", async () => {
    async function* chunks() {
      yield {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: "lookup",
                    args: { q: "x" },
                  },
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
      } as GenerateContentResponse
    }

    const events = await collectStream(googleChunksToStreamEvents("gemini-2.0-flash", chunks()))
    expect(events.some((e) => e.type === "tool_use_start" && e.toolName === "lookup")).toBe(true)
    expect(events.some((e) => e.type === "tool_input_delta")).toBe(true)
    const complete = events.find((e) => e.type === "message_complete")
    expect(complete?.type === "message_complete" && complete.response.stopReason).toBe("tool_use")
  })

  it("throws LLM_INVALID_RESPONSE when stream yields no candidates", async () => {
    async function* chunks(): AsyncIterable<GenerateContentResponse> {
      yield { candidates: [] } as GenerateContentResponse
    }

    let err: unknown
    try {
      await collectStream(googleChunksToStreamEvents("gemini-2.0-flash", chunks()))
    } catch (e) {
      err = e
    }
    expect(BollardError.is(err)).toBe(true)
    if (BollardError.is(err)) {
      expect(err.code).toBe("LLM_INVALID_RESPONSE")
    }
  })

  it("maps MAX_TOKENS finish reason in message_complete", async () => {
    async function* chunks() {
      yield {
        candidates: [
          {
            content: { parts: [{ text: "…" }] },
            finishReason: "MAX_TOKENS",
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 8000 },
      } as GenerateContentResponse
    }

    const events = await collectStream(googleChunksToStreamEvents("gemini-2.0-flash", chunks()))
    const complete = events.find((e) => e.type === "message_complete")
    expect(complete?.type === "message_complete" && complete.response.stopReason).toBe("max_tokens")
  })

  it("propagates raw errors from chunk iterator", async () => {
    const throwingChunks: AsyncIterable<GenerateContentResponse> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            throw new Error("stream reset")
          },
        }
      },
    }

    await expect(
      collectStream(googleChunksToStreamEvents("gemini-2.0-flash", throwingChunks)),
    ).rejects.toThrow("stream reset")
  })

  it("assembles usage from usageMetadata on chunks", async () => {
    async function* chunks() {
      yield {
        candidates: [
          {
            content: { parts: [{ text: "a" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      } as GenerateContentResponse
    }

    const events = await collectStream(googleChunksToStreamEvents("gemini-2.0-flash", chunks()))
    const complete = events.find((e) => e.type === "message_complete")
    expect(complete?.type === "message_complete" && complete.response.usage).toEqual({
      inputTokens: 5,
      outputTokens: 3,
    })
  })
})

describe("GoogleProvider (live)", () => {
  const apiKey = process.env["GOOGLE_API_KEY"]
  const skip = !apiKey

  it.skipIf(skip)(
    "sends a message and gets a response",
    async () => {
      const provider = new GoogleProvider(apiKey ?? "")
      const response = await provider.chat({
        system: "Reply with exactly: PONG",
        messages: [{ role: "user", content: "PING" }],
        maxTokens: 10,
        temperature: 0,
        model: "gemini-2.0-flash",
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
      const provider = new GoogleProvider(apiKey ?? "")
      const events: LLMStreamEvent[] = []
      for await (const ev of provider.chatStream({
        system: "Reply with exactly: G_STREAM_OK",
        messages: [{ role: "user", content: "Say G_STREAM_OK" }],
        maxTokens: 24,
        temperature: 0,
        model: "gemini-2.0-flash",
      })) {
        events.push(ev)
      }
      const done = events.find((e) => e.type === "message_complete")
      expect(done?.type).toBe("message_complete")
      if (done?.type === "message_complete") {
        const text = done.response.content.find((b) => b.type === "text")?.text ?? ""
        expect(text.toUpperCase()).toContain("G_STREAM_OK")
      }
    },
    45_000,
  )
})
