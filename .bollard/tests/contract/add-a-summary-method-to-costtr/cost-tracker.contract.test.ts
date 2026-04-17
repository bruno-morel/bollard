import { createContext } from "@bollard/engine/src/context.js"
import { CostTracker } from "@bollard/engine/src/cost-tracker.js"
import { describe, expect, it, vi } from "vitest"

describe("contract tests", () => {
  it("summary returns formatted cost string", () => {
    const tracker = new CostTracker(100)
    tracker.add(25.5)
    const summary = tracker.summary()
    expect(summary).toBe("$25.50 / $100.00 (25.5% used)")
  })

  it("summary shows EXCEEDED when over budget", () => {
    const tracker = new CostTracker(50)
    tracker.add(75.25)
    const summary = tracker.summary()
    expect(summary).toBe("$75.25 / $50.00 (150.5% used) [EXCEEDED]")
  })

  it("summary handles zero cost", () => {
    const tracker = new CostTracker(100)
    const summary = tracker.summary()
    expect(summary).toBe("$0.00 / $100.00 (0.0% used)")
  })

  it("summary works with PipelineContext cost tracker", () => {
    const config = {
      llm: { default: { provider: "test", model: "test" } },
      agent: { max_cost_usd: 50, max_duration_minutes: 10 },
    }
    const ctx = createContext("test task", "test-blueprint", config)
    ctx.costTracker.add(12.34)
    const summary = ctx.costTracker.summary()
    expect(summary).toBe("$12.34 / $50.00 (24.7% used)")
  })

  it("summary handles zero limit edge case", () => {
    const tracker = new CostTracker(0)
    tracker.add(5)
    const summary = tracker.summary()
    expect(summary).toMatch(/\$5\.00 \/ \$0\.00 \(.*\) \[EXCEEDED\]/)
  })

  it("summary total matches snapshot totalCostUsd", () => {
    const tracker = new CostTracker(100)
    tracker.add(42.75)
    const snapshot = tracker.snapshot()
    const summary = tracker.summary()
    expect(summary).toContain("$42.75")
    expect(snapshot.totalCostUsd).toBe(42.75)
  })
})
