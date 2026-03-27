import type { BollardConfig } from "@bollard/engine/src/context.js"
import type { LLMProvider } from "./types.js"

export class LLMClient {
  constructor(private _config: BollardConfig) {}

  forAgent(_agentRole: string): { provider: LLMProvider; model: string } {
    return { provider: {} as LLMProvider, model: "" }
  }
}
