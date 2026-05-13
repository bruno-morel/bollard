import { CostTracker } from "@bollard/engine/src/cost-tracker.js"
import { BollardError } from "@bollard/engine/src/errors.js"
import { describe, expect, it, vi } from "vitest"

describe("contract tests", () => {
  it("divide returns this for method chaining", () => {
    const tracker = new CostTracker(100)
    const result = tracker.divide(2)
    expect(result).toBe(tracker)
  })

  it("divide throws COST_LIMIT_EXCEEDED when divisor is zero", () => {
    const tracker = new CostTracker(100)
    tracker.add(10)
    try {
      tracker.divide(0)
      expect.fail("should have thrown")
    } catch (err) {
      expect(BollardError.hasCode(err, "COST_LIMIT_EXCEEDED")).toBe(true)
    }
  })

  it("divide throws COST_LIMIT_EXCEEDED when divisor is negative", () => {
    const tracker = new CostTracker(100)
    tracker.add(10)
    try {
      tracker.divide(-5)
      expect.fail("should have thrown")
    } catch (err) {
      expect(BollardError.hasCode(err, "COST_LIMIT_EXCEEDED")).toBe(true)
    }
  })

  it("divide updates total correctly with positive divisor", () => {
    const tracker = new CostTracker(100)
    tracker.add(10)
    tracker.divide(2)
    expect(tracker.total()).toBe(5)
  })

  it("divide with fractional divisor 0.5 doubles the cost", () => {
    const tracker = new CostTracker(100)
    tracker.add(10)
    tracker.divide(0.5)
    expect(tracker.total()).toBe(20)
  })

  it("divide preserves limit and updates exceeded() based on new total", () => {
    const tracker = new CostTracker(10)
    tracker.add(8)
    expect(tracker.exceeded()).toBe(false)
    tracker.divide(2)
    expect(tracker.total()).toBe(4)
    expect(tracker.exceeded()).toBe(false)
    expect(tracker.remaining()).toBe(6)
  })

  it("divide throws COST_LIMIT_EXCEEDED when divisor is NaN", () => {
    const tracker = new CostTracker(100)
    tracker.add(10)
    try {
      tracker.divide(Number.NaN)
      expect.fail("should have thrown")
    } catch (err) {
      expect(BollardError.hasCode(err, "COST_LIMIT_EXCEEDED")).toBe(true)
    }
  })

  it("divide throws COST_LIMIT_EXCEEDED when divisor is Infinity", () => {
    const tracker = new CostTracker(100)
    tracker.add(10)
    try {
      tracker.divide(Number.POSITIVE_INFINITY)
      expect.fail("should have thrown")
    } catch (err) {
      expect(BollardError.hasCode(err, "COST_LIMIT_EXCEEDED")).toBe(true)
    }
  })

  it("divide works with method chaining", () => {
    const tracker = new CostTracker(100)
    const result = tracker.add(10).divide(2).total()
    expect(result).toBe(5)
  })

  it("divide error propagates correctly when called from PipelineContext", () => {
    const tracker = new CostTracker(100)
    tracker.add(50)
    let caughtError: unknown
    try {
      tracker.divide(0)
    } catch (err) {
      caughtError = err
    }
    expect(caughtError).toBeDefined()
    expect(BollardError.is(caughtError)).toBe(true)
    if (BollardError.is(caughtError)) {
      expect(caughtError.code).toBe("COST_LIMIT_EXCEEDED")
    }
  })
})
