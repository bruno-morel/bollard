import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import { CostTracker } from "../src/cost-tracker.js"

describe("Feature: snapshot() returns readonly cost snapshot", () => {
  it("should return current accumulated cost", () => {
    const tracker = new CostTracker(100)
    tracker.add(25.50)
    tracker.add(10.25)
    
    const snapshot = tracker.snapshot()
    
    expect(snapshot.totalCostUsd).toBe(35.75)
  })

  it("should return exact match with total() method", () => {
    const tracker = new CostTracker(100)
    tracker.add(42.33)
    
    const snapshot = tracker.snapshot()
    
    expect(snapshot.totalCostUsd).toBe(tracker.total())
  })

  it("should return new object each time", () => {
    const tracker = new CostTracker(100)
    tracker.add(10)
    
    const snapshot1 = tracker.snapshot()
    const snapshot2 = tracker.snapshot()
    
    expect(snapshot1).not.toBe(snapshot2)
    expect(snapshot1.totalCostUsd).toBe(snapshot2.totalCostUsd)
  })

  it("should not mutate internal state", () => {
    const tracker = new CostTracker(100)
    tracker.add(15.75)
    
    const totalBefore = tracker.total()
    tracker.snapshot()
    const totalAfter = tracker.total()
    
    expect(totalBefore).toBe(totalAfter)
  })

  it("should reflect current cost after add() calls", () => {
    const tracker = new CostTracker(100)
    
    let snapshot = tracker.snapshot()
    expect(snapshot.totalCostUsd).toBe(0)
    
    tracker.add(20)
    snapshot = tracker.snapshot()
    expect(snapshot.totalCostUsd).toBe(20)
    
    tracker.add(30.50)
    snapshot = tracker.snapshot()
    expect(snapshot.totalCostUsd).toBe(50.50)
  })

  it("should return readonly object that cannot be mutated", () => {
    const tracker = new CostTracker(100)
    tracker.add(25)
    
    const snapshot = tracker.snapshot()
    
    // TypeScript should prevent this at compile time, but test runtime behavior
    expect(() => {
      // @ts-expect-error - testing runtime immutability
      snapshot.totalCostUsd = 999
    }).toThrow()
  })

  it("should work with zero cost", () => {
    const tracker = new CostTracker(100)
    
    const snapshot = tracker.snapshot()
    
    expect(snapshot.totalCostUsd).toBe(0)
  })

  it("should work after reset", () => {
    const tracker = new CostTracker(100)
    tracker.add(50)
    tracker.reset()
    
    const snapshot = tracker.snapshot()
    
    expect(snapshot.totalCostUsd).toBe(0)
  })
})

describe("Feature: snapshot() property-based behavior", () => {
  it("should always return non-negative totalCostUsd", () => {
    fc.assert(fc.property(
      fc.float({ min: 0, max: 1000 }),
      fc.array(fc.float({ min: 0, max: 100 }), { minLength: 0, maxLength: 10 }),
      (limit, costs) => {
        const tracker = new CostTracker(limit)
        costs.forEach(cost => tracker.add(cost))
        
        const snapshot = tracker.snapshot()
        
        expect(snapshot.totalCostUsd).toBeGreaterThanOrEqual(0)
      }
    ))
  })

  it("should maintain consistency with total() across operations", () => {
    fc.assert(fc.property(
      fc.float({ min: 100, max: 1000 }),
      fc.array(fc.float({ min: 0, max: 50 }), { minLength: 1, maxLength: 5 }),
      (limit, costs) => {
        const tracker = new CostTracker(limit)
        
        costs.forEach(cost => {
          tracker.add(cost)
          const snapshot = tracker.snapshot()
          expect(snapshot.totalCostUsd).toBe(tracker.total())
        })
      }
    ))
  })
})