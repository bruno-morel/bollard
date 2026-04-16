import { describe, expect, it } from "vitest"
import { MockProvider } from "../src/mock.js"
import type { LLMRequest, LLMResponse } from "../src/types.js"

const SAMPLE: LLMResponse = {
  content: [{ type: "text", text: "one two three" }],
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 3 },
  costUsd: 0,
}

describe("MockProvider chatStream", () => {
  it("yields text_delta chunks then message_complete", async () => {
    const mock = new MockProvider([SAMPLE])
    const req: LLMRequest = {
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
      temperature: 0,
      model: "m",
    }
    const events: string[] = []
    for await (const ev of mock.chatStream(req)) {
      if (ev.type === "text_delta") events.push(ev.text)
      if (ev.type === "message_complete") {
        expect(ev.response.content[0]?.text).toBe("one two three")
      }
    }
    expect(events.length).toBeGreaterThan(0)
    expect(events.join("").trim()).toContain("one")
  })

  it("handles single-word response", async () => {
    const oneWord: LLMResponse = {
      content: [{ type: "text", text: "hi" }],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: 0,
    }
    const mock = new MockProvider([oneWord])
    const req: LLMRequest = {
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
      temperature: 0,
      model: "m",
    }
    const deltas: string[] = []
    for await (const ev of mock.chatStream(req)) {
      if (ev.type === "text_delta") deltas.push(ev.text)
    }
    expect(deltas.some((d) => d.includes("hi"))).toBe(true)
  })

  it("message_complete carries full canned response", async () => {
    const mock = new MockProvider([SAMPLE])
    const req: LLMRequest = {
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
      temperature: 0,
      model: "m",
    }
    let final: LLMResponse | undefined
    for await (const ev of mock.chatStream(req)) {
      if (ev.type === "message_complete") final = ev.response
    }
    expect(final?.stopReason).toBe("end_turn")
    expect(final?.usage.outputTokens).toBe(3)
  })
})
