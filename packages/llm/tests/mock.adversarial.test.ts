import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import { MockProvider } from "../src/mock.js"
import { BollardError } from "@bollard/engine/src/errors.js"
import type { LLMRequest, LLMResponse } from "../src/types.js"

function textResponse(text: string): LLMResponse {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1 },
    costUsd: 0,
  }
}

const minimalRequest: LLMRequest = {
  system: "s",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 100,
  temperature: 0,
  model: "m",
}

describe("MockProvider", () => {
  it("has name mock", () => {
    expect(new MockProvider().name).toBe("mock")
  })

  it("throws when no canned responses remain", async () => {
    const provider = new MockProvider([])
    await expect(provider.chat(minimalRequest)).rejects.toMatchObject({ code: "LLM_PROVIDER_ERROR" })
  })

  it("returns canned responses in order", async () => {
    const provider = new MockProvider([textResponse("a"), textResponse("b")])
    const r1 = await provider.chat(minimalRequest)
    const r2 = await provider.chat(minimalRequest)
    expect(r1.content[0]).toEqual({ type: "text", text: "a" })
    expect(r2.content[0]).toEqual({ type: "text", text: "b" })
  })

  it("returns valid LLMResponse fields", async () => {
    const provider = new MockProvider([textResponse("x")])
    const r = await provider.chat(minimalRequest)
    expect(r.stopReason).toBe("end_turn")
    expect(r.usage.inputTokens).toBeGreaterThanOrEqual(0)
    expect(r.usage.outputTokens).toBeGreaterThanOrEqual(0)
    expect(typeof r.costUsd).toBe("number")
  })
})

describe("MockProvider property tests", () => {
  it("accepts varied message content", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 200 }), async (userText) => {
        const provider = new MockProvider([textResponse("ok")])
        const req: LLMRequest = {
          ...minimalRequest,
          messages: [{ role: "user", content: userText }],
        }
        const r = await provider.chat(req)
        expect(r.content[0]?.type).toBe("text")
      }),
    )
  })
})

describe("MockProvider errors", () => {
  it("throws BollardError when exhausted", async () => {
    const provider = new MockProvider([textResponse("once")])
    await provider.chat(minimalRequest)
    try {
      await provider.chat(minimalRequest)
      expect.fail("expected throw")
    } catch (e) {
      expect(BollardError.is(e)).toBe(true)
    }
  })
})
