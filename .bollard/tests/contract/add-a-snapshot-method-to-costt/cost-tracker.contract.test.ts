import { CostTracker, createContext } from "@bollard/engine"
import { describe, expect, it } from "vitest"

describe("CostTracker snapshot() contract probes", () => {
  it("should return readonly snapshot without mutating state", () => {
    const tracker = new CostTracker(100.0)
    tracker.add(25.5)
    tracker.add(10.25)

    const snapshot1 = tracker.snapshot()
    const snapshot2 = tracker.snapshot()

    // Contract: snapshot returns current accumulated cost
    expect(snapshot1.totalCostUsd).toBeCloseTo(35.75, 2)
    expect(snapshot2.totalCostUsd).toBeCloseTo(35.75, 2)

    // Contract: snapshot does not mutate internal state
    expect(tracker.total()).toBeCloseTo(35.75, 2)

    // Contract: multiple snapshots return equal values
    expect(snapshot1.totalCostUsd).toBeCloseTo(snapshot2.totalCostUsd, 2)
  })

  it("should integrate correctly with PipelineContext cost tracking", () => {
    const config = {
      llm: { default: { provider: "test", model: "test" } },
      agent: { max_cost_usd: 100, max_duration_minutes: 30 },
    }
    const ctx = createContext("test-task", "test-blueprint", config)

    // Contract: context uses same CostTracker instance
    ctx.costTracker.add(42.17)

    const snapshot = ctx.costTracker.snapshot()

    // Contract: snapshot reflects costs added through context
    expect(snapshot.totalCostUsd).toBeCloseTo(42.17, 2)
    expect(ctx.costTracker.total()).toBeCloseTo(42.17, 2)
  })

  it("should handle edge case of zero cost correctly", () => {
    const tracker = new CostTracker(10.0)

    const snapshot = tracker.snapshot()

    // Contract: snapshot of fresh tracker returns zero
    expect(snapshot.totalCostUsd).toBe(0)
    expect(tracker.total()).toBe(0)
  })

  it("should handle floating point precision in snapshot", () => {
    const tracker = new CostTracker(100.0)

    // Add costs that create floating point precision issues
    tracker.add(0.1)
    tracker.add(0.2)
    tracker.add(0.3)

    const snapshot = tracker.snapshot()

    // Contract: snapshot handles floating point arithmetic correctly
    expect(snapshot.totalCostUsd).toBeCloseTo(0.6, 2)
    expect(tracker.total()).toBeCloseTo(0.6, 2)
  })

  it("should maintain consistency between snapshot and other methods after reset", () => {
    const tracker = new CostTracker(50.0)
    tracker.add(25.0)

    const preResetSnapshot = tracker.snapshot()
    expect(preResetSnapshot.totalCostUsd).toBeCloseTo(25.0, 2)

    const resetValue = tracker.reset()
    expect(resetValue).toBeCloseTo(25.0, 2)

    const postResetSnapshot = tracker.snapshot()

    // Contract: snapshot reflects reset state
    expect(postResetSnapshot.totalCostUsd).toBe(0)
    expect(tracker.total()).toBe(0)
  })
})
