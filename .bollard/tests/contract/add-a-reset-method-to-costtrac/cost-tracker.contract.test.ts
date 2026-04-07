import { CostTracker, createContext } from "@bollard/engine"
import { describe, expect, it } from "vitest"

describe("CostTracker reset() contract integration", () => {
  it("should maintain contract consistency when reset() is called through PipelineContext", () => {
    // Test the contract between @bollard/engine's context creation and CostTracker
    const config = {
      llm: { default: { provider: "test", model: "test" } },
      agent: { max_cost_usd: 10.0, max_duration_minutes: 30 },
    }

    const ctx = createContext("test task", "test-blueprint", config)

    // Verify initial state through context
    expect(ctx.costTracker.total()).toBe(0)
    expect(ctx.costTracker.remaining()).toBe(10.0)
    expect(ctx.costTracker.exceeded()).toBe(false)

    // Add some cost
    ctx.costTracker.add(5.0)
    expect(ctx.costTracker.total()).toBe(5.0)
    expect(ctx.costTracker.remaining()).toBe(5.0)

    // Reset and verify contract
    const previousTotal = ctx.costTracker.reset()
    expect(previousTotal).toBe(5.0)
    expect(ctx.costTracker.total()).toBe(0)
    expect(ctx.costTracker.remaining()).toBe(10.0)
    expect(ctx.costTracker.exceeded()).toBe(false)
  })

  it("should handle reset() when cost tracker is at limit", () => {
    const tracker = new CostTracker(5.0)

    // Fill to limit
    tracker.add(5.0)
    expect(tracker.exceeded()).toBe(false)
    expect(tracker.remaining()).toBe(0)

    // Add more to exceed
    tracker.add(2.0)
    expect(tracker.exceeded()).toBe(true)
    expect(tracker.total()).toBe(7.0)

    // Reset should restore non-exceeded state
    const previousTotal = tracker.reset()
    expect(previousTotal).toBe(7.0)
    expect(tracker.exceeded()).toBe(false)
    expect(tracker.remaining()).toBe(5.0)
    expect(tracker.total()).toBe(0)
  })

  it("should handle reset() with zero limit edge case", () => {
    const tracker = new CostTracker(0)

    // Any cost exceeds zero limit
    tracker.add(0.1)
    expect(tracker.exceeded()).toBe(true)

    // Reset with zero limit should still show exceeded if we add cost again
    const previousTotal = tracker.reset()
    expect(previousTotal).toBe(0.1)
    expect(tracker.exceeded()).toBe(false) // Reset clears exceeded state
    expect(tracker.remaining()).toBe(0)

    // But adding any cost immediately exceeds again
    tracker.add(0.01)
    expect(tracker.exceeded()).toBe(true)
  })

  it("should maintain precision across reset cycles", () => {
    const tracker = new CostTracker(1.0)

    // Add fractional costs
    tracker.add(0.333)
    tracker.add(0.334)
    const total1 = tracker.total()

    const reset1 = tracker.reset()
    expect(reset1).toBe(total1)
    expect(tracker.total()).toBe(0)

    // Second cycle
    tracker.add(0.1)
    tracker.add(0.2)
    const total2 = tracker.total()

    const reset2 = tracker.reset()
    expect(reset2).toBe(total2)
    expect(reset2).toBe(0.3)
  })

  it("should handle multiple resets without accumulating state", () => {
    const tracker = new CostTracker(10.0)

    // First cycle
    tracker.add(3.0)
    const reset1 = tracker.reset()
    expect(reset1).toBe(3.0)

    // Second cycle
    tracker.add(7.0)
    const reset2 = tracker.reset()
    expect(reset2).toBe(7.0)

    // Third cycle - should not be affected by previous cycles
    tracker.add(2.0)
    expect(tracker.total()).toBe(2.0)
    expect(tracker.remaining()).toBe(8.0)
    expect(tracker.exceeded()).toBe(false)

    const reset3 = tracker.reset()
    expect(reset3).toBe(2.0)
    expect(tracker.total()).toBe(0)
  })

  it("should handle reset() when no costs have been added", () => {
    const tracker = new CostTracker(5.0)

    // Reset with no prior costs
    const previousTotal = tracker.reset()
    expect(previousTotal).toBe(0)
    expect(tracker.total()).toBe(0)
    expect(tracker.remaining()).toBe(5.0)
    expect(tracker.exceeded()).toBe(false)
  })
})
