import { BollardError } from "@bollard/engine/src/errors.js"
import type { LLMProvider, LLMRequest, LLMResponse, LLMStreamEvent } from "./types.js"

export class MockProvider implements LLMProvider {
  readonly name = "mock"
  private _callIndex = 0

  constructor(private readonly _responses: LLMResponse[] = []) {}

  async chat(_request: LLMRequest): Promise<LLMResponse> {
    if (this._callIndex >= this._responses.length) {
      throw new BollardError({
        code: "LLM_PROVIDER_ERROR",
        message: `MockProvider: no more canned responses (called ${this._callIndex + 1} times, have ${this._responses.length})`,
      })
    }
    const response = this._responses[this._callIndex++]
    return response as LLMResponse
  }

  async *chatStream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const response = await this.chat(request)
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
    const words = text.split(/\s+/).filter((w) => w.length > 0)
    for (const w of words) {
      yield { type: "text_delta", text: `${w} ` }
    }
    yield { type: "message_complete", response }
  }
}
