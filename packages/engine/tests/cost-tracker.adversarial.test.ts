import { describe, it, expect, vi } from "vitest"
import { CostTracker } from "../src/cost-tracker.js"
import { BollardError } from "../src/errors.js"

describe("boundary tests", () => {
it('clamps total below min to min', () => {
  const tracker = new CostTracker(100)
  tracker.add(5)
  tracker.clamp(10, 50)
  expect(tracker.total()).toBe(10)
})

it('clamps total above max to max', () => {
  const tracker = new CostTracker(100)
  tracker.add(75)
  tracker.clamp(10, 50)
  expect(tracker.total()).toBe(50)
})

it('leaves total unchanged when within range', () => {
  const tracker = new CostTracker(100)
  tracker.add(30)
  tracker.clamp(10, 50)
  expect(tracker.total()).toBe(30)
})

it('clamps total equal to min', () => {
  const tracker = new CostTracker(100)
  tracker.add(10)
  tracker.clamp(10, 50)
  expect(tracker.total()).toBe(10)
})

it('clamps total equal to max', () => {
  const tracker = new CostTracker(100)
  tracker.add(50)
  tracker.clamp(10, 50)
  expect(tracker.total()).toBe(50)
})

it('returns this for chaining', () => {
  const tracker = new CostTracker(100)
  const result = tracker.clamp(10, 50)
  expect(result).toBe(tracker)
})

it('allows method chaining after clamp', () => {
  const tracker = new CostTracker(100)
  const result = tracker.add(25).clamp(10, 50).add(5)
  expect(tracker.total()).toBe(30)
  expect(result).toBe(tracker)
})

it('throws CONTRACT_VIOLATION if min is negative', () => {
  const tracker = new CostTracker(100)
  try {
    tracker.clamp(-1, 50)
    expect.fail('should have thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(BollardError)
    expect(err.code).toBe('CONTRACT_VIOLATION')
  }
})

it('throws CONTRACT_VIOLATION if min is Infinity', () => {
  const tracker = new CostTracker(100)
  try {
    tracker.clamp(Infinity, 50)
    expect.fail('should have thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(BollardError)
    expect(err.code).toBe('CONTRACT_VIOLATION')
  }
})

it('throws CONTRACT_VIOLATION if min is -Infinity', () => {
  const tracker = new CostTracker(100)
  try {
    tracker.clamp(-Infinity, 50)
    expect.fail('should have thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(BollardError)
    expect(err.code).toBe('CONTRACT_VIOLATION')
  }
})

it('throws CONTRACT_VIOLATION if min is NaN', () => {
  const tracker = new CostTracker(100)
  try {
    tracker.clamp(NaN, 50)
    expect.fail('should have thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(BollardError)
    expect(err.code).toBe('CONTRACT_VIOLATION')
  }
})

it('throws CONTRACT_VIOLATION if min > max', () => {
  const tracker = new CostTracker(100)
  try {
    tracker.clamp(50, 10)
    expect.fail('should have thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(BollardError)
    expect(err.code).toBe('CONTRACT_VIOLATION')
  }
})

it('throws CONTRACT_VIOLATION if max is negative', () => {
  const tracker = new CostTracker(100)
  try {
    tracker.clamp(0, -1)
    expect.fail('should have thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(BollardError)
    expect(err.code).toBe('CONTRACT_VIOLATION')
  }
})

it('throws CONTRACT_VIOLATION if max is Infinity', () => {
  const tracker = new CostTracker(100)
  try {
    tracker.clamp(0, Infinity)
    expect.fail('should have thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(BollardError)
    expect(err.code).toBe('CONTRACT_VIOLATION')
  }
})

it('throws CONTRACT_VIOLATION if max is -Infinity', () => {
  const tracker = new CostTracker(100)
  try {
    tracker.clamp(0, -Infinity)
    expect.fail('should have thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(BollardError)
    expect(err.code).toBe('CONTRACT_VIOLATION')
  }
})

it('throws CONTRACT_VIOLATION if max is NaN', () => {
  const tracker = new CostTracker(100)
  try {
    tracker.clamp(0, NaN)
    expect.fail('should have thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(BollardError)
    expect(err.code).toBe('CONTRACT_VIOLATION')
  }
})

it('clamps zero total to min when min > 0', () => {
  const tracker = new CostTracker(100)
  tracker.clamp(25, 75)
  expect(tracker.total()).toBe(25)
})

it('clamps large total to max', () => {
  const tracker = new CostTracker(100)
  tracker.add(99)
  tracker.clamp(10, 50)
  expect(tracker.total()).toBe(50)
})

it('handles min equals max', () => {
  const tracker = new CostTracker(100)
  tracker.add(30)
  tracker.clamp(25, 25)
  expect(tracker.total()).toBe(25)
})

it('handles min equals zero', () => {
  const tracker = new CostTracker(100)
  tracker.clamp(0, 50)
  expect(tracker.total()).toBe(0)
})

it('rejects both min and max as Infinity', () => {
  const tracker = new CostTracker(100)
  try {
    tracker.clamp(Infinity, Infinity)
    expect.fail('should have thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(BollardError)
    expect(err.code).toBe('CONTRACT_VIOLATION')
  }
})

it('rejects min as NaN even if max is valid', () => {
  const tracker = new CostTracker(100)
  try {
    tracker.clamp(NaN, 50)
    expect.fail('should have thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(BollardError)
    expect(err.code).toBe('CONTRACT_VIOLATION')
  }
})

it('clamps with decimal min and max', () => {
  const tracker = new CostTracker(100)
  tracker.add(5.5)
  tracker.clamp(2.5, 7.5)
  expect(tracker.total()).toBe(5.5)
})

it('clamps fractional total to fractional min', () => {
  const tracker = new CostTracker(100)
  tracker.add(1.25)
  tracker.clamp(2.75, 10)
  expect(tracker.total()).toBe(2.75)
})

it('clamps fractional total to fractional max', () => {
  const tracker = new CostTracker(100)
  tracker.add(15.75)
  tracker.clamp(5.5, 10.25)
  expect(tracker.total()).toBe(10.25)
})
})
