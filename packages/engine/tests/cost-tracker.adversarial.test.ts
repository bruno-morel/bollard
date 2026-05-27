import { describe, it, expect, vi } from "vitest"
import { CostTracker } from "../src/cost-tracker.js"

describe("boundary tests", () => {
it('returns correct percentage for normal case', () => {
  const tracker = new CostTracker(100)
  tracker.add(25)
  expect(tracker.percentUsed()).toBe(25)
})

it('returns correct percentage when total equals limit', () => {
  const tracker = new CostTracker(50)
  tracker.add(50)
  expect(tracker.percentUsed()).toBe(100)
})

it('returns correct percentage for fractional values', () => {
  const tracker = new CostTracker(200)
  tracker.add(50)
  expect(tracker.percentUsed()).toBe(25)
})

it('returns 0 when limit and total are both 0', () => {
  const tracker = new CostTracker(0)
  expect(tracker.percentUsed()).toBe(0)
})

it('returns 100 when limit is 0 and total is positive', () => {
  const tracker = new CostTracker(0)
  tracker.add(10)
  expect(tracker.percentUsed()).toBe(100)
})

it('returns 100 when limit is 0 and total is large', () => {
  const tracker = new CostTracker(0)
  tracker.add(1000)
  expect(tracker.percentUsed()).toBe(100)
})

it('clamps result to [0, 100] when total exceeds limit', () => {
  const tracker = new CostTracker(10)
  tracker.add(100)
  const result = tracker.percentUsed()
  expect(result).toBeLessThanOrEqual(100)
  expect(result).toBeGreaterThanOrEqual(0)
  expect(Number.isNaN(result)).toBe(false)
  expect(Number.isFinite(result)).toBe(true)
})

it('returns valid number for zero total', () => {
  const tracker = new CostTracker(100)
  const result = tracker.percentUsed()
  expect(result).toBe(0)
  expect(Number.isNaN(result)).toBe(false)
  expect(Number.isFinite(result)).toBe(true)
})

it('never returns NaN or Infinity', () => {
  const tracker = new CostTracker(0)
  tracker.add(0)
  const result = tracker.percentUsed()
  expect(Number.isNaN(result)).toBe(false)
  expect(Number.isFinite(result)).toBe(true)
})

it('does not throw for any valid state', () => {
  const tracker = new CostTracker(100)
  expect(() => tracker.percentUsed()).not.toThrow()
})

it('does not throw when limit is 0 and total is 0', () => {
  const tracker = new CostTracker(0)
  expect(() => tracker.percentUsed()).not.toThrow()
})

it('does not throw when limit is 0 and total is positive', () => {
  const tracker = new CostTracker(0)
  tracker.add(50)
  expect(() => tracker.percentUsed()).not.toThrow()
})

it('returns same value on repeated calls', () => {
  const tracker = new CostTracker(100)
  tracker.add(50)
  const first = tracker.percentUsed()
  const second = tracker.percentUsed()
  const third = tracker.percentUsed()
  expect(first).toBe(second)
  expect(second).toBe(third)
})

it('is idempotent for zero-limit case', () => {
  const tracker = new CostTracker(0)
  tracker.add(25)
  const first = tracker.percentUsed()
  const second = tracker.percentUsed()
  expect(first).toBe(second)
  expect(first).toBe(100)
})

it('does not modify internal state', () => {
  const tracker = new CostTracker(100)
  tracker.add(30)
  const peekBefore = tracker.peek()
  tracker.percentUsed()
  const peekAfter = tracker.peek()
  expect(peekBefore).toBe(peekAfter)
})

it('does not modify total() after calling percentUsed()', () => {
  const tracker = new CostTracker(50)
  tracker.add(25)
  const totalBefore = tracker.total()
  tracker.percentUsed()
  const totalAfter = tracker.total()
  expect(totalBefore).toBe(totalAfter)
})

it('does not modify limitUsd() after calling percentUsed()', () => {
  const tracker = new CostTracker(75)
  const limitBefore = tracker.limitUsd()
  tracker.percentUsed()
  const limitAfter = tracker.limitUsd()
  expect(limitBefore).toBe(limitAfter)
})

it('returns small percentage for tiny cost relative to large limit', () => {
  const tracker = new CostTracker(1000000)
  tracker.add(0.01)
  const result = tracker.percentUsed()
  expect(result).toBeGreaterThan(0)
  expect(result).toBeLessThan(1)
  expect(result).toBeCloseTo(0.000001, 8)
})

it('returns correct percentage after subtraction', () => {
  const tracker = new CostTracker(100)
  tracker.add(80)
  tracker.subtract(30)
  expect(tracker.percentUsed()).toBe(50)
})

it('returns 0 when total is 0 with positive limit', () => {
  const tracker = new CostTracker(100)
  expect(tracker.percentUsed()).toBe(0)
})

it('returns 0 when total is 0 with large limit', () => {
  const tracker = new CostTracker(999999)
  expect(tracker.percentUsed()).toBe(0)
})
})
