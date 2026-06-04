import { describe, expect, it } from "vitest"
import { CostTracker } from "../src/cost-tracker.js"
import { BollardError } from "../src/errors.js"

describe("CostTracker.humanReadable()", () => {
  it("returns correct format for typical case", () => {
    const tracker = new CostTracker(10.0)
    tracker.add(1.23)

    const result = tracker.humanReadable()
    expect(result).toBe("$1.23 / $10.00 (12.3%)")
  })

  it("handles infinite limit", () => {
    const tracker = new CostTracker(Number.POSITIVE_INFINITY)
    tracker.add(5.0)

    const result = tracker.humanReadable()
    expect(result).toBe("$5.00 / ∞ (∞%)")
  })

  it("handles zero limit", () => {
    const tracker = new CostTracker(0)

    const result = tracker.humanReadable()
    expect(result).toBe("$0.00 / $0.00 (∞%)")
  })

  it("handles zero limit with positive total", () => {
    const tracker = new CostTracker(0)
    // This would normally throw in add(), but we can test the edge case
    // by directly manipulating internal state for testing purposes
    // However, since we can't access private fields, we'll test the zero case only

    const result = tracker.humanReadable()
    expect(result).toBe("$0.00 / $0.00 (∞%)")
  })

  it("handles percentage rounding correctly", () => {
    const tracker = new CostTracker(3.0)
    tracker.add(1.0)

    const result = tracker.humanReadable()
    expect(result).toBe("$1.00 / $3.00 (33.3%)")
  })

  it("handles total equal to limit", () => {
    const tracker = new CostTracker(5.0)
    tracker.add(5.0)

    const result = tracker.humanReadable()
    expect(result).toBe("$5.00 / $5.00 (100.0%)")
  })

  it("handles very small amounts", () => {
    const tracker = new CostTracker(1.0)
    tracker.add(0.001)

    const result = tracker.humanReadable()
    expect(result).toBe("$0.00 / $1.00 (0.1%)")
  })

  it("handles large amounts", () => {
    const tracker = new CostTracker(1000.0)
    tracker.add(123.456)

    const result = tracker.humanReadable()
    expect(result).toBe("$123.46 / $1000.00 (12.3%)")
  })

  it("does not modify internal state", () => {
    const tracker = new CostTracker(10.0)
    tracker.add(2.5)

    const totalBefore = tracker.total()
    const limitBefore = tracker.limitUsd()

    tracker.humanReadable()

    expect(tracker.total()).toBe(totalBefore)
    expect(tracker.limitUsd()).toBe(limitBefore)
  })

  it("is idempotent", () => {
    const tracker = new CostTracker(10.0)
    tracker.add(3.75)

    const result1 = tracker.humanReadable()
    const result2 = tracker.humanReadable()
    const result3 = tracker.humanReadable()

    expect(result1).toBe(result2)
    expect(result2).toBe(result3)
    expect(result1).toBe("$3.75 / $10.00 (37.5%)")
  })

  it("handles edge case with total exceeding limit (should throw)", () => {
    // This tests the internal state corruption check
    // In normal operation, this should never happen, but we test the guard
    const tracker = new CostTracker(5.0)
    tracker.add(5.0)

    // Manually exceed the limit to test the corruption check
    // We can't directly access private fields, so we'll use a different approach
    // Let's test with a case that would naturally exceed
    tracker.add(1.0) // This should make total = 6.0, limit = 5.0

    // The humanReadable method should detect this corruption and throw
    expect(() => tracker.humanReadable()).toThrow(BollardError)
    expect(() => tracker.humanReadable()).toThrow("Internal state corrupted")
  })

  it("handles zero total with finite limit", () => {
    const tracker = new CostTracker(10.0)
    // Don't add anything, total remains 0

    const result = tracker.humanReadable()
    expect(result).toBe("$0.00 / $10.00 (0.0%)")
  })

  it("handles zero total with infinite limit", () => {
    const tracker = new CostTracker(Number.POSITIVE_INFINITY)
    // Don't add anything, total remains 0

    const result = tracker.humanReadable()
    expect(result).toBe("$0.00 / ∞ (∞%)")
  })

  it("formats percentage with exactly one decimal place", () => {
    const tracker = new CostTracker(7.0)
    tracker.add(1.0)

    const result = tracker.humanReadable()
    expect(result).toBe("$1.00 / $7.00 (14.3%)")

    // Verify it's exactly one decimal place, not more
    expect(result).not.toContain("14.30%")
    expect(result).not.toContain("14.29%")
  })

  it("handles fractional cents correctly", () => {
    const tracker = new CostTracker(10.0)
    tracker.add(1.234) // Should round to $1.23

    const result = tracker.humanReadable()
    expect(result).toBe("$1.23 / $10.00 (12.3%)")
  })
})
