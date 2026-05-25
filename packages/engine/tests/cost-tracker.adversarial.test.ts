import { describe, it, expect, vi } from "vitest"
import { CostTracker } from "../src/cost-tracker.js"
import { BollardError } from "../src/errors.js"

describe("boundary tests", () => {
it('multiply() multiplies accumulated total in place', () => {
  const tracker = new CostTracker(1000)
  tracker.add(10)
  const initialTotal = tracker.total()
  tracker.multiply(2)
  expect(tracker.total()).toBe(initialTotal * 2)
})

it('multiply() returns this for chaining', () => {
  const tracker = new CostTracker(1000)
  tracker.add(10)
  const result = tracker.multiply(2)
  expect(result).toBe(tracker)
  expect(result === tracker).toBe(true)
})

it('multiply() throws BollardError with code CONTRACT_VIOLATION when factor <= 0', () => {
  const tracker = new CostTracker(1000)
  tracker.add(10)
  try {
    tracker.multiply(0)
    expect.fail('should have thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(BollardError)
    expect(err.code).toBe('CONTRACT_VIOLATION')
  }
})

it('multiply() throws BollardError with code CONTRACT_VIOLATION when factor is negative', () => {
  const tracker = new CostTracker(1000)
  tracker.add(10)
  try {
    tracker.multiply(-5)
    expect.fail('should have thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(BollardError)
    expect(err.code).toBe('CONTRACT_VIOLATION')
  }
})

it('multiply() throws BollardError with code CONTRACT_VIOLATION when factor is Infinity', () => {
  const tracker = new CostTracker(1000)
  tracker.add(10)
  try {
    tracker.multiply(Infinity)
    expect.fail('should have thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(BollardError)
    expect(err.code).toBe('CONTRACT_VIOLATION')
  }
})

it('multiply() throws BollardError with code CONTRACT_VIOLATION when factor is NaN', () => {
  const tracker = new CostTracker(1000)
  tracker.add(10)
  try {
    tracker.multiply(NaN)
    expect.fail('should have thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(BollardError)
    expect(err.code).toBe('CONTRACT_VIOLATION')
  }
})

it('multiply() error context includes the invalid factor value', () => {
  const tracker = new CostTracker(1000)
  tracker.add(10)
  const invalidFactor = -3
  try {
    tracker.multiply(invalidFactor)
    expect.fail('should have thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(BollardError)
    expect(err.context).toHaveProperty('factor', invalidFactor)
  }
})

it('multiply() works correctly with positive fractional factors', () => {
  const tracker = new CostTracker(1000)
  tracker.add(100)
  tracker.multiply(0.5)
  expect(tracker.total()).toBe(50)
})

it('multiply() works correctly with large positive factors', () => {
  const tracker = new CostTracker(100000)
  tracker.add(10)
  tracker.multiply(1000)
  expect(tracker.total()).toBe(10000)
})

it('multiply() works correctly with factor = 1', () => {
  const tracker = new CostTracker(1000)
  tracker.add(50)
  const initialTotal = tracker.total()
  tracker.multiply(1)
  expect(tracker.total()).toBe(initialTotal)
})

it('multiply() integrates seamlessly with other CostTracker methods in chaining scenarios', () => {
  const tracker = new CostTracker(1000)
  const result = tracker.add(10).multiply(2).add(5)
  expect(result).toBe(tracker)
  expect(tracker.total()).toBe(25)
})

it('multiply() with divide() chaining produces correct result', () => {
  const tracker = new CostTracker(1000)
  tracker.add(100).multiply(2).divide(4)
  expect(tracker.total()).toBe(50)
})

it('multiply() state mutation is verified: tracker.total() changes after multiply()', () => {
  const tracker = new CostTracker(1000)
  tracker.add(20)
  const beforeMultiply = tracker.total()
  tracker.multiply(3)
  const afterMultiply = tracker.total()
  expect(beforeMultiply).toBe(20)
  expect(afterMultiply).toBe(60)
  expect(afterMultiply).not.toBe(beforeMultiply)
})

it('multiply() rejects negative zero as invalid factor', () => {
  const tracker = new CostTracker(1000)
  tracker.add(10)
  try {
    tracker.multiply(-0)
    expect.fail('should have thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(BollardError)
    expect(err.code).toBe('CONTRACT_VIOLATION')
  }
})

it('multiply() with very small positive factor works correctly', () => {
  const tracker = new CostTracker(1000)
  tracker.add(1000)
  tracker.multiply(0.001)
  expect(tracker.total()).toBe(1)
})

it('multiply() on zero total produces zero', () => {
  const tracker = new CostTracker(1000)
  tracker.multiply(5)
  expect(tracker.total()).toBe(0)
})
})
