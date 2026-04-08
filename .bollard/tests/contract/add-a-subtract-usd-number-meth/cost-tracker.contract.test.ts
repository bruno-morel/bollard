import { CostTracker } from "@bollard/engine/src/cost-tracker.js"
import { BollardError } from "@bollard/engine/src/errors.js"
import { describe, expect, it, vi } from "vitest"

describe("contract tests", () => {
  it("subtract throws CONTRACT_VIOLATION for negative input", () => {
    const tracker = new CostTracker(100)
    tracker.add(50)

    expect(() => tracker.subtract(-10)).toThrow(BollardError)

    try {
      tracker.subtract(-10)
    } catch (err) {
      expect(BollardError.hasCode(err, "CONTRACT_VIOLATION")).toBe(true)
    }
  })

  it("subtract throws CONTRACT_VIOLATION when result would go below zero", () => {
    const tracker = new CostTracker(100)
    tracker.add(30)

    expect(() => tracker.subtract(50)).toThrow(BollardError)

    try {
      tracker.subtract(50)
    } catch (err) {
      expect(BollardError.hasCode(err, "CONTRACT_VIOLATION")).toBe(true)
    }
  })

  it("subtract reduces accumulated cost correctly", () => {
    const tracker = new CostTracker(100)
    tracker.add(50)
    tracker.subtract(20)

    expect(tracker.total()).toBe(30)
  })

  it("subtract maintains consistency with snapshot", () => {
    const tracker = new CostTracker(100)
    tracker.add(75)
    tracker.subtract(25)

    const snap = tracker.snapshot()
    expect(snap.totalCostUsd).toBe(50)
    expect(tracker.total()).toBe(snap.totalCostUsd)
  })

  it("subtract affects remaining calculation", () => {
    const tracker = new CostTracker(100)
    tracker.add(60)
    expect(tracker.remaining()).toBe(40)

    tracker.subtract(10)
    expect(tracker.remaining()).toBe(50)
  })
})
