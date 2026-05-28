import { describe, expect, it } from "vitest"
import { CostTracker } from "../src/cost-tracker.js"

describe("CostTracker.reset", () => {
  it("returns undefined (void)", () => {
    const tracker = new CostTracker(10)
    tracker.add(5)

    const result = tracker.reset()

    expect(result).toBeUndefined()
  })

  it("sets _total back to 0", () => {
    const tracker = new CostTracker(10)
    tracker.add(3.5)
    tracker.add(1.5)
    expect(tracker.total()).toBe(5)

    tracker.reset()

    expect(tracker.total()).toBe(0)
  })

  it("clears _runCount back to 0", () => {
    const tracker = new CostTracker(10)
    tracker.add(2)
    tracker.add(3)
    expect(tracker.runCount()).toBe(2)

    tracker.reset()

    expect(tracker.runCount()).toBe(0)
  })

  it("restores remaining budget to original limit", () => {
    const tracker = new CostTracker(10)
    tracker.add(7)
    expect(tracker.remaining()).toBe(3)

    tracker.reset()

    expect(tracker.remaining()).toBe(10)
  })

  it("clears exceeded state after reset", () => {
    const tracker = new CostTracker(5)
    tracker.add(8)
    expect(tracker.exceeded()).toBe(true)

    tracker.reset()

    expect(tracker.exceeded()).toBe(false)
  })

  it("handles multiple consecutive reset() calls", () => {
    const tracker = new CostTracker(10)
    tracker.add(5)

    const firstResult = tracker.reset()
    const secondResult = tracker.reset()
    const thirdResult = tracker.reset()

    expect(firstResult).toBeUndefined()
    expect(secondResult).toBeUndefined()
    expect(thirdResult).toBeUndefined()
    expect(tracker.total()).toBe(0)
    expect(tracker.runCount()).toBe(0)
  })

  it("works correctly after adding costs post-reset", () => {
    const tracker = new CostTracker(10)
    tracker.add(3)
    tracker.reset()

    tracker.add(2)
    tracker.add(1)

    expect(tracker.total()).toBe(3)
    expect(tracker.remaining()).toBe(7)
    expect(tracker.exceeded()).toBe(false)
    expect(tracker.runCount()).toBe(2)
  })

  it("works with zero limit", () => {
    const tracker = new CostTracker(0)
    tracker.add(1)
    expect(tracker.exceeded()).toBe(true)
    expect(tracker.remaining()).toBe(0)

    const result = tracker.reset()

    expect(result).toBeUndefined()
    expect(tracker.total()).toBe(0)
    expect(tracker.remaining()).toBe(0)
    expect(tracker.exceeded()).toBe(false)
    expect(tracker.runCount()).toBe(0)
  })

  it("works with positive limit values", () => {
    const tracker = new CostTracker(100)
    tracker.add(25.5)

    tracker.reset()

    expect(tracker.total()).toBe(0)
    expect(tracker.remaining()).toBe(100)
    expect(tracker.exceeded()).toBe(false)
  })

  it("works with large limit values", () => {
    const tracker = new CostTracker(999999)
    tracker.add(500000)

    tracker.reset()

    expect(tracker.total()).toBe(0)
    expect(tracker.remaining()).toBe(999999)
    expect(tracker.exceeded()).toBe(false)
  })

  it("works after exceeded tracker", () => {
    const tracker = new CostTracker(2)
    tracker.add(5)
    expect(tracker.exceeded()).toBe(true)
    expect(tracker.remaining()).toBe(0)

    tracker.reset()

    expect(tracker.total()).toBe(0)
    expect(tracker.remaining()).toBe(2)
    expect(tracker.exceeded()).toBe(false)
    expect(tracker.runCount()).toBe(0)
  })
})
