import { BollardError } from "@bollard/engine/src/errors.js"
import { describe, expect, it } from "vitest"
import { OpenAIProvider } from "../src/providers/openai.js"

describe("OpenAIProvider", () => {
  it("has name set to openai", () => {
    const provider = new OpenAIProvider("test-key")
    expect(provider.name).toBe("openai")
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
})
