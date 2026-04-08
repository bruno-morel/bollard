import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import { CostTracker, BollardError } from "@bollard/engine"

describe("Feature: CostTracker has a subtract(usd: number) method that reduces the total cost", () => {
  it("should reduce total cost by given amount", () => {
    const tracker = new CostTracker(100)
    tracker.add(50)
    tracker.subtract(20)
    expect(tracker.total()).toBe(30)
  })

  it("should handle zero as valid input", () => {
    const tracker = new CostTracker(100)
    tracker.add(50)
    tracker.subtract(0)
    expect(tracker.total()).toBe(50)
  })

  it("should handle subtracting entire balance", () => {
    const tracker = new CostTracker(100)
    tracker.add(25)
    tracker.subtract(25)
    expect(tracker.total()).toBe(0)
  })
})

describe("Feature: subtract throws BollardError with CONTRACT_VIOLATION code when given negative input", () => {
  it("should throw on negative input", () => {
    const tracker = new CostTracker(100)
    tracker.add(50)
    
    expect(() => tracker.subtract(-1)).toThrow()
    const error = (() => {
      try {
        tracker.subtract(-1)
      } catch (e) {
        return e
      }
    })()
    
    expect(BollardError.hasCode(error, "CONTRACT_VIOLATION")).toBe(true)
  })

  it("should throw on large negative values", () => {
    const tracker = new CostTracker(100)
    tracker.add(50)
    
    expect(() => tracker.subtract(-100)).toThrow()
    const error = (() => {
      try {
        tracker.subtract(-100)
      } catch (e) {
        return e
      }
    })()
    
    expect(BollardError.hasCode(error, "CONTRACT_VIOLATION")).toBe(true)
  })
})

describe("Feature: subtract throws BollardError with CONTRACT_VIOLATION code when result would go below zero", () => {
  it("should throw when subtracting more than current total", () => {
    const tracker = new CostTracker(100)
    tracker.add(30)
    
    expect(() => tracker.subtract(31)).toThrow()
    const error = (() => {
      try {
        tracker.subtract(31)
      } catch (e) {
        return e
      }
    })()
    
    expect(BollardError.hasCode(error, "CONTRACT_VIOLATION")).toBe(true)
  })

  it("should throw when subtracting from zero balance", () => {
    const tracker = new CostTracker(100)
    
    expect(() => tracker.subtract(1)).toThrow()
    const error = (() => {
      try {
        tracker.subtract(1)
      } catch (e) {
        return e
      }
    })()
    
    expect(BollardError.hasCode(error, "CONTRACT_VIOLATION")).toBe(true)
  })

  it("should throw when subtracting large amount from small balance", () => {
    const tracker = new CostTracker(100)
    tracker.add(5)
    
    expect(() => tracker.subtract(100)).toThrow()
    const error = (() => {
      try {
        tracker.subtract(100)
      } catch (e) {
        return e
      }
    })()
    
    expect(BollardError.hasCode(error, "CONTRACT_VIOLATION")).toBe(true)
  })
})

describe("Feature: subtract rejects NaN and Infinity inputs", () => {
  it("should throw on NaN input", () => {
    const tracker = new CostTracker(100)
    tracker.add(50)
    
    expect(() => tracker.subtract(NaN)).toThrow()
    const error = (() => {
      try {
        tracker.subtract(NaN)
      } catch (e) {
        return e
      }
    })()
    
    expect(BollardError.hasCode(error, "CONTRACT_VIOLATION")).toBe(true)
  })

  it("should throw on Infinity input", () => {
    const tracker = new CostTracker(100)
    tracker.add(50)
    
    expect(() => tracker.subtract(Infinity)).toThrow()
    const error = (() => {
      try {
        tracker.subtract(Infinity)
      } catch (e) {
        return e
      }
    })()
    
    expect(BollardError.hasCode(error, "CONTRACT_VIOLATION")).toBe(true)
  })

  it("should throw on negative Infinity input", () => {
    const tracker = new CostTracker(100)
    tracker.add(50)
    
    expect(() => tracker.subtract(-Infinity)).toThrow()
    const error = (() => {
      try {
        tracker.subtract(-Infinity)
      } catch (e) {
        return e
      }
    })()
    
    expect(BollardError.hasCode(error, "CONTRACT_VIOLATION")).toBe(true)
  })
})

describe("Property-based tests for subtract method", () => {
  it("should maintain non-negative balance invariant", () => {
    fc.assert(fc.property(
      fc.float({ min: 0.01, max: 1000 }),
      fc.float({ min: 0.01, max: 1000 }),
      (initialAmount, subtractAmount) => {
        const tracker = new CostTracker(2000)
        tracker.add(initialAmount)
        
        if (subtractAmount <= initialAmount) {
          tracker.subtract(subtractAmount)
          expect(tracker.total()).toBeGreaterThanOrEqual(0)
          expect(tracker.total()).toBeCloseTo(initialAmount - subtractAmount, 10)
        } else {
          expect(() => tracker.subtract(subtractAmount)).toThrow()
        }
      }
    ))
  })

  it("should handle valid positive subtractions", () => {
    fc.assert(fc.property(
      fc.float({ min: 10, max: 1000 }),
      fc.float({ min: 0, max: 10 }),
      (initialAmount, subtractAmount) => {
        const tracker = new CostTracker(2000)
        tracker.add(initialAmount)
        
        const beforeTotal = tracker.total()
        tracker.subtract(subtractAmount)
        const afterTotal = tracker.total()
        
        expect(afterTotal).toBeCloseTo(beforeTotal - subtractAmount, 10)
        expect(afterTotal).toBeGreaterThanOrEqual(0)
      }
    ))
  })
})

describe("Edge cases and boundary values", () => {
  it("should handle very small positive values", () => {
    const tracker = new CostTracker(100)
    tracker.add(1)
    tracker.subtract(0.01)
    expect(tracker.total()).toBeCloseTo(0.99, 10)
  })

  it("should handle precision edge cases", () => {
    const tracker = new CostTracker(100)
    tracker.add(0.1)
    tracker.add(0.2)
    tracker.subtract(0.3)
    expect(tracker.total()).toBeCloseTo(0, 10)
  })

  it("should preserve state on failed operations", () => {
    const tracker = new CostTracker(100)
    tracker.add(50)
    const originalTotal = tracker.total()
    
    try {
      tracker.subtract(100)
    } catch (e) {
      // Expected to throw
    }
    
    expect(tracker.total()).toBe(originalTotal)
  })
})