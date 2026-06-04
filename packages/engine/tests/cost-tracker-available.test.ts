import { describe, expect, it } from "vitest"
import { CostTracker } from "../src/cost-tracker.js"

describe("CostTracker.available()", () => {
  it("returns true when limit is Infinity", () => {
    const tracker = new CostTracker(Number.POSITIVE_INFINITY)
    expect(tracker.available()).toBe(true)
  })

  it("returns true when limit is Infinity and costs have been added", () => {
    const tracker = new CostTracker(Number.POSITIVE_INFINITY)
    tracker.add(100)
    expect(tracker.available()).toBe(true)
  })

  it("returns true when finite limit has remaining budget", () => {
    const tracker = new CostTracker(100)
    tracker.add(50)
    expect(tracker.available()).toBe(true)
  })

  it("returns false when finite limit is exactly exhausted", () => {
    const tracker = new CostTracker(100)
    tracker.add(100)
    expect(tracker.available()).toBe(false)
  })

  it("returns false when finite limit is exceeded", () => {
    const tracker = new CostTracker(100)
    tracker.add(150)
    expect(tracker.available()).toBe(false)
  })

  it("returns false for zero limit (remaining() is 0)", () => {
    const tracker = new CostTracker(0)
    expect(tracker.available()).toBe(false)
  })

  it("returns boolean type", () => {
    const tracker = new CostTracker(100)
    const result = tracker.available()
    expect(typeof result).toBe("boolean")
  })

  it("is idempotent - multiple calls return same result", () => {
    const tracker = new CostTracker(100)
    tracker.add(50)

    const first = tracker.available()
    const second = tracker.available()
    const third = tracker.available()

    expect(first).toBe(true)
    expect(second).toBe(true)
    expect(third).toBe(true)
    expect(first).toBe(second)
    expect(second).toBe(third)
  })

  it("does not modify tracker state", () => {
    const tracker = new CostTracker(100)
    tracker.add(50)

    const totalBefore = tracker.total()
    const limitBefore = tracker.limitUsd()
    const runCountBefore = tracker.runCount()

    tracker.available()

    expect(tracker.total()).toBe(totalBefore)
    expect(tracker.limitUsd()).toBe(limitBefore)
    expect(tracker.runCount()).toBe(runCountBefore)
  })

  it("returns correct value after reset()", () => {
    const tracker = new CostTracker(100)
    tracker.add(100)
    expect(tracker.available()).toBe(false)

    tracker.reset()
    expect(tracker.available()).toBe(true)
  })

  it("returns correct value after add() operations", () => {
    const tracker = new CostTracker(100)
    expect(tracker.available()).toBe(true)

    tracker.add(50)
    expect(tracker.available()).toBe(true)

    tracker.add(50)
    expect(tracker.available()).toBe(false)
  })

  it("returns correct value after subtract() operations", () => {
    const tracker = new CostTracker(100)
    tracker.add(100)
    expect(tracker.available()).toBe(false)

    tracker.subtract(50)
    expect(tracker.available()).toBe(true)
  })

  it("handles edge case with very small remaining budget", () => {
    const tracker = new CostTracker(100)
    tracker.add(99.99)
    expect(tracker.available()).toBe(true)

    tracker.add(0.01)
    expect(tracker.available()).toBe(false)
  })

  it("works correctly with chained operations", () => {
    const tracker = new CostTracker(100)
    tracker.add(30).add(20)
    expect(tracker.available()).toBe(true)

    tracker.add(50)
    expect(tracker.available()).toBe(false)
  })
})
