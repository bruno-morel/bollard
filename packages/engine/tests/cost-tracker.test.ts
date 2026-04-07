import fc from "fast-check"
import { describe, expect, it, vi } from "vitest"
import type { PipelineContext } from "../src/context.js"
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
})
