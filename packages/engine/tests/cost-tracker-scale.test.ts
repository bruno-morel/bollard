import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { CostTracker } from "../src/cost-tracker.js"
import { BollardError } from "../src/errors.js"

describe("CostTracker.scale()", () => {
  describe("valid scaling", () => {
    it("should scale total by positive factor", () => {
      const tracker = new CostTracker(100)
      tracker.add(10)
      tracker.scale(2)
      expect(tracker.total()).toBe(20)
    })

    it("should scale by factor of 1 (no change)", () => {
      const tracker = new CostTracker(100)
      tracker.add(15)
      tracker.scale(1)
      expect(tracker.total()).toBe(15)
    })

    it("should scale by fractional factor", () => {
      const tracker = new CostTracker(100)
      tracker.add(20)
      tracker.scale(0.5)
      expect(tracker.total()).toBe(10)
    })

    it("should scale zero total", () => {
      const tracker = new CostTracker(100)
      tracker.scale(5)
      expect(tracker.total()).toBe(0)
    })

    it("should handle very small positive factors", () => {
      const tracker = new CostTracker(100)
      tracker.add(10)
      tracker.scale(0.001)
      expect(tracker.total()).toBe(0.01)
    })

    it("should handle very large factors", () => {
      const tracker = new CostTracker(1000000)
      tracker.add(1)
      tracker.scale(1000)
      expect(tracker.total()).toBe(1000)
    })
  })

  describe("factor validation", () => {
    it("should throw CONTRACT_VIOLATION for zero factor", () => {
      const tracker = new CostTracker(100)
      tracker.add(10)
      expect(() => tracker.scale(0)).toThrow(BollardError)
      try {
        tracker.scale(0)
      } catch (error) {
        expect(BollardError.hasCode(error, "CONTRACT_VIOLATION")).toBe(true)
        expect((error as BollardError).context).toEqual({ factor: 0 })
      }
    })

    it("should throw CONTRACT_VIOLATION for negative factor", () => {
      const tracker = new CostTracker(100)
      tracker.add(10)
      expect(() => tracker.scale(-1)).toThrow(BollardError)
      try {
        tracker.scale(-1)
      } catch (error) {
        expect(BollardError.hasCode(error, "CONTRACT_VIOLATION")).toBe(true)
        expect((error as BollardError).context).toEqual({ factor: -1 })
      }
    })

    it("should throw CONTRACT_VIOLATION for Infinity factor", () => {
      const tracker = new CostTracker(100)
      tracker.add(10)
      expect(() => tracker.scale(Number.POSITIVE_INFINITY)).toThrow(BollardError)
      try {
        tracker.scale(Number.POSITIVE_INFINITY)
      } catch (error) {
        expect(BollardError.hasCode(error, "CONTRACT_VIOLATION")).toBe(true)
        expect((error as BollardError).context).toEqual({ factor: Number.POSITIVE_INFINITY })
      }
    })

    it("should throw CONTRACT_VIOLATION for NaN factor", () => {
      const tracker = new CostTracker(100)
      tracker.add(10)
      expect(() => tracker.scale(Number.NaN)).toThrow(BollardError)
      try {
        tracker.scale(Number.NaN)
      } catch (error) {
        expect(BollardError.hasCode(error, "CONTRACT_VIOLATION")).toBe(true)
        expect((error as BollardError).context.factor).toBeNaN()
      }
    })
  })

  describe("clampMax parameter", () => {
    it("should cap result at clampMax when result exceeds it", () => {
      const tracker = new CostTracker(100)
      tracker.add(10)
      tracker.scale(5, 30)
      expect(tracker.total()).toBe(30)
    })

    it("should not cap result when result is below clampMax", () => {
      const tracker = new CostTracker(100)
      tracker.add(10)
      tracker.scale(2, 30)
      expect(tracker.total()).toBe(20)
    })

    it("should handle clampMax of zero", () => {
      const tracker = new CostTracker(100)
      tracker.add(10)
      tracker.scale(2, 0)
      expect(tracker.total()).toBe(0)
    })

    it("should work when scaled result equals clampMax", () => {
      const tracker = new CostTracker(100)
      tracker.add(10)
      tracker.scale(2, 20)
      expect(tracker.total()).toBe(20)
    })

    it("should throw CONTRACT_VIOLATION for negative clampMax", () => {
      const tracker = new CostTracker(100)
      tracker.add(10)
      expect(() => tracker.scale(2, -1)).toThrow(BollardError)
      try {
        tracker.scale(2, -1)
      } catch (error) {
        expect(BollardError.hasCode(error, "CONTRACT_VIOLATION")).toBe(true)
        expect((error as BollardError).context).toEqual({ clampMax: -1 })
      }
    })

    it("should throw CONTRACT_VIOLATION for Infinity clampMax", () => {
      const tracker = new CostTracker(100)
      tracker.add(10)
      expect(() => tracker.scale(2, Number.POSITIVE_INFINITY)).toThrow(BollardError)
      try {
        tracker.scale(2, Number.POSITIVE_INFINITY)
      } catch (error) {
        expect(BollardError.hasCode(error, "CONTRACT_VIOLATION")).toBe(true)
        expect((error as BollardError).context).toEqual({ clampMax: Number.POSITIVE_INFINITY })
      }
    })

    it("should throw CONTRACT_VIOLATION for NaN clampMax", () => {
      const tracker = new CostTracker(100)
      tracker.add(10)
      expect(() => tracker.scale(2, Number.NaN)).toThrow(BollardError)
      try {
        tracker.scale(2, Number.NaN)
      } catch (error) {
        expect(BollardError.hasCode(error, "CONTRACT_VIOLATION")).toBe(true)
        expect((error as BollardError).context.clampMax).toBeNaN()
      }
    })
  })

  describe("method chaining", () => {
    it("should return this for chaining", () => {
      const tracker = new CostTracker(100)
      tracker.add(10)
      const result = tracker.scale(2)
      expect(result).toBe(tracker)
    })

    it("should support chaining with other methods", () => {
      const tracker = new CostTracker(100)
      tracker.add(10)
      tracker.scale(2).scale(0.5)
      expect(tracker.total()).toBe(10)
    })

    it("should work in complex chains", () => {
      const tracker = new CostTracker(100)
      tracker.add(10).scale(2).cap(15)
      expect(tracker.total()).toBe(15)
    })
  })

  describe("property-based tests", () => {
    it("scaling positive total with positive factor yields non-negative result", () => {
      fc.assert(
        fc.property(
          fc.float({ min: Math.fround(0.01), max: Math.fround(1000), noNaN: true }),
          fc.float({ min: Math.fround(0.01), max: Math.fround(10), noNaN: true }),
          (initialTotal, factor) => {
            const tracker = new CostTracker(10000)
            tracker.add(initialTotal)
            tracker.scale(factor)
            expect(tracker.total()).toBeGreaterThanOrEqual(0)
            expect(tracker.total()).toBeCloseTo(initialTotal * factor, 10)
          },
        ),
      )
    })

    it("result is always ≤ clampMax when clampMax provided", () => {
      fc.assert(
        fc.property(
          fc.float({ min: Math.fround(0.01), max: Math.fround(1000), noNaN: true }),
          fc.float({ min: Math.fround(0.01), max: Math.fround(10), noNaN: true }),
          fc.float({ min: Math.fround(0.01), max: Math.fround(5000), noNaN: true }),
          (initialTotal, factor, clampMax) => {
            const tracker = new CostTracker(10000)
            tracker.add(initialTotal)
            tracker.scale(factor, clampMax)
            expect(tracker.total()).toBeLessThanOrEqual(clampMax)
          },
        ),
      )
    })

    it("chained scale(a).scale(b) equals scale(a*b)", () => {
      fc.assert(
        fc.property(
          fc.float({ min: Math.fround(0.01), max: Math.fround(100), noNaN: true }),
          fc.float({ min: Math.fround(0.01), max: Math.fround(5), noNaN: true }),
          fc.float({ min: Math.fround(0.01), max: Math.fround(5), noNaN: true }),
          (initialTotal, factorA, factorB) => {
            const tracker1 = new CostTracker(10000)
            tracker1.add(initialTotal)
            const tracker2 = new CostTracker(10000)
            tracker2.add(initialTotal)
            tracker1.scale(factorA).scale(factorB)
            tracker2.scale(factorA * factorB)
            expect(tracker1.total()).toBeCloseTo(tracker2.total(), 10)
          },
        ),
      )
    })
  })
})
