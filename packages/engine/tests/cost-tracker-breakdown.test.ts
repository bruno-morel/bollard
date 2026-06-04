import { describe, expect, it } from "vitest"
import { CostTracker } from "../src/cost-tracker.js"

describe("CostTracker.breakdown()", () => {
  it("returns correct structure with all required properties", () => {
    const tracker = new CostTracker(100)
    const breakdown = tracker.breakdown()

    expect(breakdown).toHaveProperty("totalCostUsd")
    expect(breakdown).toHaveProperty("limitUsd")
    expect(breakdown).toHaveProperty("remainingUsd")
    expect(breakdown).toHaveProperty("percentUsed")
    expect(breakdown).toHaveProperty("isUnlimited")
    expect(typeof breakdown.totalCostUsd).toBe("number")
    expect(typeof breakdown.limitUsd).toBe("number")
    expect(typeof breakdown.remainingUsd).toBe("number")
    expect(typeof breakdown.percentUsed).toBe("number")
    expect(typeof breakdown.isUnlimited).toBe("boolean")
  })

  it("returns correct values for zero total", () => {
    const tracker = new CostTracker(100)
    const breakdown = tracker.breakdown()

    expect(breakdown.totalCostUsd).toBe(0)
    expect(breakdown.limitUsd).toBe(100)
    expect(breakdown.remainingUsd).toBe(100)
    expect(breakdown.percentUsed).toBe(0)
    expect(breakdown.isUnlimited).toBe(false)
  })

  it("returns correct values for partial usage", () => {
    const tracker = new CostTracker(100)
    tracker.add(25)
    const breakdown = tracker.breakdown()

    expect(breakdown.totalCostUsd).toBe(25)
    expect(breakdown.limitUsd).toBe(100)
    expect(breakdown.remainingUsd).toBe(75)
    expect(breakdown.percentUsed).toBe(25)
    expect(breakdown.isUnlimited).toBe(false)
  })

  it("returns correct values at limit", () => {
    const tracker = new CostTracker(100)
    tracker.add(100)
    const breakdown = tracker.breakdown()

    expect(breakdown.totalCostUsd).toBe(100)
    expect(breakdown.limitUsd).toBe(100)
    expect(breakdown.remainingUsd).toBe(0)
    expect(breakdown.percentUsed).toBe(100)
    expect(breakdown.isUnlimited).toBe(false)
  })

  it("returns correct values over limit", () => {
    const tracker = new CostTracker(100)
    tracker.add(150)
    const breakdown = tracker.breakdown()

    expect(breakdown.totalCostUsd).toBe(150)
    expect(breakdown.limitUsd).toBe(100)
    expect(breakdown.remainingUsd).toBe(0)
    expect(breakdown.percentUsed).toBe(100) // clamped to 100
    expect(breakdown.isUnlimited).toBe(false)
  })

  it("returns correct values for unlimited budget", () => {
    const tracker = new CostTracker(Number.POSITIVE_INFINITY)
    tracker.add(1000)
    const breakdown = tracker.breakdown()

    expect(breakdown.totalCostUsd).toBe(1000)
    expect(breakdown.limitUsd).toBe(Number.POSITIVE_INFINITY)
    expect(breakdown.remainingUsd).toBe(Number.POSITIVE_INFINITY)
    expect(breakdown.percentUsed).toBe(0)
    expect(breakdown.isUnlimited).toBe(true)
  })

  it("returns correct values for zero limit with zero total", () => {
    const tracker = new CostTracker(0)
    const breakdown = tracker.breakdown()

    expect(breakdown.totalCostUsd).toBe(0)
    expect(breakdown.limitUsd).toBe(0)
    expect(breakdown.remainingUsd).toBe(0)
    expect(breakdown.percentUsed).toBe(0)
    expect(breakdown.isUnlimited).toBe(false)
  })

  it("returns correct values for zero limit with positive total", () => {
    const tracker = new CostTracker(0)
    tracker.add(50)
    const breakdown = tracker.breakdown()

    expect(breakdown.totalCostUsd).toBe(50)
    expect(breakdown.limitUsd).toBe(0)
    expect(breakdown.remainingUsd).toBe(0)
    expect(breakdown.percentUsed).toBe(100) // shows as exceeded
    expect(breakdown.isUnlimited).toBe(false)
  })

  it("clamps percentUsed to [0, 100] range", () => {
    const tracker = new CostTracker(50)
    tracker.add(200) // 400% usage
    const breakdown = tracker.breakdown()

    expect(breakdown.percentUsed).toBe(100) // clamped to 100
    expect(breakdown.percentUsed).toBeGreaterThanOrEqual(0)
    expect(breakdown.percentUsed).toBeLessThanOrEqual(100)
  })

  it("is idempotent - repeated calls return identical values", () => {
    const tracker = new CostTracker(100)
    tracker.add(30)

    const breakdown1 = tracker.breakdown()
    const breakdown2 = tracker.breakdown()
    const breakdown3 = tracker.breakdown()

    expect(breakdown1).toEqual(breakdown2)
    expect(breakdown2).toEqual(breakdown3)
  })

  it("does not modify internal state", () => {
    const tracker = new CostTracker(100)
    tracker.add(50)

    const totalBefore = tracker.total()
    const limitBefore = tracker.limitUsd()
    const remainingBefore = tracker.remaining()

    tracker.breakdown()

    expect(tracker.total()).toBe(totalBefore)
    expect(tracker.limitUsd()).toBe(limitBefore)
    expect(tracker.remaining()).toBe(remainingBefore)
  })

  it("does not affect subsequent operations", () => {
    const tracker = new CostTracker(100)
    tracker.add(30)

    tracker.breakdown()

    // Should still be able to add more cost
    tracker.add(20)
    expect(tracker.total()).toBe(50)

    const breakdown = tracker.breakdown()
    expect(breakdown.totalCostUsd).toBe(50)
    expect(breakdown.percentUsed).toBe(50)
  })

  it("matches individual method results", () => {
    const tracker = new CostTracker(200)
    tracker.add(75)

    const breakdown = tracker.breakdown()

    expect(breakdown.totalCostUsd).toBe(tracker.total())
    expect(breakdown.limitUsd).toBe(tracker.limitUsd())
    expect(breakdown.remainingUsd).toBe(tracker.remaining())
    expect(breakdown.isUnlimited).toBe(tracker.isUnlimited())
  })

  it("returns new object on each call", () => {
    const tracker = new CostTracker(100)
    tracker.add(25)

    const breakdown1 = tracker.breakdown()
    const breakdown2 = tracker.breakdown()

    expect(breakdown1).not.toBe(breakdown2) // different object references
    expect(breakdown1).toEqual(breakdown2) // but same values
  })

  it("handles fractional percentages correctly", () => {
    const tracker = new CostTracker(300)
    tracker.add(100) // 33.333...%

    const breakdown = tracker.breakdown()

    expect(breakdown.percentUsed).toBeCloseTo(33.333333333333336, 10)
    expect(breakdown.percentUsed).toBeGreaterThanOrEqual(0)
    expect(breakdown.percentUsed).toBeLessThanOrEqual(100)
  })
})
