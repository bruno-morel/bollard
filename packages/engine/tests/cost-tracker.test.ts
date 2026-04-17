import fc from "fast-check"
import { describe, expect, it, vi } from "vitest"
import type { PipelineContext } from "../src/context.js"
import { CostTracker } from "../src/cost-tracker.js"
import { BollardError } from "../src/errors.js"
import { CostTracker as PublicCostTracker } from "../src/types.js"

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

    it("prevents underflow with fractional precision", () => {
      const tracker = new CostTracker(10)
      tracker.add(1.1)

      expect(() => tracker.subtract(1.2)).toThrow(BollardError)
      try {
        tracker.subtract(1.2)
      } catch (err) {
        expect(BollardError.hasCode(err, "CONTRACT_VIOLATION")).toBe(true)
      }
      expect(tracker.total()).toBe(1.1)
    })

    it("works correctly after reset", () => {
      const tracker = new CostTracker(10)
      tracker.add(5)
      tracker.reset()
      tracker.add(3)
      tracker.subtract(1)
      expect(tracker.total()).toBe(2)
    })

    it("affects remaining budget correctly", () => {
      const tracker = new CostTracker(10)
      tracker.add(7)
      expect(tracker.remaining()).toBe(3)
      tracker.subtract(2)
      expect(tracker.remaining()).toBe(5)
    })

    it("affects exceeded status correctly", () => {
      const tracker = new CostTracker(5)
      tracker.add(6)
      expect(tracker.exceeded()).toBe(true)
      tracker.subtract(2)
      expect(tracker.exceeded()).toBe(false)
    })

    it("can be called multiple times in sequence", () => {
      const tracker = new CostTracker(10)
      tracker.add(8)
      tracker.subtract(2)
      tracker.subtract(1)
      tracker.subtract(3)
      expect(tracker.total()).toBe(2)
    })

    it("interacts correctly with add method", () => {
      const tracker = new CostTracker(10)
      tracker.add(3)
      tracker.subtract(1)
      tracker.add(2)
      tracker.subtract(0.5)
      expect(tracker.total()).toBe(3.5)
    })

    it("snapshot reflects subtract operations", () => {
      const tracker = new CostTracker(10)
      tracker.add(5)
      const beforeSnapshot = tracker.snapshot()
      tracker.subtract(2)
      const afterSnapshot = tracker.snapshot()

      expect(beforeSnapshot.totalCostUsd).toBe(5)
      expect(afterSnapshot.totalCostUsd).toBe(3)
    })
  })

  describe("snapshot()", () => {
    it("returns current total cost in readonly object", () => {
      const tracker = new CostTracker(10)
      tracker.add(3.5)
      tracker.add(1.5)

      const snapshot = tracker.snapshot()

      expect(snapshot.totalCostUsd).toBe(5)
      expect(tracker.total()).toBe(5) // Verify internal state unchanged
    })

    it("returns zero cost for new tracker", () => {
      const tracker = new CostTracker(10)

      const snapshot = tracker.snapshot()

      expect(snapshot.totalCostUsd).toBe(0)
    })

    it("returns readonly object that cannot be mutated", () => {
      const tracker = new CostTracker(10)
      tracker.add(2.5)

      const snapshot = tracker.snapshot()

      // Verify object is frozen
      expect(Object.isFrozen(snapshot)).toBe(true)

      // Attempt to mutate should throw in strict mode (which Vitest uses)
      expect(() => {
        // @ts-expect-error - intentionally trying to mutate readonly object
        snapshot.totalCostUsd = 999
      }).toThrow()

      // Value should remain unchanged
      expect(snapshot.totalCostUsd).toBe(2.5)
    })

    it("returns new object instance each time", () => {
      const tracker = new CostTracker(10)
      tracker.add(1)

      const snapshot1 = tracker.snapshot()
      const snapshot2 = tracker.snapshot()

      expect(snapshot1).not.toBe(snapshot2) // Different object references
      expect(snapshot1.totalCostUsd).toBe(snapshot2.totalCostUsd) // Same values
    })

    it("reflects cost changes after add() calls", () => {
      const tracker = new CostTracker(10)

      const snapshot1 = tracker.snapshot()
      expect(snapshot1.totalCostUsd).toBe(0)

      tracker.add(2.5)
      const snapshot2 = tracker.snapshot()
      expect(snapshot2.totalCostUsd).toBe(2.5)

      tracker.add(1.5)
      const snapshot3 = tracker.snapshot()
      expect(snapshot3.totalCostUsd).toBe(4)

      // Previous snapshots remain unchanged
      expect(snapshot1.totalCostUsd).toBe(0)
      expect(snapshot2.totalCostUsd).toBe(2.5)
    })

    it("reflects reset state correctly", () => {
      const tracker = new CostTracker(10)
      tracker.add(5)

      const snapshotBefore = tracker.snapshot()
      expect(snapshotBefore.totalCostUsd).toBe(5)

      tracker.reset()

      const snapshotAfter = tracker.snapshot()
      expect(snapshotAfter.totalCostUsd).toBe(0)

      // Previous snapshot unchanged
      expect(snapshotBefore.totalCostUsd).toBe(5)
    })

    it("handles fractional costs accurately", () => {
      const tracker = new CostTracker(10)
      tracker.add(1.234)
      tracker.add(2.567)

      const snapshot = tracker.snapshot()

      expect(snapshot.totalCostUsd).toBeCloseTo(3.801, 10)
    })

    it("does not mutate internal state", () => {
      const tracker = new CostTracker(10)
      tracker.add(3)

      const totalBefore = tracker.total()
      const remainingBefore = tracker.remaining()
      const exceededBefore = tracker.exceeded()

      const snapshot = tracker.snapshot()

      // Verify snapshot call didn't change internal state
      expect(tracker.total()).toBe(totalBefore)
      expect(tracker.remaining()).toBe(remainingBefore)
      expect(tracker.exceeded()).toBe(exceededBefore)
      expect(snapshot.totalCostUsd).toBe(totalBefore)
    })

    it("works correctly with zero cost", () => {
      const tracker = new CostTracker(10)
      tracker.add(0)

      const snapshot = tracker.snapshot()

      expect(snapshot.totalCostUsd).toBe(0)
    })

    it("works correctly when tracker has exceeded limit", () => {
      const tracker = new CostTracker(5)
      tracker.add(10)

      const snapshot = tracker.snapshot()

      expect(snapshot.totalCostUsd).toBe(10)
      expect(tracker.exceeded()).toBe(true) // Verify exceeded state unchanged
    })
  })

  describe("property-based", () => {
    it("total equals sum of all added costs", () => {
      fc.assert(
        fc.property(
          fc.array(fc.double({ min: 0, max: 100, noNaN: true }), { minLength: 1, maxLength: 20 }),
          (costs) => {
            const tracker = new CostTracker(1e15)
            let expectedTotal = 0
            for (const c of costs) {
              tracker.add(c)
              expectedTotal += c
            }
            return Math.abs(tracker.total() - expectedTotal) < 1e-10
          },
        ),
      )
    })

    it("remaining is always non-negative", () => {
      fc.assert(
        fc.property(
          fc.double({ min: 0, max: 1000, noNaN: true }),
          fc.array(fc.double({ min: 0, max: 100, noNaN: true }), { maxLength: 20 }),
          (limit, costs) => {
            const tracker = new CostTracker(limit)
            for (const c of costs) {
              tracker.add(c)
            }
            return tracker.remaining() >= 0
          },
        ),
      )
    })

    it("exceeded implies remaining is zero", () => {
      fc.assert(
        fc.property(
          fc.double({ min: 0, max: 100, noNaN: true }),
          fc.array(fc.double({ min: 0, max: 100, noNaN: true }), { maxLength: 20 }),
          (limit, costs) => {
            const tracker = new CostTracker(limit)
            for (const c of costs) {
              tracker.add(c)
            }
            if (tracker.exceeded()) {
              return tracker.remaining() === 0
            }
            return true
          },
        ),
      )
    })
  })

  describe("Public API Integration", () => {
    it("subtract method is accessible through @bollard/engine exports", () => {
      const tracker = new PublicCostTracker(10)
      tracker.add(5)
      tracker.subtract(2)
      expect(tracker.total()).toBe(3)

      // Verify it's the same class
      expect(tracker).toBeInstanceOf(CostTracker)
      expect(typeof tracker.subtract).toBe("function")
    })
  })

  describe("summary()", () => {
    it("formats basic summary correctly", () => {
      const tracker = new CostTracker(10.0)
      tracker.add(3.5)

      const result = tracker.summary()
      expect(result).toBe("$3.50 / $10.00 (35.0% used)")
    })

    it("formats zero total correctly", () => {
      const tracker = new CostTracker(10.0)

      const result = tracker.summary()
      expect(result).toBe("$0.00 / $10.00 (0.0% used)")
    })

    it("formats exact limit match correctly", () => {
      const tracker = new CostTracker(5.0)
      tracker.add(5.0)

      const result = tracker.summary()
      expect(result).toBe("$5.00 / $5.00 (100.0% used)")
    })

    it("shows EXCEEDED when budget is exceeded", () => {
      const tracker = new CostTracker(10.0)
      tracker.add(12.5)

      const result = tracker.summary()
      expect(result).toBe("$12.50 / $10.00 (125.0% used) [EXCEEDED]")
    })

    it("handles zero limit with zero total", () => {
      const tracker = new CostTracker(0.0)

      const result = tracker.summary()
      expect(result).toBe("$0.00 / $0.00 (0.0% used)")
    })

    it("handles zero limit with positive total", () => {
      const tracker = new CostTracker(0.0)
      tracker.add(1.0)

      const result = tracker.summary()
      expect(result).toBe("$1.00 / $0.00 (100.0% used) [EXCEEDED]")
    })

    it("formats fractional amounts to 2 decimal places", () => {
      const tracker = new CostTracker(7.123)
      tracker.add(3.456)

      const result = tracker.summary()
      expect(result).toBe("$3.46 / $7.12 (48.5% used)")
    })

    it("formats percentage to 1 decimal place", () => {
      const tracker = new CostTracker(3.0)
      tracker.add(1.0)

      const result = tracker.summary()
      expect(result).toBe("$1.00 / $3.00 (33.3% used)")
    })

    it("handles very small amounts", () => {
      const tracker = new CostTracker(0.01)
      tracker.add(0.005)

      const result = tracker.summary()
      expect(result).toBe("$0.01 / $0.01 (50.0% used)")
    })

    it("handles large amounts", () => {
      const tracker = new CostTracker(1000.0)
      tracker.add(999.99)

      const result = tracker.summary()
      expect(result).toBe("$999.99 / $1000.00 (100.0% used)")
    })

    it("shows exceeded for slightly over budget", () => {
      const tracker = new CostTracker(10.0)
      tracker.add(10.01)

      const result = tracker.summary()
      expect(result).toBe("$10.01 / $10.00 (100.1% used) [EXCEEDED]")
    })

    it("handles multiple adds before summary", () => {
      const tracker = new CostTracker(20.0)
      tracker.add(5.25)
      tracker.add(3.75)
      tracker.add(1.5)

      const result = tracker.summary()
      expect(result).toBe("$10.50 / $20.00 (52.5% used)")
    })

    it("reflects state after subtract operations", () => {
      const tracker = new CostTracker(10.0)
      tracker.add(8.0)
      tracker.subtract(3.0)

      const result = tracker.summary()
      expect(result).toBe("$5.00 / $10.00 (50.0% used)")
    })

    it("reflects state after reset", () => {
      const tracker = new CostTracker(10.0)
      tracker.add(8.0)
      tracker.reset()

      const result = tracker.summary()
      expect(result).toBe("$0.00 / $10.00 (0.0% used)")
    })

    it("handles edge case of very high percentage", () => {
      const tracker = new CostTracker(1.0)
      tracker.add(50.0)

      const result = tracker.summary()
      expect(result).toBe("$50.00 / $1.00 (5000.0% used) [EXCEEDED]")
    })
  })
})
