import { describe, it, expect, vi } from "vitest"
import { CostTracker } from "../src/cost-tracker.js"
import { BollardError } from "../src/errors.js"

describe("boundary tests", () => {
it('divide method exists with correct signature', () => {
  const tracker = new CostTracker(100)
  expect(typeof tracker.divide).toBe('function')
  const result = tracker.divide(2)
  expect(result).toBeInstanceOf(CostTracker)
})

it('divides total by divisor', () => {
  const tracker = new CostTracker(100)
  tracker.add(20)
  tracker.divide(2)
  expect(tracker.total()).toBe(10)
})

it('returns this for chaining', () => {
  const tracker = new CostTracker(100)
  const result = tracker.divide(2)
  expect(result).toBe(tracker)
})

it('throws COST_LIMIT_EXCEEDED when divisor is 0', () => {
  const tracker = new CostTracker(100)
  tracker.add(10)
  try {
    tracker.divide(0)
    expect.fail('should have thrown')
  } catch (err) {
    expect(BollardError.hasCode(err, 'COST_LIMIT_EXCEEDED')).toBe(true)
  }
})

it('throws COST_LIMIT_EXCEEDED when divisor is negative', () => {
  const tracker = new CostTracker(100)
  tracker.add(10)
  try {
    tracker.divide(-5)
    expect.fail('should have thrown')
  } catch (err) {
    expect(BollardError.hasCode(err, 'COST_LIMIT_EXCEEDED')).toBe(true)
  }
})

it('throws COST_LIMIT_EXCEEDED when divisor is NaN', () => {
  const tracker = new CostTracker(100)
  tracker.add(10)
  try {
    tracker.divide(NaN)
    expect.fail('should have thrown')
  } catch (err) {
    expect(BollardError.hasCode(err, 'COST_LIMIT_EXCEEDED')).toBe(true)
  }
})

it('throws COST_LIMIT_EXCEEDED when divisor is Infinity', () => {
  const tracker = new CostTracker(100)
  tracker.add(10)
  try {
    tracker.divide(Infinity)
    expect.fail('should have thrown')
  } catch (err) {
    expect(BollardError.hasCode(err, 'COST_LIMIT_EXCEEDED')).toBe(true)
  }
})

it('handles fractional divisors correctly', () => {
  const tracker = new CostTracker(100)
  tracker.add(10)
  tracker.divide(0.5)
  expect(tracker.total()).toBe(20)
})

it('supports method chaining with multiple operations', () => {
  const tracker = new CostTracker(100)
  const result = tracker.add(10).divide(2).add(5).divide(3)
  expect(typeof result).toBe('object')
  expect(result).toBeInstanceOf(CostTracker)
  expect(tracker.total()).toBeCloseTo((10 / 2 + 5) / 3, 5)
})

it('preserves limit and affects exceeded/remaining only via new total', () => {
  const tracker = new CostTracker(50)
  tracker.add(40)
  const remainingBefore = tracker.remaining()
  tracker.divide(2)
  const remainingAfter = tracker.remaining()
  expect(remainingAfter).toBeGreaterThan(remainingBefore)
  expect(tracker.total()).toBe(20)
})

it('divide(1) leaves total unchanged', () => {
  const tracker = new CostTracker(100)
  tracker.add(25)
  const totalBefore = tracker.total()
  tracker.divide(1)
  expect(tracker.total()).toBe(totalBefore)
})

it('handles very small positive divisors', () => {
  const tracker = new CostTracker(10000)
  tracker.add(1)
  tracker.divide(0.001)
  expect(tracker.total()).toBe(1000)
})

it('error context contains invalid divisor', () => {
  const tracker = new CostTracker(100)
  tracker.add(10)
  try {
    tracker.divide(-3)
    expect.fail('should have thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(BollardError)
    expect(err.context).toBeDefined()
    expect(err.context.divisor).toBe(-3)
  }
})

it('divide with zero total returns zero', () => {
  const tracker = new CostTracker(100)
  tracker.divide(5)
  expect(tracker.total()).toBe(0)
})

it('divide with negative divisor throws before modifying total', () => {
  const tracker = new CostTracker(100)
  tracker.add(30)
  const totalBefore = tracker.total()
  try {
    tracker.divide(-2)
    expect.fail('should have thrown')
  } catch (err) {
    expect(BollardError.hasCode(err, 'COST_LIMIT_EXCEEDED')).toBe(true)
    expect(tracker.total()).toBe(totalBefore)
  }
})
})
