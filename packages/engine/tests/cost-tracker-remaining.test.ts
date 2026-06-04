import { describe, expect, it } from "vitest"
import { CostTracker } from "../src/cost-tracker.js"

describe("CostTracker.remaining()", () => {
  describe("with Infinity limit", () => {
    it("returns Infinity when limit is Infinity", () => {
      const tracker = new CostTracker(Number.POSITIVE_INFINITY)
      expect(tracker.remaining()).toBe(Number.POSITIVE_INFINITY)
    })

    it("returns Infinity even after adding costs", () => {
      const tracker = new CostTracker(Number.POSITIVE_INFINITY)
      tracker.add(100)
      tracker.add(50)
      expect(tracker.remaining()).toBe(Number.POSITIVE_INFINITY)
    })

    it("returns Infinity even with very large costs", () => {
      const tracker = new CostTracker(Number.POSITIVE_INFINITY)
      tracker.add(Number.MAX_SAFE_INTEGER)
      expect(tracker.remaining()).toBe(Number.POSITIVE_INFINITY)
    })
  })

  describe("with finite limit", () => {
    it("returns full limit when no costs added", () => {
      const tracker = new CostTracker(100)
      expect(tracker.remaining()).toBe(100)
    })

    it("returns limit minus total when total is less than limit", () => {
      const tracker = new CostTracker(100)
      tracker.add(30)
      expect(tracker.remaining()).toBe(70)
    })

    it("returns 0 when total equals limit", () => {
      const tracker = new CostTracker(100)
      tracker.add(100)
      expect(tracker.remaining()).toBe(0)
    })

    it("returns 0 when total exceeds limit", () => {
      const tracker = new CostTracker(100)
      tracker.add(150)
      expect(tracker.remaining()).toBe(0)
    })

    it("handles fractional costs correctly", () => {
      const tracker = new CostTracker(10.5)
      tracker.add(3.25)
      expect(tracker.remaining()).toBe(7.25)
    })

    it("handles zero limit", () => {
      const tracker = new CostTracker(0)
      expect(tracker.remaining()).toBe(0)

      tracker.add(5)
      expect(tracker.remaining()).toBe(0)
    })
  })

  describe("idempotency", () => {
    it("does not modify internal state when called multiple times", () => {
      const tracker = new CostTracker(100)
      tracker.add(30)

      const first = tracker.remaining()
      const second = tracker.remaining()
      const third = tracker.remaining()

      expect(first).toBe(70)
      expect(second).toBe(70)
      expect(third).toBe(70)
      expect(tracker.total()).toBe(30)
    })

    it("remains consistent with Infinity limit", () => {
      const tracker = new CostTracker(Number.POSITIVE_INFINITY)
      tracker.add(50)

      const first = tracker.remaining()
      const second = tracker.remaining()

      expect(first).toBe(Number.POSITIVE_INFINITY)
      expect(second).toBe(Number.POSITIVE_INFINITY)
      expect(tracker.total()).toBe(50)
    })
  })

  describe("edge cases", () => {
    it("handles very small positive costs", () => {
      const tracker = new CostTracker(1)
      tracker.add(0.0001)
      expect(tracker.remaining()).toBeCloseTo(0.9999, 4)
    })

    it("handles costs that barely exceed limit", () => {
      const tracker = new CostTracker(10)
      tracker.add(10.0001)
      expect(tracker.remaining()).toBe(0)
    })
  })
})
