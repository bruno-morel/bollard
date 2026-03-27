import type { BollardConfig } from "@bollard/engine/src/context.js"

export function resolveConfig(): BollardConfig {
  return {
    llm: { default: { provider: "anthropic", model: "claude-sonnet-4-20250514" } },
    agent: { max_cost_usd: 1.0, max_duration_minutes: 10 },
  }
}
