import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { CostTracker } from "../src/cost-tracker.js"
import { BollardError } from "../src/errors.js"

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

  it("accepts adding zero cost", () => {
    const tracker = new CostTracker(10)
    tracker.add(0)
    expect(tracker.total()).toBe(0)
  })

  describe("property-based", () => {
    it("total equals sum of all added costs", () => {
      fc.assert(
        fc.property(
          fc.array(fc.double({ min: 0, max: 100, noNaN: true }), { minLength: 1, maxLength: 20 }),
          (costs) => {
            const tracker = new CostTracker(Number.POSITIVE_INFINITY)
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
})
