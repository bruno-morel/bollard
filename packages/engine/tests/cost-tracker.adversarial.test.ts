import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import { CostTracker } from "../src/cost-tracker.js"

describe("Feature: CostTracker.summary() returns formatted string with total, limit, and percentage", () => {
  it("should return formatted string with total, limit, and percentage", () => {
    const tracker = new CostTracker(100.0)
    tracker.add(25.50)
    
    const result = tracker.summary()
    expect(result).toBe("$25.50 / $100.00 (25.5% used)")
  })

  it("should format dollar amounts to 2 decimal places", () => {
    const tracker = new CostTracker(50)
    tracker.add(10.1)
    
    const result = tracker.summary()
    expect(result).toBe("$10.10 / $50.00 (20.2% used)")
  })

  it("should format percentage to 1 decimal place", () => {
    const tracker = new CostTracker(3)
    tracker.add(1)
    
    const result = tracker.summary()
    expect(result).toBe("$1.00 / $3.00 (33.3% used)")
  })

  it("should handle zero total cost", () => {
    const tracker = new CostTracker(100)
    
    const result = tracker.summary()
    expect(result).toBe("$0.00 / $100.00 (0.0% used)")
  })
})

describe("Feature: When budget is exceeded, append ' [EXCEEDED]'", () => {
  it("should append [EXCEEDED] when total exceeds limit", () => {
    const tracker = new CostTracker(50.0)
    tracker.add(75.25)
    
    const result = tracker.summary()
    expect(result).toBe("$75.25 / $50.00 (150.5% used) [EXCEEDED]")
  })

  it("should not append [EXCEEDED] when total equals limit", () => {
    const tracker = new CostTracker(100.0)
    tracker.add(100.0)
    
    const result = tracker.summary()
    expect(result).toBe("$100.00 / $100.00 (100.0% used)")
  })

  it("should not append [EXCEEDED] when total is less than limit", () => {
    const tracker = new CostTracker(100.0)
    tracker.add(99.99)
    
    const result = tracker.summary()
    expect(result).toBe("$99.99 / $100.00 (100.0% used)")
  })
})

describe("Feature: Handle edge cases like zero limit correctly", () => {
  it("should show 0% when both total and limit are 0", () => {
    const tracker = new CostTracker(0)
    
    const result = tracker.summary()
    expect(result).toBe("$0.00 / $0.00 (0.0% used)")
  })

  it("should show 100% when total > 0 and limit = 0", () => {
    const tracker = new CostTracker(0)
    tracker.add(10.50)
    
    const result = tracker.summary()
    expect(result).toBe("$10.50 / $0.00 (100.0% used) [EXCEEDED]")
  })

  it("should handle very small amounts correctly", () => {
    const tracker = new CostTracker(0.01)
    tracker.add(0.005)
    
    const result = tracker.summary()
    expect(result).toBe("$0.01 / $0.01 (50.0% used)")
  })

  it("should handle negative costs from subtract operations", () => {
    const tracker = new CostTracker(100)
    tracker.add(50)
    tracker.subtract(75)
    
    const result = tracker.summary()
    expect(result).toBe("$-25.00 / $100.00 (-25.0% used)")
  })
})

describe("Property-based tests for summary formatting", () => {
  it("should always return string with correct format structure", () => {
    fc.assert(fc.property(
      fc.float({ min: 0, max: 1000 }),
      fc.float({ min: 0.01, max: 1000 }),
      (total, limit) => {
        const tracker = new CostTracker(limit)
        tracker.add(total)
        const result = tracker.summary()
        
        // Should match pattern: $X.XX / $Y.YY (Z.Z% used) [optional EXCEEDED]
        const pattern = /^\$\d+\.\d{2} \/ \$\d+\.\d{2} \(\d+\.\d% used\)( \[EXCEEDED\])?$/
        expect(result).toMatch(pattern)
      }
    ))
  })

  it("should append EXCEEDED only when total > limit", () => {
    fc.assert(fc.property(
      fc.float({ min: 0, max: 1000 }),
      fc.float({ min: 0.01, max: 1000 }),
      (total, limit) => {
        const tracker = new CostTracker(limit)
        tracker.add(total)
        const result = tracker.summary()
        
        const shouldExceed = total > limit
        const hasExceeded = result.includes("[EXCEEDED]")
        expect(hasExceeded).toBe(shouldExceed)
      }
    ))
  })

  it("should calculate percentage correctly", () => {
    fc.assert(fc.property(
      fc.float({ min: 0, max: 100 }),
      fc.float({ min: 0.01, max: 100 }),
      (total, limit) => {
        const tracker = new CostTracker(limit)
        tracker.add(total)
        const result = tracker.summary()
        
        const expectedPercentage = ((total / limit) * 100).toFixed(1)
        expect(result).toContain(`(${expectedPercentage}% used)`)
      }
    ))
  })
})