import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import { CostTracker } from "../src/cost-tracker.js"

describe("Feature: CostTracker has a reset() method that returns the previous total as a number", () => {
  it("should return the previous total when reset is called", () => {
    const tracker = new CostTracker(10)
    tracker.add(5)
    const previousTotal = tracker.reset()
    expect(previousTotal).toBe(5)
  })

  it("should return 0 when reset is called on unused tracker", () => {
    const tracker = new CostTracker(10)
    const previousTotal = tracker.reset()
    expect(previousTotal).toBe(0)
  })

  it("should return exact previous total even when exceeded", () => {
    const tracker = new CostTracker(5)
    tracker.add(10)
    const previousTotal = tracker.reset()
    expect(previousTotal).toBe(10)
  })
})

describe("Feature: After calling reset(), total() returns 0", () => {
  it("should return 0 from total() after reset", () => {
    const tracker = new CostTracker(10)
    tracker.add(7)
    tracker.reset()
    expect(tracker.total()).toBe(0)
  })

  it("should return 0 from total() after multiple resets", () => {
    const tracker = new CostTracker(10)
    tracker.add(3)
    tracker.reset()
    tracker.add(5)
    tracker.reset()
    expect(tracker.total()).toBe(0)
  })
})

describe("Feature: After calling reset(), remaining() returns the original limit", () => {
  it("should return original limit from remaining() after reset", () => {
    const tracker = new CostTracker(15)
    tracker.add(8)
    tracker.reset()
    expect(tracker.remaining()).toBe(15)
  })

  it("should return original limit even after exceeding and resetting", () => {
    const tracker = new CostTracker(5)
    tracker.add(12)
    tracker.reset()
    expect(tracker.remaining()).toBe(5)
  })
})

describe("Feature: After calling reset(), exceeded() returns false (unless limit is 0)", () => {
  it("should return false from exceeded() after reset with positive limit", () => {
    const tracker = new CostTracker(10)
    tracker.add(15)
    expect(tracker.exceeded()).toBe(true)
    tracker.reset()
    expect(tracker.exceeded()).toBe(false)
  })

  it("should return true from exceeded() after reset with zero limit", () => {
    const tracker = new CostTracker(0)
    tracker.add(1)
    tracker.reset()
    expect(tracker.exceeded()).toBe(true)
  })

  it("should return false from exceeded() after reset with zero limit and no usage", () => {
    const tracker = new CostTracker(0)
    tracker.reset()
    expect(tracker.exceeded()).toBe(false)
  })
})

describe("Feature: reset() method behavior including edge cases", () => {
  it("should handle multiple consecutive resets", () => {
    const tracker = new CostTracker(10)
    tracker.add(5)
    
    const first = tracker.reset()
    expect(first).toBe(5)
    expect(tracker.total()).toBe(0)
    
    const second = tracker.reset()
    expect(second).toBe(0)
    expect(tracker.total()).toBe(0)
  })

  it("should work correctly with fractional costs", () => {
    const tracker = new CostTracker(10.5)
    tracker.add(3.25)
    tracker.add(1.75)
    
    const previousTotal = tracker.reset()
    expect(previousTotal).toBe(5)
    expect(tracker.total()).toBe(0)
    expect(tracker.remaining()).toBe(10.5)
  })

  it("should preserve limit value across resets", () => {
    const tracker = new CostTracker(7.5)
    tracker.add(2)
    tracker.reset()
    tracker.add(1)
    tracker.reset()
    
    expect(tracker.remaining()).toBe(7.5)
  })

  it("property: reset always returns non-negative number", () => {
    fc.assert(fc.property(
      fc.float({ min: 0, max: 1000 }),
      fc.array(fc.float({ min: 0, max: 100 }), { maxLength: 10 }),
      (limit, costs) => {
        const tracker = new CostTracker(limit)
        costs.forEach(cost => tracker.add(cost))
        const previousTotal = tracker.reset()
        expect(previousTotal).toBeGreaterThanOrEqual(0)
      }
    ))
  })

  it("property: total is always 0 after reset", () => {
    fc.assert(fc.property(
      fc.float({ min: 0, max: 1000 }),
      fc.array(fc.float({ min: 0, max: 100 }), { maxLength: 10 }),
      (limit, costs) => {
        const tracker = new CostTracker(limit)
        costs.forEach(cost => tracker.add(cost))
        tracker.reset()
        expect(tracker.total()).toBe(0)
      }
    ))
  })

  it("property: remaining equals limit after reset", () => {
    fc.assert(fc.property(
      fc.float({ min: 0, max: 1000 }),
      fc.array(fc.float({ min: 0, max: 100 }), { maxLength: 10 }),
      (limit, costs) => {
        const tracker = new CostTracker(limit)
        costs.forEach(cost => tracker.add(cost))
        tracker.reset()
        expect(tracker.remaining()).toBe(limit)
      }
    ))
  })
}