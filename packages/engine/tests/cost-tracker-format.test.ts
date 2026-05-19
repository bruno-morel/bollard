import { describe, expect, it } from "vitest"
import { CostTracker } from "../src/cost-tracker.js"
import { BollardError } from "../src/errors.js"

describe("CostTracker.formatCost", () => {
  it("returns '$0.00' for zero total with default decimal places", () => {
    const tracker = new CostTracker(100)
    expect(tracker.formatCost()).toBe("$0.00")
  })

  it("returns formatted dollar string with default 2 decimal places", () => {
    const tracker = new CostTracker(100)
    tracker.add(1.23)
    expect(tracker.formatCost()).toBe("$1.23")
  })

  it("returns formatted dollar string with custom decimal places", () => {
    const tracker = new CostTracker(100)
    tracker.add(1.23)
    expect(tracker.formatCost(0)).toBe("$1")
    expect(tracker.formatCost(1)).toBe("$1.2")
    expect(tracker.formatCost(3)).toBe("$1.230")
    expect(tracker.formatCost(4)).toBe("$1.2300")
  })

  it("does not modify internal state", () => {
    const tracker = new CostTracker(100)
    tracker.add(5.67)

    const initialTotal = tracker.total()
    const initialRunCount = tracker.runCount()

    // Call formatCost multiple times
    tracker.formatCost()
    tracker.formatCost(3)
    tracker.formatCost(0)

    // Verify state unchanged
    expect(tracker.total()).toBe(initialTotal)
    expect(tracker.runCount()).toBe(initialRunCount)
  })

  it("returns identical results on multiple calls", () => {
    const tracker = new CostTracker(100)
    tracker.add(2.456)

    const result1 = tracker.formatCost()
    const result2 = tracker.formatCost()
    const result3 = tracker.formatCost()

    expect(result1).toBe("$2.46")
    expect(result2).toBe("$2.46")
    expect(result3).toBe("$2.46")
    expect(result1).toBe(result2)
    expect(result2).toBe(result3)
  })

  it("works with very small decimals", () => {
    const tracker = new CostTracker(100)
    tracker.add(0.001)

    expect(tracker.formatCost()).toBe("$0.00")
    expect(tracker.formatCost(3)).toBe("$0.001")
    expect(tracker.formatCost(4)).toBe("$0.0010")
  })

  it("works with large numbers", () => {
    const tracker = new CostTracker(1000000)
    tracker.add(999999.99)

    expect(tracker.formatCost()).toBe("$999999.99")
    expect(tracker.formatCost(0)).toBe("$1000000")
    expect(tracker.formatCost(3)).toBe("$999999.990")
  })

  it("handles edge case with exactly zero decimal places", () => {
    const tracker = new CostTracker(100)
    tracker.add(1.999)

    expect(tracker.formatCost(0)).toBe("$2")
  })

  it("handles fractional cents properly", () => {
    const tracker = new CostTracker(100)
    tracker.add(1.235) // Should round to 1.24 with 2 decimal places

    expect(tracker.formatCost()).toBe("$1.24")
    expect(tracker.formatCost(3)).toBe("$1.235")
  })

  it("throws BollardError for negative decimal places", () => {
    const tracker = new CostTracker(100)

    expect(() => tracker.formatCost(-1)).toThrow(BollardError)
    expect(() => tracker.formatCost(-1)).toThrow("decimalPlaces must be a non-negative integer")
  })

  it("throws BollardError for non-integer decimal places", () => {
    const tracker = new CostTracker(100)

    expect(() => tracker.formatCost(1.5)).toThrow(BollardError)
    expect(() => tracker.formatCost(2.1)).toThrow(BollardError)
  })

  it("throws BollardError with correct error code for invalid decimal places", () => {
    const tracker = new CostTracker(100)

    try {
      tracker.formatCost(-1)
      expect.fail("Should have thrown BollardError")
    } catch (error) {
      expect(error).toBeInstanceOf(BollardError)
      expect((error as BollardError).code).toBe("CONTRACT_VIOLATION")
      expect((error as BollardError).context).toEqual({ decimalPlaces: -1 })
    }
  })

  it("works correctly after multiple operations", () => {
    const tracker = new CostTracker(100)
    tracker.add(10.5)
    tracker.add(5.25)
    tracker.subtract(2.75)

    expect(tracker.formatCost()).toBe("$13.00")
    expect(tracker.formatCost(1)).toBe("$13.0")
  })

  it("works correctly after reset", () => {
    const tracker = new CostTracker(100)
    tracker.add(50.75)
    tracker.reset()

    expect(tracker.formatCost()).toBe("$0.00")
    expect(tracker.formatCost(3)).toBe("$0.000")
  })

  it("works correctly after divide operation", () => {
    const tracker = new CostTracker(100)
    tracker.add(10)
    tracker.divide(4)

    expect(tracker.formatCost()).toBe("$2.50")
    expect(tracker.formatCost(3)).toBe("$2.500")
  })

  it("handles very high precision decimal places", () => {
    const tracker = new CostTracker(100)
    tracker.add(1.123456789)

    expect(tracker.formatCost(8)).toBe("$1.12345679")
    expect(tracker.formatCost(10)).toBe("$1.1234567890")
  })
})
