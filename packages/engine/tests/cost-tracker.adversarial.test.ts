import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import { CostTracker } from "../src/cost-tracker.js"
import { BollardError } from "../src/errors.js"

describe("Feature: CostTracker constructor", () => {
  it("should accept positive limit", () => {
    const tracker = new CostTracker(100)
    expect(tracker.total()).toBe(0)
    expect(tracker.remaining()).toBe(100)
    expect(tracker.exceeded()).toBe(false)
  })

  it("should accept zero limit", () => {
    const tracker = new CostTracker(0)
    expect(tracker.total()).toBe(0)
    expect(tracker.remaining()).toBe(0)
    expect(tracker.exceeded()).toBe(false)
  })

  it("should handle very large limits", () => {
    const tracker = new CostTracker(Number.MAX_SAFE_INTEGER)
    expect(tracker.remaining()).toBe(Number.MAX_SAFE_INTEGER)
  })

  it("should handle very small positive limits", () => {
    const tracker = new CostTracker(Number.MIN_VALUE)
    expect(tracker.remaining()).toBe(Number.MIN_VALUE)
  })

  it("should reject negative limits", () => {
    expect(() => new CostTracker(-1)).toThrow()
    expect(() => new CostTracker(-100)).toThrow()
  })

  it("should reject NaN limit", () => {
    expect(() => new CostTracker(NaN)).toThrow()
  })

  it("should reject infinite limit", () => {
    expect(() => new CostTracker(Infinity)).toThrow()
    expect(() => new CostTracker(-Infinity)).toThrow()
  })
})

describe("Feature: CostTracker add method", () => {
  it("should accumulate positive costs", () => {
    const tracker = new CostTracker(100)
    tracker.add(25)
    expect(tracker.total()).toBe(25)
    tracker.add(30)
    expect(tracker.total()).toBe(55)
  })

  it("should handle zero cost additions", () => {
    const tracker = new CostTracker(100)
    tracker.add(0)
    expect(tracker.total()).toBe(0)
    expect(tracker.remaining()).toBe(100)
  })

  it("should handle very small positive costs", () => {
    const tracker = new CostTracker(1)
    tracker.add(Number.MIN_VALUE)
    expect(tracker.total()).toBe(Number.MIN_VALUE)
  })

  it("should reject negative costs", () => {
    const tracker = new CostTracker(100)
    expect(() => tracker.add(-1)).toThrow()
    expect(() => tracker.add(-0.01)).toThrow()
  })

  it("should reject NaN costs", () => {
    const tracker = new CostTracker(100)
    expect(() => tracker.add(NaN)).toThrow()
  })

  it("should reject infinite costs", () => {
    const tracker = new CostTracker(100)
    expect(() => tracker.add(Infinity)).toThrow()
    expect(() => tracker.add(-Infinity)).toThrow()
  })
})

describe("Feature: CostTracker total method", () => {
  it("should return exact sum of all added costs", () => {
    const tracker = new CostTracker(1000)
    const costs = [12.34, 56.78, 90.12]
    costs.forEach(cost => tracker.add(cost))
    expect(tracker.total()).toBe(costs.reduce((sum, cost) => sum + cost, 0))
  })

  it("should maintain precision with decimal costs", () => {
    const tracker = new CostTracker(10)
    tracker.add(0.1)
    tracker.add(0.2)
    expect(tracker.total()).toBeCloseTo(0.3, 10)
  })

  it("should handle many small additions", () => {
    const tracker = new CostTracker(1000)
    for (let i = 0; i < 100; i++) {
      tracker.add(0.01)
    }
    expect(tracker.total()).toBeCloseTo(1.0, 10)
  })
})

describe("Feature: CostTracker exceeded method", () => {
  it("should return false when under limit", () => {
    const tracker = new CostTracker(100)
    tracker.add(50)
    expect(tracker.exceeded()).toBe(false)
  })

  it("should return false when exactly at limit", () => {
    const tracker = new CostTracker(100)
    tracker.add(100)
    expect(tracker.exceeded()).toBe(false)
  })

  it("should return true when over limit", () => {
    const tracker = new CostTracker(100)
    tracker.add(100.01)
    expect(tracker.exceeded()).toBe(true)
  })

  it("should return true after multiple additions exceed limit", () => {
    const tracker = new CostTracker(100)
    tracker.add(60)
    expect(tracker.exceeded()).toBe(false)
    tracker.add(50)
    expect(tracker.exceeded()).toBe(true)
  })

  it("should handle zero limit correctly", () => {
    const tracker = new CostTracker(0)
    expect(tracker.exceeded()).toBe(false)
    tracker.add(0.01)
    expect(tracker.exceeded()).toBe(true)
  })
})

describe("Feature: CostTracker remaining method", () => {
  it("should return limit minus total when under limit", () => {
    const tracker = new CostTracker(100)
    tracker.add(30)
    expect(tracker.remaining()).toBe(70)
  })

  it("should return zero when exactly at limit", () => {
    const tracker = new CostTracker(100)
    tracker.add(100)
    expect(tracker.remaining()).toBe(0)
  })

  it("should return negative when over limit", () => {
    const tracker = new CostTracker(100)
    tracker.add(120)
    expect(tracker.remaining()).toBe(-20)
  })

  it("should maintain precision with decimal calculations", () => {
    const tracker = new CostTracker(1.0)
    tracker.add(0.3)
    expect(tracker.remaining()).toBeCloseTo(0.7, 10)
  })
})

describe("Property-based tests: CostTracker invariants", () => {
  it("total + remaining should always equal limit", () => {
    fc.assert(fc.property(
      fc.float({ min: 0.01, max: 1000 }),
      fc.array(fc.float({ min: 0, max: 100 }), { minLength: 0, maxLength: 10 }),
      (limit, costs) => {
        const tracker = new CostTracker(limit)
        costs.forEach(cost => tracker.add(cost))
        expect(tracker.total() + tracker.remaining()).toBeCloseTo(limit, 10)
      }
    ))
  })

  it("exceeded should be true iff total > limit", () => {
    fc.assert(fc.property(
      fc.float({ min: 0.01, max: 1000 }),
      fc.array(fc.float({ min: 0, max: 100 }), { minLength: 0, maxLength: 10 }),
      (limit, costs) => {
        const tracker = new CostTracker(limit)
        costs.forEach(cost => tracker.add(cost))
        expect(tracker.exceeded()).toBe(tracker.total() > limit)
      }
    ))
  })

  it("total should be monotonically increasing", () => {
    fc.assert(fc.property(
      fc.float({ min: 1, max: 1000 }),
      fc.array(fc.float({ min: 0.01, max: 10 }), { minLength: 1, maxLength: 10 }),
      (limit, costs) => {
        const tracker = new CostTracker(limit)
        let previousTotal = 0
        costs.forEach(cost => {
          tracker.add(cost)
          expect(tracker.total()).toBeGreaterThanOrEqual(previousTotal)
          previousTotal = tracker.total()
        })
      }
    ))
  })

  it("remaining should be monotonically decreasing", () => {
    fc.assert(fc.property(
      fc.float({ min: 1, max: 1000 }),
      fc.array(fc.float({ min: 0.01, max: 10 }), { minLength: 1, maxLength: 10 }),
      (limit, costs) => {
        const tracker = new CostTracker(limit)
        let previousRemaining = limit
        costs.forEach(cost => {
          tracker.add(cost)
          expect(tracker.remaining()).toBeLessThanOrEqual(previousRemaining)
          previousRemaining = tracker.remaining()
        })
      }
    ))
  })
})

describe("Edge cases and boundary conditions", () => {
  it("should handle floating point precision edge cases", () => {
    const tracker = new CostTracker(0.1)
    tracker.add(0.1)
    expect(tracker.exceeded()).toBe(false)
    expect(tracker.remaining()).toBeCloseTo(0, 10)
  })

  it("should handle very large cost accumulation", () => {
    const tracker = new CostTracker(Number.MAX_SAFE_INTEGER)
    tracker.add(Number.MAX_SAFE_INTEGER - 1)
    expect(tracker.total()).toBe(Number.MAX_SAFE_INTEGER - 1)
    expect(tracker.remaining()).toBe(1)
  })

  it("should handle many tiny additions", () => {
    const tracker = new CostTracker(1)
    for (let i = 0; i < 1000; i++) {
      tracker.add(0.0001)
    }
    expect(tracker.total()).toBeCloseTo(0.1, 5)
    expect(tracker.exceeded()).toBe(false)
  })
})