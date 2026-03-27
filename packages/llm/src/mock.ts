import { BollardError } from "@bollard/engine/src/errors.js"
import type { LLMProvider, LLMRequest, LLMResponse } from "./types.js"

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
    return this._responses[this._callIndex++]!
  }
}
