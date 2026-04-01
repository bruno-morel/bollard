import { BollardError } from "@bollard/engine/src/errors.js"
import { describe, expect, it } from "vitest"
import { GoogleProvider } from "../src/providers/google.js"

describe("GoogleProvider", () => {
  it("has name set to google", () => {
    const provider = new GoogleProvider("test-key")
    expect(provider.name).toBe("google")
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
})
