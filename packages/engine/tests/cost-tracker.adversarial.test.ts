import { describe, it, expect, vi } from "vitest"
import { CostTracker } from "../src/cost-tracker.js"

describe("boundary tests", () => {
it('returns 0 immediately after construction', () => {
  const tracker = new CostTracker(100)
  expect(tracker.runCount()).toBe(0)
})

it('increments by 1 on each add() call', () => {
  const tracker = new CostTracker(100)
  expect(tracker.runCount()).toBe(0)
  tracker.add(10)
  expect(tracker.runCount()).toBe(1)
  tracker.add(5)
  expect(tracker.runCount()).toBe(2)
  tracker.add(3)
  expect(tracker.runCount()).toBe(3)
})

it('resets to 0 when reset() is called', () => {
  const tracker = new CostTracker(100)
  tracker.add(10)
  tracker.add(5)
  expect(tracker.runCount()).toBe(2)
  tracker.reset()
  expect(tracker.runCount()).toBe(0)
})

it('returns correct count after multiple cycles', () => {
  const tracker = new CostTracker(100)
  tracker.add(10)
  tracker.add(5)
  expect(tracker.runCount()).toBe(2)
  tracker.reset()
  expect(tracker.runCount()).toBe(0)
  tracker.add(3)
  tracker.add(7)
  tracker.add(2)
  expect(tracker.runCount()).toBe(3)
  tracker.reset()
  expect(tracker.runCount()).toBe(0)
  tracker.add(1)
  expect(tracker.runCount()).toBe(1)
})

it('is idempotent across repeated calls', () => {
  const tracker = new CostTracker(100)
  tracker.add(10)
  tracker.add(5)
  const count1 = tracker.runCount()
  const count2 = tracker.runCount()
  const count3 = tracker.runCount()
  expect(count1).toBe(2)
  expect(count2).toBe(2)
  expect(count3).toBe(2)
})

it('add() returns this for chaining while incrementing runCount', () => {
  const tracker = new CostTracker(100)
  const result = tracker.add(10).add(5).add(3)
  expect(result).toBe(tracker)
  expect(tracker.runCount()).toBe(3)
})

it('does not increment on invalid add() calls', () => {
  const tracker = new CostTracker(100)
  tracker.add(10)
  expect(tracker.runCount()).toBe(1)
  try {
    tracker.add(-5)
  } catch (e) {
    // expected to throw on negative
  }
  expect(tracker.runCount()).toBe(1)
})

it('reset() returns previous total and resets runCount', () => {
  const tracker = new CostTracker(100)
  tracker.add(10)
  tracker.add(5)
  tracker.add(3)
  expect(tracker.runCount()).toBe(3)
  const prevTotal = tracker.total()
  const returned = tracker.reset()
  expect(returned).toBe(prevTotal)
  expect(tracker.runCount()).toBe(0)
})

it('runCount() accepts no parameters and returns number', () => {
  const tracker = new CostTracker(100)
  tracker.add(10)
  const result = tracker.runCount()
  expect(typeof result).toBe('number')
  expect(result).toBe(1)
})

it('increments correctly with many add() calls', () => {
  const tracker = new CostTracker(10000)
  for (let i = 0; i < 100; i++) {
    tracker.add(1)
  }
  expect(tracker.runCount()).toBe(100)
})

it('tracks independent instances separately', () => {
  const tracker1 = new CostTracker(100)
  const tracker2 = new CostTracker(100)
  tracker1.add(10)
  tracker1.add(5)
  tracker2.add(3)
  expect(tracker1.runCount()).toBe(2)
  expect(tracker2.runCount()).toBe(1)
  tracker1.reset()
  expect(tracker1.runCount()).toBe(0)
  expect(tracker2.runCount()).toBe(1)
})
})
