import fc from "fast-check"
import { describe, expect, it, vi } from "vitest"
import type { PipelineContext } from "../src/context.js"
import { CostTracker } from "../src/cost-tracker.js"
import { BollardError } from "../src/errors.js"
import type { CostTracker as PublicCostTracker } from "../src/types.js"

describe("CostTracker", () => {
  it("starts with zero total", () => {
    const tracker = new CostTracker(10)
    expect(tracker.total()).toBe(0)
  })

  it("accumulates costs via add()", () => {
    const tracker = new CostTracker(10)
    tracker.add(1.5)
    tracker.add(2.5)
    expect(tracker.total()).toBe(4)
  })

  it("peek() returns current total without modifying state", () => {
    const tracker = new CostTracker(10)
    expect(tracker.peek()).toBe(0)

    tracker.add(3.5)
    expect(tracker.peek()).toBe(3.5)
    expect(tracker.total()).toBe(3.5) // verify peek didn't change anything

    tracker.add(1.5)
    expect(tracker.peek()).toBe(5)
    expect(tracker.total()).toBe(5)
  })

  it("peek() returns same value as total()", () => {
    const tracker = new CostTracker(10)
    expect(tracker.peek()).toBe(tracker.total())

    tracker.add(2.5)
    expect(tracker.peek()).toBe(tracker.total())

    tracker.subtract(1)
    expect(tracker.peek()).toBe(tracker.total())
  })

  it("reports remaining budget correctly", () => {
    const tracker = new CostTracker(5)
    tracker.add(2)
    expect(tracker.remaining()).toBe(3)
  })

  it("clamps remaining to 0 when over limit", () => {
    const tracker = new CostTracker(1)
    tracker.add(5)
    expect(tracker.remaining()).toBe(0)
  })

  it("reports exceeded when total surpasses limit", () => {
    const tracker = new CostTracker(1)
    expect(tracker.exceeded()).toBe(false)
    tracker.add(0.5)
    expect(tracker.exceeded()).toBe(false)
    tracker.add(0.6)
    expect(tracker.exceeded()).toBe(true)
  })

  it("does not report exceeded when total equals limit exactly", () => {
    const tracker = new CostTracker(1)
    tracker.add(1)
    expect(tracker.exceeded()).toBe(false)
  })

  it("handles zero limit", () => {
    const tracker = new CostTracker(0)
    expect(tracker.exceeded()).toBe(false)
    expect(tracker.remaining()).toBe(0)
    tracker.add(0.001)
    expect(tracker.exceeded()).toBe(true)
  })

  it("rejects negative cost with BollardError", () => {
    const tracker = new CostTracker(10)
    expect(() => tracker.add(-1)).toThrow(BollardError)
    try {
      tracker.add(-1)
    } catch (err) {
      expect(BollardError.hasCode(err, "CONTRACT_VIOLATION")).toBe(true)
    }
  })

  it("rejects NaN cost", () => {
    const tracker = new CostTracker(10)
    expect(() => tracker.add(Number.NaN)).toThrow(BollardError)
  })

  it("rejects Infinity cost", () => {
    const tracker = new CostTracker(10)
    expect(() => tracker.add(Number.POSITIVE_INFINITY)).toThrow(BollardError)
  })

  it("rejects negative limit", () => {
    expect(() => new CostTracker(-5)).toThrow(BollardError)
  })

  it("rejects NaN limit", () => {
    expect(() => new CostTracker(Number.NaN)).toThrow(BollardError)
  })

  it("rejects Infinity limit", () => {
    expect(() => new CostTracker(Number.POSITIVE_INFINITY)).toThrow(BollardError)
  })

  it("accepts adding zero cost", () => {
    const tracker = new CostTracker(10)
    tracker.add(0)
    expect(tracker.total()).toBe(0)
  })

  it("works without context parameter", () => {
    const tracker = new CostTracker(10)
    tracker.add(5)
    expect(tracker.total()).toBe(5)
  })

  it("calls debug log when context is provided", () => {
    const mockDebug = vi.fn()
    const mockCtx = {
      log: {
        debug: mockDebug,
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    } as Partial<PipelineContext> as PipelineContext

    const tracker = new CostTracker(10)
    tracker.add(5, mockCtx)

    expect(mockDebug).toHaveBeenCalledWith("cost:add")
    expect(tracker.total()).toBe(5)
  })

  it("handles context with undefined log", () => {
    const mockCtx = {} as Partial<PipelineContext> as PipelineContext

    const tracker = new CostTracker(10)
    expect(() => tracker.add(5, mockCtx)).not.toThrow()
    expect(tracker.total()).toBe(5)
  })

  it("handles context with log but undefined debug", () => {
    const mockCtx = {
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    } as Partial<PipelineContext> as PipelineContext

    const tracker = new CostTracker(10)
    expect(() => tracker.add(5, mockCtx)).not.toThrow()
    expect(tracker.total()).toBe(5)
  })

  describe("reset()", () => {
    it("returns previous total and zeros the accumulated cost", () => {
      const tracker = new CostTracker(10)
      tracker.add(3.5)
      tracker.add(1.5)

      const previousTotal = tracker.reset()

      expect(previousTotal).toBe(5)
      expect(tracker.total()).toBe(0)
    })

    it("returns 0 when resetting unused tracker", () => {
      const tracker = new CostTracker(10)

      const previousTotal = tracker.reset()

      expect(previousTotal).toBe(0)
      expect(tracker.total()).toBe(0)
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

    it("handles zero limit correctly after reset", () => {
      const tracker = new CostTracker(0)
      tracker.add(1)
      expect(tracker.exceeded()).toBe(true)

      const previousTotal = tracker.reset()

      expect(previousTotal).toBe(1)
      expect(tracker.total()).toBe(0)
      expect(tracker.remaining()).toBe(0)
      expect(tracker.exceeded()).toBe(false)
    })

    it("can be called multiple times safely", () => {
      const tracker = new CostTracker(10)
      tracker.add(5)

      const firstReset = tracker.reset()
      const secondReset = tracker.reset()
      const thirdReset = tracker.reset()

      expect(firstReset).toBe(5)
      expect(secondReset).toBe(0)
      expect(thirdReset).toBe(0)
      expect(tracker.total()).toBe(0)
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

      const secondReset = tracker.reset()
      expect(secondReset).toBe(3)
    })

    it("preserves limit when resetting exceeded tracker", () => {
      const tracker = new CostTracker(2)
      tracker.add(5)
      expect(tracker.exceeded()).toBe(true)
      expect(tracker.remaining()).toBe(0)

      const previousTotal = tracker.reset()

      expect(previousTotal).toBe(5)
      expect(tracker.total()).toBe(0)
      expect(tracker.remaining()).toBe(2)
      expect(tracker.exceeded()).toBe(false)
    })

    it("handles fractional costs correctly", () => {
      const tracker = new CostTracker(10)
      tracker.add(1.25)
      tracker.add(2.75)

      const previousTotal = tracker.reset()

      expect(previousTotal).toBe(4)
      expect(tracker.total()).toBe(0)
    })
  })

  describe("subtract()", () => {
    it("reduces total cost by the given amount", () => {
      const tracker = new CostTracker(10)
      tracker.add(5)
      tracker.subtract(2)
      expect(tracker.total()).toBe(3)
    })

    it("accepts zero as valid input", () => {
      const tracker = new CostTracker(10)
      tracker.add(5)
      tracker.subtract(0)
      expect(tracker.total()).toBe(5)
    })

    it("allows subtracting entire total to reach zero", () => {
      const tracker = new CostTracker(10)
      tracker.add(3.5)
      tracker.subtract(3.5)
      expect(tracker.total()).toBe(0)
    })

    it("throws BollardError with CONTRACT_VIOLATION for negative input", () => {
      const tracker = new CostTracker(10)
      tracker.add(5)

      expect(() => tracker.subtract(-1)).toThrow(BollardError)
      try {
        tracker.subtract(-1)
      } catch (err) {
        expect(BollardError.hasCode(err, "CONTRACT_VIOLATION")).toBe(true)
        expect(err).toHaveProperty(
          "message",
          "Amount must be a non-negative finite number, got: -1",
        )
      }
      // Verify total unchanged after error
      expect(tracker.total()).toBe(5)
    })

    it("throws BollardError with CONTRACT_VIOLATION when result would go below zero", () => {
      const tracker = new CostTracker(10)
      tracker.add(3)

      expect(() => tracker.subtract(4)).toThrow(BollardError)
      try {
        tracker.subtract(4)
      } catch (err) {
        expect(BollardError.hasCode(err, "CONTRACT_VIOLATION")).toBe(true)
        expect(err).toHaveProperty(
          "message",
          "Cannot subtract 4 from total 3: result would be negative",
        )
      }
      // Verify total unchanged after error
      expect(tracker.total()).toBe(3)
    })

    it("throws BollardError for NaN input", () => {
      const tracker = new CostTracker(10)
      tracker.add(5)

      expect(() => tracker.subtract(Number.NaN)).toThrow(BollardError)
      try {
        tracker.subtract(Number.NaN)
      } catch (err) {
        expect(BollardError.hasCode(err, "CONTRACT_VIOLATION")).toBe(true)
      }
      expect(tracker.total()).toBe(5)
    })

    it("throws BollardError for Infinity input", () => {
      const tracker = new CostTracker(10)
      tracker.add(5)

      expect(() => tracker.subtract(Number.POSITIVE_INFINITY)).toThrow(BollardError)
      try {
        tracker.subtract(Number.POSITIVE_INFINITY)
      } catch (err) {
        expect(BollardError.hasCode(err, "CONTRACT_VIOLATION")).toBe(true)
      }
      expect(tracker.total()).toBe(5)
    })

    it("throws BollardError for negative Infinity input", () => {
      const tracker = new CostTracker(10)
      tracker.add(5)

      expect(() => tracker.subtract(Number.NEGATIVE_INFINITY)).toThrow(BollardError)
      try {
        tracker.subtract(Number.NEGATIVE_INFINITY)
      } catch (err) {
        expect(BollardError.hasCode(err, "CONTRACT_VIOLATION")).toBe(true)
      }
      expect(tracker.total()).toBe(5)
    })

    it("handles fractional amounts correctly", () => {
      const tracker = new CostTracker(10)
      tracker.add(5.75)
      tracker.subtract(2.25)
      expect(tracker.total()).toBe(3.5)
    })

    it("updates remaining budget correctly", () => {
      const tracker = new CostTracker(10)
      tracker.add(7)
      expect(tracker.remaining()).toBe(3)

      tracker.subtract(2)
      expect(tracker.remaining()).toBe(5)
    })

    it("updates exceeded status correctly", () => {
      const tracker = new CostTracker(5)
      tracker.add(8)
      expect(tracker.exceeded()).toBe(true)

      tracker.subtract(4)
      expect(tracker.exceeded()).toBe(false)
      expect(tracker.total()).toBe(4)
    })

    it("works with chained operations", () => {
      const tracker = new CostTracker(10)
      tracker.add(6)
      tracker.subtract(2)
      tracker.add(1)
      tracker.subtract(0.5)

      expect(tracker.total()).toBe(4.5)
      expect(tracker.remaining()).toBe(5.5)
      expect(tracker.exceeded()).toBe(false)
    })

    it("handles precision correctly with small amounts", () => {
      const tracker = new CostTracker(1)
      tracker.add(0.1)
      tracker.add(0.2)
      tracker.subtract(0.15)

      // Use toBeCloseTo to handle floating point precision
      expect(tracker.total()).toBeCloseTo(0.15, 10)
    })
  })

  describe("divide()", () => {
    it("divides total cost by positive divisor", () => {
      const tracker = new CostTracker(10)
      tracker.add(8)
      tracker.divide(2)
      expect(tracker.total()).toBe(4)
    })

    it("returns this for method chaining", () => {
      const tracker = new CostTracker(10)
      tracker.add(6)
      const result = tracker.divide(2)
      expect(result).toBe(tracker)
      expect(tracker.total()).toBe(3)
    })

    it("handles fractional divisors correctly", () => {
      const tracker = new CostTracker(10)
      tracker.add(4)
      tracker.divide(0.5) // Should double the cost
      expect(tracker.total()).toBe(8)
    })

    it("works with method chaining", () => {
      const tracker = new CostTracker(20)
      const result = tracker.add(10).divide(2).total()
      expect(result).toBe(5)
    })

    it("preserves limit value", () => {
      const tracker = new CostTracker(10)
      tracker.add(8)
      tracker.divide(2)
      expect(tracker.remaining()).toBe(6) // limit 10 - total 4 = 6
      expect(tracker.exceeded()).toBe(false)
    })

    it("updates exceeded status correctly", () => {
      const tracker = new CostTracker(5)
      tracker.add(10) // Exceeds limit
      expect(tracker.exceeded()).toBe(true)

      tracker.divide(4) // 10/4 = 2.5, now under limit
      expect(tracker.exceeded()).toBe(false)
      expect(tracker.total()).toBe(2.5)
    })

    it("updates remaining calculation correctly", () => {
      const tracker = new CostTracker(10)
      tracker.add(8)
      expect(tracker.remaining()).toBe(2)

      tracker.divide(4) // 8/4 = 2
      expect(tracker.remaining()).toBe(8) // 10 - 2 = 8
    })

    it("throws COST_LIMIT_EXCEEDED for zero divisor", () => {
      const tracker = new CostTracker(10)
      tracker.add(5)

      expect(() => tracker.divide(0)).toThrow(BollardError)
      try {
        tracker.divide(0)
      } catch (err) {
        expect(BollardError.hasCode(err, "COST_LIMIT_EXCEEDED")).toBe(true)
        expect(err).toHaveProperty("message", "Divisor must be a positive finite number, got: 0")
        expect(err).toHaveProperty("context", { divisor: 0 })
      }
      // Verify total unchanged after error
      expect(tracker.total()).toBe(5)
    })

    it("throws COST_LIMIT_EXCEEDED for negative divisor", () => {
      const tracker = new CostTracker(10)
      tracker.add(5)

      expect(() => tracker.divide(-2)).toThrow(BollardError)
      try {
        tracker.divide(-2)
      } catch (err) {
        expect(BollardError.hasCode(err, "COST_LIMIT_EXCEEDED")).toBe(true)
        expect(err).toHaveProperty("message", "Divisor must be a positive finite number, got: -2")
        expect(err).toHaveProperty("context", { divisor: -2 })
      }
      expect(tracker.total()).toBe(5)
    })

    it("throws COST_LIMIT_EXCEEDED for NaN divisor", () => {
      const tracker = new CostTracker(10)
      tracker.add(5)

      expect(() => tracker.divide(Number.NaN)).toThrow(BollardError)
      try {
        tracker.divide(Number.NaN)
      } catch (err) {
        expect(BollardError.hasCode(err, "COST_LIMIT_EXCEEDED")).toBe(true)
        expect(err).toHaveProperty("message", "Divisor must be a positive finite number, got: NaN")
      }
      expect(tracker.total()).toBe(5)
    })

    it("throws COST_LIMIT_EXCEEDED for Infinity divisor", () => {
      const tracker = new CostTracker(10)
      tracker.add(5)

      expect(() => tracker.divide(Number.POSITIVE_INFINITY)).toThrow(BollardError)
      try {
        tracker.divide(Number.POSITIVE_INFINITY)
      } catch (err) {
        expect(BollardError.hasCode(err, "COST_LIMIT_EXCEEDED")).toBe(true)
        expect(err).toHaveProperty(
          "message",
          "Divisor must be a positive finite number, got: Infinity",
        )
      }
      expect(tracker.total()).toBe(5)
    })

    it("throws COST_LIMIT_EXCEEDED for negative Infinity divisor", () => {
      const tracker = new CostTracker(10)
      tracker.add(5)

      expect(() => tracker.divide(Number.NEGATIVE_INFINITY)).toThrow(BollardError)
      try {
        tracker.divide(Number.NEGATIVE_INFINITY)
      } catch (err) {
        expect(BollardError.hasCode(err, "COST_LIMIT_EXCEEDED")).toBe(true)
        expect(err).toHaveProperty(
          "message",
          "Divisor must be a positive finite number, got: -Infinity",
        )
      }
      expect(tracker.total()).toBe(5)
    })

    it("works with very small positive divisors", () => {
      const tracker = new CostTracker(1000)
      tracker.add(1)
      tracker.divide(0.001)
      expect(tracker.total()).toBe(1000)
    })

    it("divide by 1 leaves total unchanged", () => {
      const tracker = new CostTracker(10)
      tracker.add(7.5)
      tracker.divide(1)
      expect(tracker.total()).toBe(7.5)
    })

    it("works with complex chaining", () => {
      const tracker = new CostTracker(100)
      const result = tracker
        .add(20)
        .divide(4) // 20/4 = 5
        .add(10) // 5 + 10 = 15
        .divide(3) // 15/3 = 5
        .total()
      expect(result).toBe(5)
    })

    it("handles precision correctly with fractional results", () => {
      const tracker = new CostTracker(10)
      tracker.add(1)
      tracker.divide(3)
      // 1/3 = 0.333...
      expect(tracker.total()).toBeCloseTo(0.3333333333333333, 10)
    })

    it("works correctly after reset", () => {
      const tracker = new CostTracker(10)
      tracker.add(8)
      tracker.divide(2)
      expect(tracker.total()).toBe(4)

      tracker.reset()
      tracker.add(6)
      tracker.divide(3)
      expect(tracker.total()).toBe(2)
    })
  })

  describe("snapshot()", () => {
    it("returns readonly snapshot of current total", () => {
      const tracker = new CostTracker(10)
      tracker.add(3.5)

      const snapshot = tracker.snapshot()

      expect(snapshot.totalCostUsd).toBe(3.5)
      expect(Object.isFrozen(snapshot)).toBe(true)
    })

    it("snapshot does not change when tracker is modified", () => {
      const tracker = new CostTracker(10)
      tracker.add(2)

      const snapshot = tracker.snapshot()
      tracker.add(3)

      expect(snapshot.totalCostUsd).toBe(2)
      expect(tracker.total()).toBe(5)
    })
  })

  describe("summary()", () => {
    it("formats basic cost summary", () => {
      const tracker = new CostTracker(10)
      tracker.add(2.5)

      const summary = tracker.summary()

      expect(summary).toBe("$2.50 / $10.00 (25.0% used)")
    })

    it("shows exceeded status", () => {
      const tracker = new CostTracker(5)
      tracker.add(7.25)

      const summary = tracker.summary()

      expect(summary).toBe("$7.25 / $5.00 (145.0% used) [EXCEEDED]")
    })

    it("handles zero limit with zero cost", () => {
      const tracker = new CostTracker(0)

      const summary = tracker.summary()

      expect(summary).toBe("$0.00 / $0.00 (0.0% used)")
    })

    it("handles zero limit with positive cost", () => {
      const tracker = new CostTracker(0)
      tracker.add(1.5)

      const summary = tracker.summary()

      expect(summary).toBe("$1.50 / $0.00 (100.0% used) [EXCEEDED]")
    })

    it("formats fractional percentages correctly", () => {
      const tracker = new CostTracker(3)
      tracker.add(1)

      const summary = tracker.summary()

      expect(summary).toBe("$1.00 / $3.00 (33.3% used)")
    })

    it("handles exactly at limit", () => {
      const tracker = new CostTracker(5)
      tracker.add(5)

      const summary = tracker.summary()

      expect(summary).toBe("$5.00 / $5.00 (100.0% used)")
    })
  })

  describe("property-based tests", () => {
    it("add() never decreases total", () => {
      fc.assert(
        fc.property(
          fc.float({ min: 0, max: 1000, noNaN: true }),
          fc.float({ min: 0, max: 100, noNaN: true }),
          (limit, cost) => {
            const tracker = new CostTracker(limit)
            const initialTotal = tracker.total()
            tracker.add(cost)
            expect(tracker.total()).toBeGreaterThanOrEqual(initialTotal)
          },
        ),
      )
    })

    it("remaining() is always non-negative", () => {
      fc.assert(
        fc.property(
          fc.float({ min: 0, max: 1000, noNaN: true }),
          fc.float({ min: 0, max: 1000, noNaN: true }),
          (limit, cost) => {
            const tracker = new CostTracker(limit)
            tracker.add(cost)
            expect(tracker.remaining()).toBeGreaterThanOrEqual(0)
          },
        ),
      )
    })

    it("total + remaining equals limit when not exceeded", () => {
      fc.assert(
        fc.property(
          fc.float({ min: 1, max: 1000, noNaN: true }),
          fc.float({ min: 0, max: 1, noNaN: true }),
          (limit, costRatio) => {
            const cost = limit * costRatio
            const tracker = new CostTracker(limit)
            tracker.add(cost)
            const expected = Math.max(0, limit - cost)
            expect(tracker.remaining()).toBeCloseTo(expected, 10)
          },
        ),
      )
    })
  })

  describe("type compatibility", () => {
    it("implements the public CostTracker interface", () => {
      const tracker: PublicCostTracker = new CostTracker(10)
      tracker.add(5)
      expect(tracker.total()).toBe(5)
      expect(tracker.exceeded()).toBe(false)
      expect(tracker.remaining()).toBe(5)
    })
  })
})
