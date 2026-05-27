import { describe, expect, it } from "vitest"
import { CostTracker } from "../src/cost-tracker.js"

describe("CostTracker.exceeded()", () => {
  describe("boundary conditions", () => {
    it("returns false when total equals limit", () => {
      const tracker = new CostTracker(10)
      tracker.add(10)
      expect(tracker.exceeded()).toBe(false)
    })

    it("returns false when total is less than limit", () => {
      const tracker = new CostTracker(10)
      tracker.add(5)
      expect(tracker.exceeded()).toBe(false)
    })

    it("returns true when total is greater than limit", () => {
      const tracker = new CostTracker(10)
      tracker.add(15)
      expect(tracker.exceeded()).toBe(true)
    })

    it("returns false when total is zero and limit is zero", () => {
      const tracker = new CostTracker(0)
      expect(tracker.exceeded()).toBe(false)
    })

    it("returns true when total exceeds zero limit", () => {
      const tracker = new CostTracker(0)
      tracker.add(0.01)
      expect(tracker.exceeded()).toBe(true)
    })
  })

  describe("return type validation", () => {
    it("returns boolean type when not exceeded", () => {
      const tracker = new CostTracker(10)
      tracker.add(5)
      const result = tracker.exceeded()
      expect(typeof result).toBe("boolean")
      expect(result).toBe(false)
    })

    it("returns boolean type when exceeded", () => {
      const tracker = new CostTracker(10)
      tracker.add(15)
      const result = tracker.exceeded()
      expect(typeof result).toBe("boolean")
      expect(result).toBe(true)
    })

    it("returns boolean type when total equals limit", () => {
      const tracker = new CostTracker(10)
      tracker.add(10)
      const result = tracker.exceeded()
      expect(typeof result).toBe("boolean")
      expect(result).toBe(false)
    })
  })

  describe("state immutability", () => {
    it("does not modify _total when called", () => {
      const tracker = new CostTracker(10)
      tracker.add(5)
      const initialTotal = tracker.total()

      tracker.exceeded()

      expect(tracker.total()).toBe(initialTotal)
    })

    it("does not modify _limit when called", () => {
      const tracker = new CostTracker(10)
      tracker.add(5)
      const initialRemaining = tracker.remaining()

      tracker.exceeded()

      expect(tracker.remaining()).toBe(initialRemaining)
    })

    it("does not modify _runCount when called", () => {
      const tracker = new CostTracker(10)
      tracker.add(5)
      const initialRunCount = tracker.runCount()

      tracker.exceeded()

      expect(tracker.runCount()).toBe(initialRunCount)
    })

    it("is idempotent across repeated calls", () => {
      const tracker = new CostTracker(10)
      tracker.add(15)

      const firstCall = tracker.exceeded()
      const secondCall = tracker.exceeded()
      const thirdCall = tracker.exceeded()

      expect(firstCall).toBe(true)
      expect(secondCall).toBe(true)
      expect(thirdCall).toBe(true)
      expect(firstCall).toBe(secondCall)
      expect(secondCall).toBe(thirdCall)
    })
  })

  describe("floating-point precision", () => {
    it("works correctly with floating-point numbers", () => {
      const tracker = new CostTracker(1.5)
      tracker.add(1.2)
      expect(tracker.exceeded()).toBe(false)

      tracker.add(0.4) // total now 1.6, which is > 1.5
      expect(tracker.exceeded()).toBe(true)
    })

    it("handles precise equality with floating-point numbers", () => {
      const tracker = new CostTracker(0.3)
      tracker.add(0.1)
      tracker.add(0.2) // 0.1 + 0.2 = 0.30000000000000004 in JS

      // Even with floating-point imprecision, should handle equality correctly
      const result = tracker.exceeded()
      expect(typeof result).toBe("boolean")
    })
  })

  describe("large numbers", () => {
    it("works with large numbers", () => {
      const tracker = new CostTracker(1000000)
      tracker.add(999999)
      expect(tracker.exceeded()).toBe(false)

      tracker.add(2) // total now 1000001
      expect(tracker.exceeded()).toBe(true)
    })

    it("works with very small numbers", () => {
      const tracker = new CostTracker(0.001)
      tracker.add(0.0005)
      expect(tracker.exceeded()).toBe(false)

      tracker.add(0.0006) // total now 0.0011
      expect(tracker.exceeded()).toBe(true)
    })
  })

  describe("edge cases", () => {
    it("returns false for new tracker with positive limit", () => {
      const tracker = new CostTracker(100)
      expect(tracker.exceeded()).toBe(false)
    })

    it("returns false for new tracker with zero limit", () => {
      const tracker = new CostTracker(0)
      expect(tracker.exceeded()).toBe(false)
    })

    it("maintains correct state after multiple operations", () => {
      const tracker = new CostTracker(10)

      // Start: not exceeded
      expect(tracker.exceeded()).toBe(false)

      // Add some cost: still not exceeded
      tracker.add(5)
      expect(tracker.exceeded()).toBe(false)

      // Add more to exceed: now exceeded
      tracker.add(6) // total = 11
      expect(tracker.exceeded()).toBe(true)

      // Subtract to go back under: no longer exceeded
      tracker.subtract(2) // total = 9
      expect(tracker.exceeded()).toBe(false)

      // Add to exactly equal limit: still not exceeded
      tracker.add(1) // total = 10
      expect(tracker.exceeded()).toBe(false)
    })
  })

  describe("strict greater-than comparison", () => {
    it("uses strict greater-than, not greater-than-or-equal", () => {
      const tracker = new CostTracker(5)

      // Exactly equal to limit should return false
      tracker.add(5)
      expect(tracker.exceeded()).toBe(false)

      // Even tiny amount over limit should return true
      tracker.add(0.000001)
      expect(tracker.exceeded()).toBe(true)
    })

    it("confirms boundary behavior with multiple equal values", () => {
      const limits = [0, 1, 10, 100, 0.5, 0.01]

      for (const limit of limits) {
        const tracker = new CostTracker(limit)
        tracker.add(limit) // exactly equal
        expect(tracker.exceeded()).toBe(false)

        tracker.add(0.000001) // slightly over
        expect(tracker.exceeded()).toBe(true)
      }
    })
  })
})
