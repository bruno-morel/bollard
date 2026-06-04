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

  it("accepts Infinity limit (unlimited budget)", () => {
    const tracker = new CostTracker(Number.POSITIVE_INFINITY)
    expect(tracker.limitUsd()).toBe(Number.POSITIVE_INFINITY)
    expect(tracker.remaining()).toBe(Number.POSITIVE_INFINITY)
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
    it("zeros the accumulated cost", () => {
      const tracker = new CostTracker(10)
      tracker.add(3.5)
      tracker.add(1.5)

      tracker.reset()

      expect(tracker.total()).toBe(0)
    })

    it("can be called on unused tracker (total stays 0)", () => {
      const tracker = new CostTracker(10)

      tracker.reset()

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

      tracker.reset()

      expect(tracker.total()).toBe(0)
      expect(tracker.remaining()).toBe(0)
      expect(tracker.exceeded()).toBe(false)
    })

    it("can be called multiple times safely", () => {
      const tracker = new CostTracker(10)
      tracker.add(5)

      tracker.reset()
      tracker.reset()
      tracker.reset()

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

      tracker.reset()
    })

    it("preserves limit when resetting exceeded tracker", () => {
      const tracker = new CostTracker(2)
      tracker.add(5)
      expect(tracker.exceeded()).toBe(true)
      expect(tracker.remaining()).toBe(0)

      tracker.reset()

      expect(tracker.total()).toBe(0)
      expect(tracker.remaining()).toBe(2)
      expect(tracker.exceeded()).toBe(false)
    })

    it("handles fractional costs correctly", () => {
      const tracker = new CostTracker(10)
      tracker.add(1.25)
      tracker.add(2.75)

      tracker.reset()

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

    it("handles floating point precision correctly", () => {
      const tracker = new CostTracker(10)
      tracker.add(0.1)
      tracker.add(0.2)
      tracker.subtract(0.2)
      // Should be 0.1, but floating point might give us 0.09999999999999998
      expect(tracker.total()).toBeCloseTo(0.1)
    })

    it("maintains runCount after subtraction", () => {
      const tracker = new CostTracker(10)
      tracker.add(5)
      tracker.add(3)
      expect(tracker.runCount()).toBe(2)

      tracker.subtract(2)
      expect(tracker.runCount()).toBe(2) // runCount should not change
    })

    it("allows multiple subtractions", () => {
      const tracker = new CostTracker(10)
      tracker.add(8)
      tracker.subtract(3)
      tracker.subtract(2)
      tracker.subtract(1)
      expect(tracker.total()).toBe(2)
    })

    it("works with very small amounts", () => {
      const tracker = new CostTracker(1)
      tracker.add(0.001)
      tracker.subtract(0.0005)
      expect(tracker.total()).toBeCloseTo(0.0005)
    })

    it("correctly updates exceeded status after subtraction", () => {
      const tracker = new CostTracker(5)
      tracker.add(8)
      expect(tracker.exceeded()).toBe(true)

      tracker.subtract(4)
      expect(tracker.exceeded()).toBe(false)
      expect(tracker.total()).toBe(4)
    })

    it("correctly updates remaining after subtraction", () => {
      const tracker = new CostTracker(10)
      tracker.add(7)
      expect(tracker.remaining()).toBe(3)

      tracker.subtract(2)
      expect(tracker.remaining()).toBe(5)
      expect(tracker.total()).toBe(5)
    })
  })

  describe("runCount()", () => {
    it("starts at zero", () => {
      const tracker = new CostTracker(10)
      expect(tracker.runCount()).toBe(0)
    })

    it("increments with each add() call", () => {
      const tracker = new CostTracker(10)
      tracker.add(1)
      expect(tracker.runCount()).toBe(1)
      tracker.add(2)
      expect(tracker.runCount()).toBe(2)
    })

    it("increments even when adding zero", () => {
      const tracker = new CostTracker(10)
      tracker.add(0)
      expect(tracker.runCount()).toBe(1)
    })

    it("is not affected by subtract()", () => {
      const tracker = new CostTracker(10)
      tracker.add(5)
      tracker.subtract(2)
      expect(tracker.runCount()).toBe(1)
    })

    it("resets to zero with reset()", () => {
      const tracker = new CostTracker(10)
      tracker.add(1)
      tracker.add(2)
      expect(tracker.runCount()).toBe(2)

      tracker.reset()
      expect(tracker.runCount()).toBe(0)
    })
  })

  describe("snapshotTotal()", () => {
    it("returns current total", () => {
      const tracker = new CostTracker(10)
      expect(tracker.snapshotTotal()).toBe(0)

      tracker.add(3.5)
      expect(tracker.snapshotTotal()).toBe(3.5)

      tracker.add(1.5)
      expect(tracker.snapshotTotal()).toBe(5)
    })

    it("matches total() exactly", () => {
      const tracker = new CostTracker(10)
      tracker.add(2.5)
      expect(tracker.snapshotTotal()).toBe(tracker.total())

      tracker.subtract(1)
      expect(tracker.snapshotTotal()).toBe(tracker.total())
    })

    it("is not affected by subsequent operations", () => {
      const tracker = new CostTracker(10)
      tracker.add(3)
      const snapshot = tracker.snapshotTotal()

      tracker.add(2)
      expect(snapshot).toBe(3)
      expect(tracker.snapshotTotal()).toBe(5)
    })
  })

  describe("clamp()", () => {
    it("clamps total to min when below range", () => {
      const tracker = new CostTracker(100)
      tracker.add(5)
      tracker.clamp(10, 50)
      expect(tracker.total()).toBe(10)
    })

    it("clamps total to max when above range", () => {
      const tracker = new CostTracker(100)
      tracker.add(75)
      tracker.clamp(10, 50)
      expect(tracker.total()).toBe(50)
    })

    it("leaves total unchanged when within range", () => {
      const tracker = new CostTracker(100)
      tracker.add(25)
      tracker.clamp(10, 50)
      expect(tracker.total()).toBe(25)
    })

    it("handles edge case where total equals min", () => {
      const tracker = new CostTracker(100)
      tracker.add(10)
      tracker.clamp(10, 50)
      expect(tracker.total()).toBe(10)
    })

    it("handles edge case where total equals max", () => {
      const tracker = new CostTracker(100)
      tracker.add(50)
      tracker.clamp(10, 50)
      expect(tracker.total()).toBe(50)
    })

    it("returns this for chaining", () => {
      const tracker = new CostTracker(100)
      tracker.add(25)
      const result = tracker.clamp(10, 50)
      expect(result).toBe(tracker)
    })

    it("throws BollardError for negative min", () => {
      const tracker = new CostTracker(100)
      expect(() => tracker.clamp(-5, 50)).toThrow(BollardError)
      try {
        tracker.clamp(-5, 50)
      } catch (err) {
        expect(BollardError.hasCode(err, "CONTRACT_VIOLATION")).toBe(true)
        expect(err).toHaveProperty("message", "min must be a non-negative finite number, got: -5")
      }
    })

    it("throws BollardError for negative max", () => {
      const tracker = new CostTracker(100)
      expect(() => tracker.clamp(10, -5)).toThrow(BollardError)
      try {
        tracker.clamp(10, -5)
      } catch (err) {
        expect(BollardError.hasCode(err, "CONTRACT_VIOLATION")).toBe(true)
        expect(err).toHaveProperty("message", "max must be a non-negative finite number, got: -5")
      }
    })

    it("throws BollardError when min > max", () => {
      const tracker = new CostTracker(100)
      expect(() => tracker.clamp(50, 10)).toThrow(BollardError)
      try {
        tracker.clamp(50, 10)
      } catch (err) {
        expect(BollardError.hasCode(err, "CONTRACT_VIOLATION")).toBe(true)
        expect(err).toHaveProperty("message", "min must be <= max, got min: 50, max: 10")
      }
    })

    it("throws BollardError for NaN min", () => {
      const tracker = new CostTracker(100)
      expect(() => tracker.clamp(Number.NaN, 50)).toThrow(BollardError)
    })

    it("throws BollardError for NaN max", () => {
      const tracker = new CostTracker(100)
      expect(() => tracker.clamp(10, Number.NaN)).toThrow(BollardError)
    })

    it("throws BollardError for Infinity min", () => {
      const tracker = new CostTracker(100)
      expect(() => tracker.clamp(Number.POSITIVE_INFINITY, 50)).toThrow(BollardError)
    })

    it("throws BollardError for Infinity max", () => {
      const tracker = new CostTracker(100)
      expect(() => tracker.clamp(10, Number.POSITIVE_INFINITY)).toThrow(BollardError)
    })

    it("handles zero values correctly", () => {
      const tracker = new CostTracker(100)
      tracker.add(5)
      tracker.clamp(0, 10)
      expect(tracker.total()).toBe(5)
    })

    it("can clamp to zero range", () => {
      const tracker = new CostTracker(100)
      tracker.add(5)
      tracker.clamp(0, 0)
      expect(tracker.total()).toBe(0)
    })

    it("works with fractional values", () => {
      const tracker = new CostTracker(100)
      tracker.add(2.5)
      tracker.clamp(1.5, 3.5)
      expect(tracker.total()).toBe(2.5)
    })

    it("works with large values", () => {
      const tracker = new CostTracker(1000000)
      tracker.add(500000)
      tracker.clamp(100000, 800000)
      expect(tracker.total()).toBe(500000)
    })
  })

  describe("cap()", () => {
    it("caps total to maxUsd when above ceiling", () => {
      const tracker = new CostTracker(100)
      tracker.add(75)
      tracker.cap(50)
      expect(tracker.total()).toBe(50)
    })

    it("leaves total unchanged when at or below maxUsd", () => {
      const tracker = new CostTracker(100)
      tracker.add(25)
      tracker.cap(50)
      expect(tracker.total()).toBe(25)
    })

    it("leaves total unchanged when equal to maxUsd", () => {
      const tracker = new CostTracker(100)
      tracker.add(50)
      tracker.cap(50)
      expect(tracker.total()).toBe(50)
    })

    it("returns this for chaining", () => {
      const tracker = new CostTracker(100)
      tracker.add(25)
      const result = tracker.cap(50)
      expect(result).toBe(tracker)
    })

    it("accepts maxUsd = 0", () => {
      const tracker = new CostTracker(100)
      tracker.add(50)
      tracker.cap(0)
      expect(tracker.total()).toBe(0)
    })

    it("throws BollardError for negative maxUsd", () => {
      const tracker = new CostTracker(100)
      expect(() => tracker.cap(-1)).toThrow(BollardError)
      try {
        tracker.cap(-1)
      } catch (err) {
        expect(BollardError.hasCode(err, "CONTRACT_VIOLATION")).toBe(true)
        expect(err).toHaveProperty(
          "message",
          "maxUsd must be a non-negative finite number, got: -1",
        )
      }
    })

    it("throws BollardError for NaN maxUsd", () => {
      const tracker = new CostTracker(100)
      expect(() => tracker.cap(Number.NaN)).toThrow(BollardError)
    })

    it("throws BollardError for Infinity maxUsd", () => {
      const tracker = new CostTracker(100)
      expect(() => tracker.cap(Number.POSITIVE_INFINITY)).toThrow(BollardError)
    })

    it("can be chained with add", () => {
      const tracker = new CostTracker(100)
      const result = tracker.add(30).cap(50).add(10)
      expect(result).toBe(tracker)
      expect(tracker.total()).toBe(40)
    })
  })

  describe("divide()", () => {
    it("divides total by the given divisor", () => {
      const tracker = new CostTracker(100)
      tracker.add(20)
      tracker.divide(4)
      expect(tracker.total()).toBe(5)
    })

    it("returns this for chaining", () => {
      const tracker = new CostTracker(100)
      tracker.add(20)
      const result = tracker.divide(2)
      expect(result).toBe(tracker)
    })

    it("handles fractional results", () => {
      const tracker = new CostTracker(100)
      tracker.add(10)
      tracker.divide(3)
      expect(tracker.total()).toBeCloseTo(3.333333, 5)
    })

    it("handles division by 1 (no change)", () => {
      const tracker = new CostTracker(100)
      tracker.add(25)
      tracker.divide(1)
      expect(tracker.total()).toBe(25)
    })

    it("handles division of zero", () => {
      const tracker = new CostTracker(100)
      tracker.divide(5)
      expect(tracker.total()).toBe(0)
    })

    it("throws BollardError for zero divisor", () => {
      const tracker = new CostTracker(100)
      tracker.add(10)
      expect(() => tracker.divide(0)).toThrow(BollardError)
      try {
        tracker.divide(0)
      } catch (err) {
        expect(BollardError.hasCode(err, "COST_LIMIT_EXCEEDED")).toBe(true)
        expect(err).toHaveProperty("context", { divisor: 0 })
      }
    })

    it("throws BollardError for negative divisor", () => {
      const tracker = new CostTracker(100)
      tracker.add(10)
      expect(() => tracker.divide(-2)).toThrow(BollardError)
      try {
        tracker.divide(-2)
      } catch (err) {
        expect(BollardError.hasCode(err, "COST_LIMIT_EXCEEDED")).toBe(true)
        expect(err).toHaveProperty("context", { divisor: -2 })
      }
    })

    it("throws BollardError for NaN divisor", () => {
      const tracker = new CostTracker(100)
      tracker.add(10)
      expect(() => tracker.divide(Number.NaN)).toThrow(BollardError)
    })

    it("throws BollardError for Infinity divisor", () => {
      const tracker = new CostTracker(100)
      tracker.add(10)
      expect(() => tracker.divide(Number.POSITIVE_INFINITY)).toThrow(BollardError)
    })

    it("preserves runCount", () => {
      const tracker = new CostTracker(100)
      tracker.add(20)
      tracker.add(10)
      expect(tracker.runCount()).toBe(2)

      tracker.divide(2)
      expect(tracker.runCount()).toBe(2)
    })

    it("works with very small divisors", () => {
      const tracker = new CostTracker(100)
      tracker.add(1)
      tracker.divide(0.1)
      expect(tracker.total()).toBe(10)
    })

    it("works with very large divisors", () => {
      const tracker = new CostTracker(100)
      tracker.add(1000)
      tracker.divide(1000)
      expect(tracker.total()).toBe(1)
    })
  })

  describe("multiply()", () => {
    it("multiplies total by the given factor", () => {
      const tracker = new CostTracker(100)
      tracker.add(5)
      tracker.multiply(3)
      expect(tracker.total()).toBe(15)
    })

    it("returns this for chaining", () => {
      const tracker = new CostTracker(100)
      tracker.add(5)
      const result = tracker.multiply(2)
      expect(result).toBe(tracker)
    })

    it("handles fractional factors", () => {
      const tracker = new CostTracker(100)
      tracker.add(10)
      tracker.multiply(0.5)
      expect(tracker.total()).toBe(5)
    })

    it("handles multiplication by 1 (no change)", () => {
      const tracker = new CostTracker(100)
      tracker.add(25)
      tracker.multiply(1)
      expect(tracker.total()).toBe(25)
    })

    it("handles multiplication of zero", () => {
      const tracker = new CostTracker(100)
      tracker.multiply(5)
      expect(tracker.total()).toBe(0)
    })

    it("throws BollardError for zero factor", () => {
      const tracker = new CostTracker(100)
      tracker.add(10)
      expect(() => tracker.multiply(0)).toThrow(BollardError)
      try {
        tracker.multiply(0)
      } catch (err) {
        expect(BollardError.hasCode(err, "CONTRACT_VIOLATION")).toBe(true)
        expect(err).toHaveProperty("context", { factor: 0 })
      }
    })

    it("throws BollardError for negative factor", () => {
      const tracker = new CostTracker(100)
      tracker.add(10)
      expect(() => tracker.multiply(-2)).toThrow(BollardError)
      try {
        tracker.multiply(-2)
      } catch (err) {
        expect(BollardError.hasCode(err, "CONTRACT_VIOLATION")).toBe(true)
        expect(err).toHaveProperty("context", { factor: -2 })
      }
    })

    it("throws BollardError for NaN factor", () => {
      const tracker = new CostTracker(100)
      tracker.add(10)
      expect(() => tracker.multiply(Number.NaN)).toThrow(BollardError)
    })

    it("throws BollardError for Infinity factor", () => {
      const tracker = new CostTracker(100)
      tracker.add(10)
      expect(() => tracker.multiply(Number.POSITIVE_INFINITY)).toThrow(BollardError)
    })

    it("preserves runCount", () => {
      const tracker = new CostTracker(100)
      tracker.add(5)
      tracker.add(3)
      expect(tracker.runCount()).toBe(2)

      tracker.multiply(2)
      expect(tracker.runCount()).toBe(2)
    })

    it("works with very small factors", () => {
      const tracker = new CostTracker(100)
      tracker.add(10)
      tracker.multiply(0.01)
      expect(tracker.total()).toBe(0.1)
    })

    it("works with very large factors", () => {
      const tracker = new CostTracker(100000)
      tracker.add(1)
      tracker.multiply(1000)
      expect(tracker.total()).toBe(1000)
    })
  })

  describe("snapshot()", () => {
    it("returns frozen object with current total", () => {
      const tracker = new CostTracker(10)
      tracker.add(5)
      const snapshot = tracker.snapshot()
      expect(snapshot).toEqual({ totalCostUsd: 5 })
      expect(Object.isFrozen(snapshot)).toBe(true)
    })

    it("snapshot is immutable", () => {
      const tracker = new CostTracker(10)
      tracker.add(3)
      const snapshot = tracker.snapshot()

      expect(() => {
        ;(snapshot as { totalCostUsd: number }).totalCostUsd = 999
      }).toThrow()

      expect(snapshot.totalCostUsd).toBe(3)
    })

    it("multiple snapshots are independent", () => {
      const tracker = new CostTracker(10)
      tracker.add(2)
      const snapshot1 = tracker.snapshot()

      tracker.add(3)
      const snapshot2 = tracker.snapshot()

      expect(snapshot1.totalCostUsd).toBe(2)
      expect(snapshot2.totalCostUsd).toBe(5)
    })

    it("snapshot reflects current state", () => {
      const tracker = new CostTracker(10)
      tracker.add(4)
      tracker.subtract(1)
      const snapshot = tracker.snapshot()
      expect(snapshot.totalCostUsd).toBe(3)
    })
  })

  describe("formatCost()", () => {
    it("formats cost with default 2 decimal places", () => {
      const tracker = new CostTracker(10)
      tracker.add(5.123)
      expect(tracker.formatCost()).toBe("$5.12")
    })

    it("formats cost with custom decimal places", () => {
      const tracker = new CostTracker(10)
      tracker.add(5.123456)
      expect(tracker.formatCost(4)).toBe("$5.1235")
    })

    it("formats cost with 0 decimal places", () => {
      const tracker = new CostTracker(10)
      tracker.add(5.789)
      expect(tracker.formatCost(0)).toBe("$6")
    })

    it("formats zero cost", () => {
      const tracker = new CostTracker(10)
      expect(tracker.formatCost()).toBe("$0.00")
    })

    it("formats very small costs", () => {
      const tracker = new CostTracker(10)
      tracker.add(0.001)
      expect(tracker.formatCost()).toBe("$0.00")
      expect(tracker.formatCost(3)).toBe("$0.001")
    })

    it("formats large costs", () => {
      const tracker = new CostTracker(100000)
      tracker.add(12345.67)
      expect(tracker.formatCost()).toBe("$12345.67")
    })

    it("throws BollardError for negative decimal places", () => {
      const tracker = new CostTracker(10)
      tracker.add(5)
      expect(() => tracker.formatCost(-1)).toThrow(BollardError)
      try {
        tracker.formatCost(-1)
      } catch (err) {
        expect(BollardError.hasCode(err, "CONTRACT_VIOLATION")).toBe(true)
        expect(err).toHaveProperty(
          "message",
          "decimalPlaces must be a non-negative integer, got: -1",
        )
      }
    })

    it("throws BollardError for non-integer decimal places", () => {
      const tracker = new CostTracker(10)
      tracker.add(5)
      expect(() => tracker.formatCost(2.5)).toThrow(BollardError)
      try {
        tracker.formatCost(2.5)
      } catch (err) {
        expect(BollardError.hasCode(err, "CONTRACT_VIOLATION")).toBe(true)
        expect(err).toHaveProperty(
          "message",
          "decimalPlaces must be a non-negative integer, got: 2.5",
        )
      }
    })

    it("handles edge case of exactly 0 decimal places", () => {
      const tracker = new CostTracker(10)
      tracker.add(5.999)
      expect(tracker.formatCost(0)).toBe("$6")
    })
  })

  describe("summary()", () => {
    it("formats basic summary with percentage", () => {
      const tracker = new CostTracker(10)
      tracker.add(3)
      expect(tracker.summary()).toBe("$3.00 / $10.00 (30.0% used)")
    })

    it("shows exceeded status when over limit", () => {
      const tracker = new CostTracker(5)
      tracker.add(8)
      expect(tracker.summary()).toBe("$8.00 / $5.00 (160.0% used) [EXCEEDED]")
    })

    it("handles zero cost", () => {
      const tracker = new CostTracker(10)
      expect(tracker.summary()).toBe("$0.00 / $10.00 (0.0% used)")
    })

    it("handles zero limit with zero cost", () => {
      const tracker = new CostTracker(0)
      expect(tracker.summary()).toBe("$0.00 / $0.00 (0.0% used)")
    })

    it("handles zero limit with positive cost", () => {
      const tracker = new CostTracker(0)
      tracker.add(1)
      expect(tracker.summary()).toBe("$1.00 / $0.00 (100.0% used) [EXCEEDED]")
    })

    it("handles fractional values", () => {
      const tracker = new CostTracker(7.5)
      tracker.add(2.25)
      expect(tracker.summary()).toBe("$2.25 / $7.50 (30.0% used)")
    })

    it("rounds percentage to 1 decimal place", () => {
      const tracker = new CostTracker(3)
      tracker.add(1)
      expect(tracker.summary()).toBe("$1.00 / $3.00 (33.3% used)")
    })

    it("handles very small percentages", () => {
      const tracker = new CostTracker(10000)
      tracker.add(1)
      expect(tracker.summary()).toBe("$1.00 / $10000.00 (0.0% used)")
    })

    it("handles exactly 100% usage", () => {
      const tracker = new CostTracker(5)
      tracker.add(5)
      expect(tracker.summary()).toBe("$5.00 / $5.00 (100.0% used)")
    })
  })

  describe("merge()", () => {
    it("returns a new CostTracker with combined totals", () => {
      const tracker1 = new CostTracker(10)
      const tracker2 = new CostTracker(5)

      tracker1.add(3)
      tracker2.add(2)

      const merged = tracker1.merge(tracker2)

      expect(merged.total()).toBe(5)
      expect(merged).not.toBe(tracker1)
      expect(merged).not.toBe(tracker2)
    })

    it("does not mutate source trackers", () => {
      const tracker1 = new CostTracker(10)
      const tracker2 = new CostTracker(8)

      tracker1.add(4)
      tracker2.add(3)

      const originalTotal1 = tracker1.total()
      const originalTotal2 = tracker2.total()

      tracker1.merge(tracker2)

      expect(tracker1.total()).toBe(originalTotal1)
      expect(tracker2.total()).toBe(originalTotal2)
    })

    it("uses receiver's limit for the merged tracker", () => {
      const tracker1 = new CostTracker(10)
      const tracker2 = new CostTracker(20)

      tracker1.add(3)
      tracker2.add(2)

      const merged = tracker1.merge(tracker2)

      expect(merged.remaining()).toBe(5) // 10 - 5 = 5
      expect(merged.exceeded()).toBe(false)
    })

    it("merged tracker exceeded() uses receiver's limit", () => {
      const tracker1 = new CostTracker(4) // Small limit
      const tracker2 = new CostTracker(20) // Large limit

      tracker1.add(2)
      tracker2.add(3)

      const merged = tracker1.merge(tracker2) // Total: 5, Limit: 4

      expect(merged.total()).toBe(5)
      expect(merged.exceeded()).toBe(true)
    })

    it("throws CONTRACT_VIOLATION for null other", () => {
      const tracker = new CostTracker(10)

      expect(() => tracker.merge(null as unknown as CostTracker)).toThrow(BollardError)
      try {
        tracker.merge(null as unknown as CostTracker)
      } catch (err) {
        expect(BollardError.hasCode(err, "CONTRACT_VIOLATION")).toBe(true)
        expect(err).toHaveProperty("message", "other must be a CostTracker instance, got: null")
      }
    })

    it("throws CONTRACT_VIOLATION for undefined other", () => {
      const tracker = new CostTracker(10)

      expect(() => tracker.merge(undefined as unknown as CostTracker)).toThrow(BollardError)
      try {
        tracker.merge(undefined as unknown as CostTracker)
      } catch (err) {
        expect(BollardError.hasCode(err, "CONTRACT_VIOLATION")).toBe(true)
        expect(err).toHaveProperty(
          "message",
          "other must be a CostTracker instance, got: undefined",
        )
      }
    })

    it("throws CONTRACT_VIOLATION for non-CostTracker object", () => {
      const tracker = new CostTracker(10)
      const notATracker = { total: () => 5 }

      expect(() => tracker.merge(notATracker as unknown as CostTracker)).toThrow(BollardError)
      try {
        tracker.merge(notATracker as unknown as CostTracker)
      } catch (err) {
        expect(BollardError.hasCode(err, "CONTRACT_VIOLATION")).toBe(true)
      }
    })

    it("works with zero totals", () => {
      const tracker1 = new CostTracker(10)
      const tracker2 = new CostTracker(5)

      const merged = tracker1.merge(tracker2)

      expect(merged.total()).toBe(0)
      expect(merged.remaining()).toBe(10)
    })

    it("works when one tracker has zero total", () => {
      const tracker1 = new CostTracker(10)
      const tracker2 = new CostTracker(5)

      tracker1.add(7)
      // tracker2 remains at 0

      const merged = tracker1.merge(tracker2)

      expect(merged.total()).toBe(7)
      expect(merged.remaining()).toBe(3)
    })

    it("works with different limits", () => {
      const tracker1 = new CostTracker(15)
      const tracker2 = new CostTracker(25)

      tracker1.add(5)
      tracker2.add(8)

      const merged = tracker1.merge(tracker2)

      expect(merged.total()).toBe(13)
      expect(merged.remaining()).toBe(2) // Uses tracker1's limit of 15
    })

    it("preserves precision with fractional amounts", () => {
      const tracker1 = new CostTracker(10)
      const tracker2 = new CostTracker(10)

      tracker1.add(1.25)
      tracker2.add(2.75)

      const merged = tracker1.merge(tracker2)

      expect(merged.total()).toBe(4)
    })

    it("works when both trackers exceed their individual limits", () => {
      const tracker1 = new CostTracker(3)
      const tracker2 = new CostTracker(4)

      tracker1.add(5) // Exceeds limit of 3
      tracker2.add(6) // Exceeds limit of 4

      const merged = tracker1.merge(tracker2) // Total: 11, Limit: 3

      expect(merged.total()).toBe(11)
      expect(merged.exceeded()).toBe(true)
      expect(merged.remaining()).toBe(0)
    })

    it("merged tracker has independent state", () => {
      const tracker1 = new CostTracker(10)
      const tracker2 = new CostTracker(10)

      tracker1.add(2)
      tracker2.add(3)

      const merged = tracker1.merge(tracker2)

      // Modify original trackers
      tracker1.add(5)
      tracker2.subtract(1)

      // Merged tracker should be unaffected
      expect(merged.total()).toBe(5)
    })

    it("works with large values", () => {
      const tracker1 = new CostTracker(1000000)
      const tracker2 = new CostTracker(500000)

      tracker1.add(250000)
      tracker2.add(150000)

      const merged = tracker1.merge(tracker2)

      expect(merged.total()).toBe(400000)
      expect(merged.remaining()).toBe(600000)
      expect(merged.exceeded()).toBe(false)
    })
  })

  describe("limitUsd()", () => {
    it("returns the limit passed to constructor", () => {
      const tracker = new CostTracker(10.5)
      expect(tracker.limitUsd()).toBe(10.5)
    })

    it("returns same value on repeated calls (idempotent)", () => {
      const tracker = new CostTracker(25.75)
      expect(tracker.limitUsd()).toBe(25.75)
      expect(tracker.limitUsd()).toBe(25.75)
      expect(tracker.limitUsd()).toBe(25.75)
    })

    it("works with zero limit", () => {
      const tracker = new CostTracker(0)
      expect(tracker.limitUsd()).toBe(0)
    })

    it("works with fractional limits", () => {
      const tracker = new CostTracker(0.001)
      expect(tracker.limitUsd()).toBe(0.001)
    })

    it("does not affect total(), remaining(), exceeded(), or other state-reading methods", () => {
      const tracker = new CostTracker(10)
      tracker.add(3)

      const initialTotal = tracker.total()
      const initialRemaining = tracker.remaining()
      const initialExceeded = tracker.exceeded()
      const initialPeek = tracker.peek()

      tracker.limitUsd()
      tracker.limitUsd()
      tracker.limitUsd()

      expect(tracker.total()).toBe(initialTotal)
      expect(tracker.remaining()).toBe(initialRemaining)
      expect(tracker.exceeded()).toBe(initialExceeded)
      expect(tracker.peek()).toBe(initialPeek)
    })

    it("returns exact value passed to constructor, not derived value", () => {
      const tracker = new CostTracker(100)
      tracker.add(30)

      expect(tracker.limitUsd()).toBe(100)
      expect(tracker.total()).toBe(30)
      expect(tracker.remaining()).toBe(70)
    })

    it("returns non-negative finite number as enforced by constructor", () => {
      const tracker = new CostTracker(42.5)
      const limit = tracker.limitUsd()

      expect(Number.isFinite(limit)).toBe(true)
      expect(limit).toBeGreaterThanOrEqual(0)
    })

    it("works correctly after state modifications", () => {
      const tracker = new CostTracker(50)

      tracker.add(10)
      tracker.subtract(5)
      tracker.clamp(0, 100)
      tracker.multiply(2)
      tracker.divide(2)

      expect(tracker.limitUsd()).toBe(50)
    })

    it("works correctly after reset", () => {
      const tracker = new CostTracker(75)
      tracker.add(25)
      tracker.reset()

      expect(tracker.limitUsd()).toBe(75)
    })
  })

  describe("property-based tests", () => {
    it("remaining() is always non-negative", () => {
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

    describe("withLimit()", () => {
      it("returns a new CostTracker instance with same total", () => {
        const tracker = new CostTracker(10)
        tracker.add(5)

        const newTracker = tracker.withLimit(20)

        expect(newTracker).not.toBe(tracker) // Different instances
        expect(newTracker.total()).toBe(5) // Same total
        expect(tracker.total()).toBe(5) // Original unchanged
      })

      it("returns tracker with newLimit as its limit", () => {
        const tracker = new CostTracker(10)
        tracker.add(3)

        const newTracker = tracker.withLimit(15)

        expect(newTracker.remaining()).toBe(12) // 15 - 3
        expect(tracker.remaining()).toBe(7) // 10 - 3 (original unchanged)
      })

      it("works with zero limit", () => {
        const tracker = new CostTracker(10)
        tracker.add(5)

        const newTracker = tracker.withLimit(0)

        expect(newTracker.total()).toBe(5)
        expect(newTracker.remaining()).toBe(0)
        expect(newTracker.exceeded()).toBe(true)
      })

      it("works with large limit", () => {
        const tracker = new CostTracker(10)
        tracker.add(5)

        const newTracker = tracker.withLimit(1000000)

        expect(newTracker.total()).toBe(5)
        expect(newTracker.remaining()).toBe(999995)
        expect(newTracker.exceeded()).toBe(false)
      })

      it("does not mutate receiver's state", () => {
        const tracker = new CostTracker(10)
        tracker.add(3)
        const originalTotal = tracker.total()
        const originalRemaining = tracker.remaining()
        const originalRunCount = tracker.runCount()

        tracker.withLimit(20)

        expect(tracker.total()).toBe(originalTotal)
        expect(tracker.remaining()).toBe(originalRemaining)
        expect(tracker.runCount()).toBe(originalRunCount)
      })

      it("returned tracker's exceeded() reflects newLimit", () => {
        const tracker = new CostTracker(10)
        tracker.add(8)
        expect(tracker.exceeded()).toBe(false)

        const newTracker = tracker.withLimit(5)

        expect(newTracker.exceeded()).toBe(true) // 8 > 5
        expect(tracker.exceeded()).toBe(false) // 8 <= 10
      })

      it("returned tracker's remaining() reflects newLimit", () => {
        const tracker = new CostTracker(10)
        tracker.add(3)

        const newTracker = tracker.withLimit(7)

        expect(newTracker.remaining()).toBe(4) // 7 - 3
        expect(tracker.remaining()).toBe(7) // 10 - 3
      })

      it("throws CONTRACT_VIOLATION for negative newLimit", () => {
        const tracker = new CostTracker(10)

        expect(() => tracker.withLimit(-1)).toThrow(BollardError)
        try {
          tracker.withLimit(-1)
        } catch (err) {
          expect(BollardError.hasCode(err, "CONTRACT_VIOLATION")).toBe(true)
          expect(err).toHaveProperty(
            "message",
            "newLimit must be a non-negative finite number or Infinity, got: -1",
          )
        }
      })

      it("accepts Infinity as newLimit (unlimited budget)", () => {
        const tracker = new CostTracker(10)
        const unlimited = tracker.withLimit(Number.POSITIVE_INFINITY)
        expect(unlimited.limitUsd()).toBe(Number.POSITIVE_INFINITY)
        expect(unlimited.remaining()).toBe(Number.POSITIVE_INFINITY)
      })

      it("throws CONTRACT_VIOLATION for -Infinity", () => {
        const tracker = new CostTracker(10)

        expect(() => tracker.withLimit(Number.NEGATIVE_INFINITY)).toThrow(BollardError)
        try {
          tracker.withLimit(Number.NEGATIVE_INFINITY)
        } catch (err) {
          expect(BollardError.hasCode(err, "CONTRACT_VIOLATION")).toBe(true)
        }
      })

      it("throws CONTRACT_VIOLATION for NaN", () => {
        const tracker = new CostTracker(10)

        expect(() => tracker.withLimit(Number.NaN)).toThrow(BollardError)
        try {
          tracker.withLimit(Number.NaN)
        } catch (err) {
          expect(BollardError.hasCode(err, "CONTRACT_VIOLATION")).toBe(true)
        }
      })

      it("works with zero total and various limits", () => {
        const tracker = new CostTracker(10)
        // No costs added, total is 0

        const newTracker1 = tracker.withLimit(0)
        expect(newTracker1.total()).toBe(0)
        expect(newTracker1.remaining()).toBe(0)
        expect(newTracker1.exceeded()).toBe(false)

        const newTracker2 = tracker.withLimit(5)
        expect(newTracker2.total()).toBe(0)
        expect(newTracker2.remaining()).toBe(5)
        expect(newTracker2.exceeded()).toBe(false)
      })

      it("works with non-zero total and various limits", () => {
        const tracker = new CostTracker(10)
        tracker.add(4)

        const newTracker1 = tracker.withLimit(2)
        expect(newTracker1.total()).toBe(4)
        expect(newTracker1.remaining()).toBe(0) // Math.max(0, 2-4)
        expect(newTracker1.exceeded()).toBe(true)

        const newTracker2 = tracker.withLimit(4)
        expect(newTracker2.total()).toBe(4)
        expect(newTracker2.remaining()).toBe(0)
        expect(newTracker2.exceeded()).toBe(false) // exactly at limit

        const newTracker3 = tracker.withLimit(6)
        expect(newTracker3.total()).toBe(4)
        expect(newTracker3.remaining()).toBe(2)
        expect(newTracker3.exceeded()).toBe(false)
      })

      it("supports multiple sequential withLimit calls", () => {
        const tracker = new CostTracker(10)
        tracker.add(3)

        const tracker1 = tracker.withLimit(20)
        const tracker2 = tracker1.withLimit(5)
        const tracker3 = tracker2.withLimit(15)

        // All should have same total
        expect(tracker.total()).toBe(3)
        expect(tracker1.total()).toBe(3)
        expect(tracker2.total()).toBe(3)
        expect(tracker3.total()).toBe(3)

        // But different limits
        expect(tracker.remaining()).toBe(7) // 10 - 3
        expect(tracker1.remaining()).toBe(17) // 20 - 3
        expect(tracker2.remaining()).toBe(2) // 5 - 3
        expect(tracker3.remaining()).toBe(12) // 15 - 3
      })

      it("returned tracker has zero runCount", () => {
        const tracker = new CostTracker(10)
        tracker.add(2)
        tracker.add(3)
        expect(tracker.runCount()).toBe(2)

        const newTracker = tracker.withLimit(20)

        expect(newTracker.runCount()).toBe(0) // New instance starts fresh
        expect(tracker.runCount()).toBe(2) // Original unchanged
      })
    })
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

  it("exceeded() is consistent with total > limit", () => {
    fc.assert(
      fc.property(
        fc.float({ min: 1, max: 1000, noNaN: true }),
        fc.float({ min: 0, max: 2, noNaN: true }),
        (limit, costRatio) => {
          const cost = limit * costRatio
          const tracker = new CostTracker(limit)
          tracker.add(cost)
          expect(tracker.exceeded()).toBe(cost > limit)
        },
      ),
    )
  })

  it("add() and subtract() are inverse operations", () => {
    fc.assert(
      fc.property(
        fc.float({ min: 10, max: 1000, noNaN: true }),
        fc.float({ min: 0, max: 5, noNaN: true }),
        (limit, amount) => {
          const tracker = new CostTracker(limit)
          const initialTotal = tracker.total()
          tracker.add(amount)
          tracker.subtract(amount)
          expect(tracker.total()).toBeCloseTo(initialTotal, 10)
        },
      ),
    )
  })

  it("clamp() always results in value within bounds", () => {
    fc.assert(
      fc.property(
        fc.float({ min: 100, max: 1000, noNaN: true }),
        fc.float({ min: 0, max: 50, noNaN: true }),
        fc.float({ min: 0, max: 25, noNaN: true }),
        fc.float({ min: 25, max: 75, noNaN: true }),
        (limit, initialCost, min, max) => {
          const tracker = new CostTracker(limit)
          tracker.add(initialCost)
          tracker.clamp(min, max)
          expect(tracker.total()).toBeGreaterThanOrEqual(min)
          expect(tracker.total()).toBeLessThanOrEqual(max)
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
  })
})

describe("type compatibility", () => {
  it("implements the public CostTracker interface", () => {
    const tracker: PublicCostTracker = new CostTracker(10)
    tracker.add(5)
    expect(tracker.total()).toBe(5)
  })
})
describe("toJSON()", () => {
  it("returns object with correct properties and types", () => {
    const tracker = new CostTracker(10)
    tracker.add(5)

    const json = tracker.toJSON()

    expect(json).toEqual({
      totalCostUsd: 5,
      limitUsd: 10,
      runCount: 1,
    })
    expect(typeof json.totalCostUsd).toBe("number")
    expect(typeof json.limitUsd).toBe("number")
    expect(typeof json.runCount).toBe("number")
  })

  it("values match accessor methods", () => {
    const tracker = new CostTracker(25.5)
    tracker.add(7.25)
    tracker.add(3.75)

    const json = tracker.toJSON()

    expect(json.totalCostUsd).toBe(tracker.total())
    expect(json.limitUsd).toBe(tracker.limitUsd())
    expect(json.runCount).toBe(tracker.runCount())
  })

  it("does not modify internal state", () => {
    const tracker = new CostTracker(15)
    tracker.add(8)

    const totalBefore = tracker.total()
    const limitBefore = tracker.limitUsd()
    const runCountBefore = tracker.runCount()

    tracker.toJSON()

    expect(tracker.total()).toBe(totalBefore)
    expect(tracker.limitUsd()).toBe(limitBefore)
    expect(tracker.runCount()).toBe(runCountBefore)
  })

  it("works with zero values", () => {
    const tracker = new CostTracker(0)

    const json = tracker.toJSON()

    expect(json).toEqual({
      totalCostUsd: 0,
      limitUsd: 0,
      runCount: 0,
    })
  })

  it("works with fractional values", () => {
    const tracker = new CostTracker(12.345)
    tracker.add(6.789)

    const json = tracker.toJSON()

    expect(json.totalCostUsd).toBe(6.789)
    expect(json.limitUsd).toBe(12.345)
    expect(json.runCount).toBe(1)
  })

  it("reflects multiple operations", () => {
    const tracker = new CostTracker(100)
    tracker.add(10)
    tracker.add(20)
    tracker.subtract(5)

    const json = tracker.toJSON()

    expect(json.totalCostUsd).toBe(25)
    expect(json.limitUsd).toBe(100)
    expect(json.runCount).toBe(2) // add() increments runCount, subtract() does not
  })

  it("is idempotent - multiple calls return equivalent objects", () => {
    const tracker = new CostTracker(50)
    tracker.add(15)
    tracker.add(10)

    const json1 = tracker.toJSON()
    const json2 = tracker.toJSON()
    const json3 = tracker.toJSON()

    expect(json1).toEqual(json2)
    expect(json2).toEqual(json3)
    expect(json1).toEqual({
      totalCostUsd: 25,
      limitUsd: 50,
      runCount: 2,
    })
  })

  it("returns a plain object (not a class instance)", () => {
    const tracker = new CostTracker(10)
    tracker.add(5)

    const json = tracker.toJSON()

    expect(json.constructor).toBe(Object)
    expect(json instanceof CostTracker).toBe(false)
    expect(Object.getPrototypeOf(json)).toBe(Object.prototype)
  })

  it("serializes correctly with JSON.stringify", () => {
    const tracker = new CostTracker(30.5)
    tracker.add(12.25)
    tracker.add(8.75)

    const json = tracker.toJSON()
    const serialized = JSON.stringify(json)
    const parsed = JSON.parse(serialized)

    expect(parsed).toEqual({
      totalCostUsd: 21,
      limitUsd: 30.5,
      runCount: 2,
    })
    expect(typeof serialized).toBe("string")
    expect(serialized).toContain('"totalCostUsd":21')
    expect(serialized).toContain('"limitUsd":30.5')
    expect(serialized).toContain('"runCount":2')
  })

  it("JSON.stringify on tracker instance uses toJSON automatically", () => {
    const tracker = new CostTracker(40)
    tracker.add(15)
    tracker.add(5)

    const serialized = JSON.stringify(tracker)
    const parsed = JSON.parse(serialized)

    expect(parsed).toEqual({
      totalCostUsd: 20,
      limitUsd: 40,
      runCount: 2,
    })
  })

  it("works after reset", () => {
    const tracker = new CostTracker(20)
    tracker.add(10)
    tracker.add(5)
    tracker.reset()

    const json = tracker.toJSON()

    expect(json).toEqual({
      totalCostUsd: 0,
      limitUsd: 20,
      runCount: 0,
    })
  })

  it("works with chained operations", () => {
    const tracker = new CostTracker(100)
    tracker.add(50).clamp(10, 30).multiply(2)

    const json = tracker.toJSON()

    expect(json.totalCostUsd).toBe(60) // clamped to 30, then multiplied by 2
    expect(json.limitUsd).toBe(100)
    expect(json.runCount).toBe(1) // only add() increments runCount
  })

  it("handles edge case with very large numbers", () => {
    const tracker = new CostTracker(Number.MAX_SAFE_INTEGER)
    tracker.add(1000000)

    const json = tracker.toJSON()

    expect(json.totalCostUsd).toBe(1000000)
    expect(json.limitUsd).toBe(Number.MAX_SAFE_INTEGER)
    expect(json.runCount).toBe(1)

    // Verify it serializes correctly
    const serialized = JSON.stringify(json)
    const parsed = JSON.parse(serialized)
    expect(parsed.limitUsd).toBe(Number.MAX_SAFE_INTEGER)
  })
})
