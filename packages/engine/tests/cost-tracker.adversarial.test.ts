import { describe, it, expect, vi } from "vitest"
import fc from "fast-check"
import { CostTracker } from "../src/cost-tracker.js"
import { BollardError } from "../src/errors.js"

describe("boundary tests", () => {
it('scale() multiplies total by positive finite factor', () => {
  const tracker = new CostTracker(1000)
  tracker.add(10)
  const result = tracker.scale(2)
  expect(tracker.total()).toBe(20)
  expect(result).toBe(tracker)
})

it('scale() throws CONTRACT_VIOLATION for non-positive factor', () => {
  const tracker = new CostTracker(1000)
  tracker.add(10)
  expect(() => tracker.scale(0)).toThrow()
  expect(() => tracker.scale(-1)).toThrow()
  expect(() => tracker.scale(-0.5)).toThrow()
})

it('scale() throws CONTRACT_VIOLATION for non-finite factor', () => {
  const tracker = new CostTracker(1000)
  tracker.add(10)
  expect(() => tracker.scale(Infinity)).toThrow()
  expect(() => tracker.scale(-Infinity)).toThrow()
  expect(() => tracker.scale(NaN)).toThrow()
})

it('scale() caps total at clampMax when provided and valid', () => {
  const tracker = new CostTracker(1000)
  tracker.add(50)
  tracker.scale(3, 100)
  expect(tracker.total()).toBe(100)
})

it('scale() does not cap when result is below clampMax', () => {
  const tracker = new CostTracker(1000)
  tracker.add(10)
  tracker.scale(2, 100)
  expect(tracker.total()).toBe(20)
})

it('scale() throws CONTRACT_VIOLATION for negative clampMax', () => {
  const tracker = new CostTracker(1000)
  tracker.add(10)
  expect(() => tracker.scale(2, -1)).toThrow()
  expect(() => tracker.scale(2, -0.5)).toThrow()
})

it('scale() throws CONTRACT_VIOLATION for non-finite clampMax', () => {
  const tracker = new CostTracker(1000)
  tracker.add(10)
  expect(() => tracker.scale(2, Infinity)).toThrow()
  expect(() => tracker.scale(2, -Infinity)).toThrow()
  expect(() => tracker.scale(2, NaN)).toThrow()
})

it('scale() returns this for chaining', () => {
  const tracker = new CostTracker(1000)
  tracker.add(10)
  const result = tracker.scale(2)
  expect(result).toBe(tracker)
})

it('scale() works correctly in chained calls', () => {
  const tracker = new CostTracker(1000)
  tracker.add(10)
  tracker.scale(2).scale(0.5)
  expect(tracker.total()).toBe(10)
})

it('scale() with clampMax=0 caps to zero', () => {
  const tracker = new CostTracker(1000)
  tracker.add(50)
  tracker.scale(2, 0)
  expect(tracker.total()).toBe(0)
})

it('scale() with small positive factors multiplies correctly', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 1, max: 100 }), (initial, factor) => {
      const tracker = new CostTracker(10000)
      tracker.add(initial)
      const smallFactor = factor / 1000
      tracker.scale(smallFactor)
      const expected = initial * smallFactor
      expect(Math.abs(tracker.total() - expected)).toBeLessThan(1e-9)
    })
  )
})

it('scale() with large positive factors multiplies correctly', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 100 }), fc.integer({ min: 100, max: 10000 }), (initial, factor) => {
      const tracker = new CostTracker(1000000)
      tracker.add(initial)
      tracker.scale(factor)
      expect(tracker.total()).toBe(initial * factor)
    })
  )
})

it('scale() with clampMax respects capping in chains', () => {
  const tracker = new CostTracker(1000)
  tracker.add(10)
  tracker.scale(5, 30).scale(2)
  expect(tracker.total()).toBe(60)
})

it('scale() rejects zero and negative factors', () => {
  const tracker = new CostTracker(1000)
  tracker.add(10)
  const testValues = [0, -0, -1, -100, -0.001]
  testValues.forEach(val => {
    const t = new CostTracker(1000)
    t.add(10)
    expect(() => t.scale(val)).toThrow()
  })
})

it('scale() rejects negative clampMax values', () => {
  const tracker = new CostTracker(1000)
  tracker.add(10)
  const testValues = [-1, -0.001, -100]
  testValues.forEach(val => {
    const t = new CostTracker(1000)
    t.add(10)
    expect(() => t.scale(2, val)).toThrow()
  })
})

it('scale() without clampMax does not cap', () => {
  const tracker = new CostTracker(1000)
  tracker.add(100)
  tracker.scale(5)
  expect(tracker.total()).toBe(500)
})

it('scale() modifies total in place', () => {
  const tracker = new CostTracker(1000)
  tracker.add(25)
  const originalTotal = tracker.total()
  tracker.scale(2)
  expect(tracker.total()).toBe(originalTotal * 2)
  expect(tracker.total()).toBe(50)
})

it('scale() with factor=1 preserves total', () => {
  const tracker = new CostTracker(1000)
  tracker.add(42)
  tracker.scale(1)
  expect(tracker.total()).toBe(42)
})

it('scale() with clampMax equal to scaled total does not change it', () => {
  const tracker = new CostTracker(1000)
  tracker.add(10)
  tracker.scale(2, 20)
  expect(tracker.total()).toBe(20)
})

it('scale() with clampMax less than scaled total caps to clampMax', () => {
  const tracker = new CostTracker(1000)
  tracker.add(100)
  tracker.scale(3, 200)
  expect(tracker.total()).toBe(200)
})
})
