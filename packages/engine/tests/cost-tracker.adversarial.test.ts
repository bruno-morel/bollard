import { describe, it, expect, vi } from "vitest"
import { CostTracker } from "../src/cost-tracker.js"
import { BollardError } from "../src/errors.js"

describe("boundary tests", () => {
it('cap() method exists on CostTracker', () => {
  const tracker = new CostTracker(100)
  expect(typeof tracker.cap).toBe('function')
})

it('cap() sets total to maxUsd when total exceeds maxUsd', () => {
  const tracker = new CostTracker(100)
  tracker.add(80)
  tracker.cap(50)
  expect(tracker.total()).toBe(50)
})

it('cap() does not modify total when total <= maxUsd', () => {
  const tracker = new CostTracker(100)
  tracker.add(30)
  tracker.cap(50)
  expect(tracker.total()).toBe(30)
})

it('cap() returns this for chaining', () => {
  const tracker = new CostTracker(100)
  const result = tracker.cap(50)
  expect(result).toBe(tracker)
})

it('cap() enables chaining with add()', () => {
  const tracker = new CostTracker(100)
  tracker.add(30).cap(50).add(10)
  expect(tracker.total()).toBe(60)
})

it('cap() throws CONTRACT_VIOLATION for non-finite maxUsd', () => {
  const tracker = new CostTracker(100)
  try {
    tracker.cap(Infinity)
    expect.fail('should have thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(BollardError)
    expect(err.code).toBe('CONTRACT_VIOLATION')
  }
})

it('cap() accepts maxUsd = 0', () => {
  const tracker = new CostTracker(100)
  tracker.add(50)
  tracker.cap(0)
  expect(tracker.total()).toBe(0)
})

it('cap(0) sets total to 0 when total > 0', () => {
  const tracker = new CostTracker(100)
  tracker.add(25)
  tracker.cap(0)
  expect(tracker.total()).toBe(0)
})

it('cap(0) does not modify total when total is already 0', () => {
  const tracker = new CostTracker(100)
  tracker.cap(0)
  expect(tracker.total()).toBe(0)
})

it('cap() does not modify total when total equals maxUsd', () => {
  const tracker = new CostTracker(100)
  tracker.add(50)
  tracker.cap(50)
  expect(tracker.total()).toBe(50)
})

it('cap() throws CONTRACT_VIOLATION for Infinity', () => {
  const tracker = new CostTracker(100)
  try {
    tracker.cap(Infinity)
    expect.fail('should have thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(BollardError)
    expect(err.code).toBe('CONTRACT_VIOLATION')
  }
})

it('cap() throws CONTRACT_VIOLATION for -Infinity', () => {
  const tracker = new CostTracker(100)
  try {
    tracker.cap(-Infinity)
    expect.fail('should have thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(BollardError)
    expect(err.code).toBe('CONTRACT_VIOLATION')
  }
})

it('cap() works with decimal maxUsd', () => {
  const tracker = new CostTracker(100)
  tracker.add(75.5)
  tracker.cap(50.25)
  expect(tracker.total()).toBe(50.25)
})

it('cap() works with very small positive maxUsd', () => {
  const tracker = new CostTracker(100)
  tracker.add(10)
  tracker.cap(0.001)
  expect(tracker.total()).toBe(0.001)
})

it('cap() does not modify total when total is much smaller than maxUsd', () => {
  const tracker = new CostTracker(1000)
  tracker.add(5)
  tracker.cap(999999)
  expect(tracker.total()).toBe(5)
})

it('cap() multiple sequential calls work correctly', () => {
  const tracker = new CostTracker(100)
  tracker.add(80)
  tracker.cap(60)
  expect(tracker.total()).toBe(60)
  tracker.cap(40)
  expect(tracker.total()).toBe(40)
})
})
