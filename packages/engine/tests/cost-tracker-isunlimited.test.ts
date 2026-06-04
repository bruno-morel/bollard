import { describe, expect, it } from "vitest"
import { CostTracker } from "../src/cost-tracker.js"

describe("CostTracker.isUnlimited()", () => {
  it("returns true when tracker is constructed with Infinity", () => {
    const tracker = new CostTracker(Number.POSITIVE_INFINITY)
    expect(tracker.isUnlimited()).toBe(true)
  })

  it("returns false when tracker is constructed with a finite positive number", () => {
    const tracker = new CostTracker(100)
    expect(tracker.isUnlimited()).toBe(false)
  })

  it("returns false when tracker is constructed with 0", () => {
    const tracker = new CostTracker(0)
    expect(tracker.isUnlimited()).toBe(false)
  })

  it("does not modify internal state (idempotent across repeated calls)", () => {
    const tracker = new CostTracker(Number.POSITIVE_INFINITY)

    // Call isUnlimited() multiple times
    const result1 = tracker.isUnlimited()
    const result2 = tracker.isUnlimited()
    const result3 = tracker.isUnlimited()

    // All calls should return the same result
    expect(result1).toBe(true)
    expect(result2).toBe(true)
    expect(result3).toBe(true)

    // Verify internal state hasn't changed
    expect(tracker.total()).toBe(0)
    expect(tracker.limitUsd()).toBe(Number.POSITIVE_INFINITY)
    expect(tracker.runCount()).toBe(0)
  })

  it("returns correct value after adding costs", () => {
    const unlimitedTracker = new CostTracker(Number.POSITIVE_INFINITY)
    const limitedTracker = new CostTracker(50)

    // Add some costs
    unlimitedTracker.add(25)
    limitedTracker.add(25)

    // isUnlimited() should still return the same values
    expect(unlimitedTracker.isUnlimited()).toBe(true)
    expect(limitedTracker.isUnlimited()).toBe(false)
  })

  it("returns correct value for various finite limits", () => {
    const limits = [0, 0.01, 1, 10, 100, 1000, Number.MAX_SAFE_INTEGER]

    for (const limit of limits) {
      const tracker = new CostTracker(limit)
      expect(tracker.isUnlimited()).toBe(false)
    }
  })
})
