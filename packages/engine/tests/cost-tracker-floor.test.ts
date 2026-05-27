import { describe, expect, it } from "vitest"
import { CostTracker } from "../src/cost-tracker.js"
import { BollardError } from "../src/errors.js"

describe("CostTracker.floor", () => {
  describe("default behavior (2 decimal places)", () => {
    it("truncates to 2 decimal places by default", () => {
      const tracker = new CostTracker(100)
      tracker.add(1.234)
      tracker.floor()
      expect(tracker.total()).toBe(1.23)
    })

    it("truncates down using Math.floor semantics", () => {
      const tracker = new CostTracker(100)
      tracker.add(1.999)
      tracker.floor()
      expect(tracker.total()).toBe(1.99)
    })

    it("handles zero total", () => {
      const tracker = new CostTracker(100)
      tracker.floor()
      expect(tracker.total()).toBe(0)
    })

    it("handles already rounded values", () => {
      const tracker = new CostTracker(100)
      tracker.add(1.23)
      tracker.floor()
      expect(tracker.total()).toBe(1.23)
    })
  })

  describe("custom decimal places", () => {
    it("truncates to 0 decimal places", () => {
      const tracker = new CostTracker(100)
      tracker.add(1.999)
      tracker.floor(0)
      expect(tracker.total()).toBe(1)
    })

    it("truncates to 1 decimal place", () => {
      const tracker = new CostTracker(100)
      tracker.add(1.999)
      tracker.floor(1)
      expect(tracker.total()).toBe(1.9)
    })

    it("truncates to 3 decimal places", () => {
      const tracker = new CostTracker(100)
      tracker.add(1.23456)
      tracker.floor(3)
      expect(tracker.total()).toBe(1.234)
    })

    it("truncates to 4 decimal places", () => {
      const tracker = new CostTracker(100)
      tracker.add(1.23456789)
      tracker.floor(4)
      expect(tracker.total()).toBe(1.2345)
    })

    it("handles 5 decimal places", () => {
      const tracker = new CostTracker(100)
      tracker.add(1.123456789)
      tracker.floor(5)
      expect(tracker.total()).toBe(1.12345)
    })
  })

  describe("validation errors", () => {
    it("throws CONTRACT_VIOLATION for negative decimalPlaces", () => {
      const tracker = new CostTracker(100)
      tracker.add(1.234)

      expect(() => tracker.floor(-1)).toThrow(BollardError)
      expect(() => tracker.floor(-1)).toThrow("decimalPlaces must be a non-negative integer")

      try {
        tracker.floor(-1)
      } catch (error) {
        expect(error).toBeInstanceOf(BollardError)
        expect((error as BollardError).code).toBe("CONTRACT_VIOLATION")
        expect((error as BollardError).context).toEqual({ decimalPlaces: -1 })
      }
    })

    it("throws CONTRACT_VIOLATION for non-integer decimalPlaces", () => {
      const tracker = new CostTracker(100)
      tracker.add(1.234)

      expect(() => tracker.floor(1.5)).toThrow(BollardError)
      expect(() => tracker.floor(1.5)).toThrow("decimalPlaces must be a non-negative integer")

      try {
        tracker.floor(1.5)
      } catch (error) {
        expect(error).toBeInstanceOf(BollardError)
        expect((error as BollardError).code).toBe("CONTRACT_VIOLATION")
        expect((error as BollardError).context).toEqual({ decimalPlaces: 1.5 })
      }
    })

    it("throws CONTRACT_VIOLATION for Infinity", () => {
      const tracker = new CostTracker(100)
      tracker.add(1.234)

      expect(() => tracker.floor(Number.POSITIVE_INFINITY)).toThrow(BollardError)
      expect(() => tracker.floor(Number.POSITIVE_INFINITY)).toThrow(
        "decimalPlaces must be a non-negative integer",
      )

      try {
        tracker.floor(Number.POSITIVE_INFINITY)
      } catch (error) {
        expect(error).toBeInstanceOf(BollardError)
        expect((error as BollardError).code).toBe("CONTRACT_VIOLATION")
        expect((error as BollardError).context).toEqual({ decimalPlaces: Number.POSITIVE_INFINITY })
      }
    })

    it("throws CONTRACT_VIOLATION for NaN", () => {
      const tracker = new CostTracker(100)
      tracker.add(1.234)

      expect(() => tracker.floor(Number.NaN)).toThrow(BollardError)
      expect(() => tracker.floor(Number.NaN)).toThrow(
        "decimalPlaces must be a non-negative integer",
      )

      try {
        tracker.floor(Number.NaN)
      } catch (error) {
        expect(error).toBeInstanceOf(BollardError)
        expect((error as BollardError).code).toBe("CONTRACT_VIOLATION")
        expect((error as BollardError).context).toEqual({ decimalPlaces: Number.NaN })
      }
    })
  })

  describe("method chaining", () => {
    it("returns this for method chaining", () => {
      const tracker = new CostTracker(100)
      tracker.add(1.234)
      const result = tracker.floor()
      expect(result).toBe(tracker)
    })

    it("can be chained with other methods", () => {
      const tracker = new CostTracker(100)
      tracker.add(1.999).floor(1).add(0.1)
      expect(tracker.total()).toBe(2.0) // 1.999 -> 1.9 -> 2.0
    })

    it("can be chained multiple times", () => {
      const tracker = new CostTracker(100)
      tracker.add(1.23456).floor(3).floor(1)
      expect(tracker.total()).toBe(1.2) // 1.23456 -> 1.234 -> 1.2
    })
  })

  describe("edge cases", () => {
    it("handles very small decimals", () => {
      const tracker = new CostTracker(100)
      tracker.add(0.00123)
      tracker.floor(3)
      expect(tracker.total()).toBe(0.001)
    })

    it("handles very small decimals with default places", () => {
      const tracker = new CostTracker(100)
      tracker.add(0.00999)
      tracker.floor()
      expect(tracker.total()).toBe(0.0)
    })

    it("handles large numbers", () => {
      const tracker = new CostTracker(10000)
      tracker.add(1234.56789)
      tracker.floor(2)
      expect(tracker.total()).toBe(1234.56)
    })

    it("handles numbers close to zero", () => {
      const tracker = new CostTracker(100)
      tracker.add(0.001)
      tracker.floor(2)
      expect(tracker.total()).toBe(0.0)
    })

    it("handles exact decimal boundaries", () => {
      const tracker = new CostTracker(100)
      tracker.add(1.5)
      tracker.floor(1)
      expect(tracker.total()).toBe(1.5)
    })
  })

  describe("idempotency", () => {
    it("is idempotent when called multiple times with same parameters", () => {
      const tracker = new CostTracker(100)
      tracker.add(1.23456)

      tracker.floor(2)
      const firstResult = tracker.total()

      tracker.floor(2)
      const secondResult = tracker.total()

      expect(firstResult).toBe(secondResult)
      expect(tracker.total()).toBe(1.23)
    })

    it("is idempotent with default parameters", () => {
      const tracker = new CostTracker(100)
      tracker.add(1.999)

      tracker.floor()
      const firstResult = tracker.total()

      tracker.floor()
      const secondResult = tracker.total()

      expect(firstResult).toBe(secondResult)
      expect(tracker.total()).toBe(1.99)
    })
  })

  describe("mutation in place", () => {
    it("mutates _total in place", () => {
      const tracker = new CostTracker(100)
      tracker.add(1.234)
      const originalTotal = tracker.total()

      tracker.floor(2)
      const newTotal = tracker.total()

      expect(newTotal).not.toBe(originalTotal)
      expect(newTotal).toBe(1.23)
    })

    it("does not create a new CostTracker instance", () => {
      const tracker = new CostTracker(100)
      tracker.add(1.234)
      const result = tracker.floor()

      expect(result).toBe(tracker)
      expect(result === tracker).toBe(true)
    })
  })
})
