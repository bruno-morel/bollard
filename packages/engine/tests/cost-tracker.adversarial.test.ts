import { describe, expect, it } from "vitest"
import { CostTracker } from "../src/cost-tracker.js"

describe("boundary tests", () => {
it('returns true when remaining() is Infinity', () => {
  const tracker = new CostTracker(Infinity)
  expect(tracker.available()).toBe(true)
})

it('returns true when remaining() > 0', () => {
  const tracker = new CostTracker(100)
  tracker.add(30)
  expect(tracker.remaining()).toBeGreaterThan(0)
  expect(tracker.available()).toBe(true)
})

it('returns false when remaining() === 0', () => {
  const tracker = new CostTracker(50)
  tracker.add(50)
  expect(tracker.remaining()).toBe(0)
  expect(tracker.available()).toBe(false)
})

it('returns a boolean primitive type', () => {
  const tracker = new CostTracker(100)
  const result = tracker.available()
  expect(typeof result).toBe('boolean')
  expect(result === true || result === false).toBe(true)
})

it('does not modify internal state', () => {
  const tracker = new CostTracker(100)
  tracker.add(25)
  const totalBefore = tracker.total()
  const limitBefore = tracker.limitUsd()
  const runCountBefore = tracker.runCount()
  const remainingBefore = tracker.remaining()
  
  tracker.available()
  
  expect(tracker.total()).toBe(totalBefore)
  expect(tracker.limitUsd()).toBe(limitBefore)
  expect(tracker.runCount()).toBe(runCountBefore)
  expect(tracker.remaining()).toBe(remainingBefore)
})

it('is idempotent across multiple calls', () => {
  const tracker = new CostTracker(100)
  tracker.add(50)
  const result1 = tracker.available()
  const result2 = tracker.available()
  const result3 = tracker.available()
  expect(result1).toBe(result2)
  expect(result2).toBe(result3)
})

it('does not throw errors on valid tracker states', () => {
  const tracker1 = new CostTracker(100)
  expect(() => tracker1.available()).not.toThrow()
  
  const tracker2 = new CostTracker(Infinity)
  expect(() => tracker2.available()).not.toThrow()
  
  const tracker3 = new CostTracker(50)
  tracker3.add(50)
  expect(() => tracker3.available()).not.toThrow()
})

it('handles Infinity limit scenario correctly', () => {
  const tracker = new CostTracker(Infinity)
  tracker.add(1000000)
  expect(tracker.remaining()).toBe(Infinity)
  expect(tracker.available()).toBe(true)
})

it('handles finite limit scenario correctly', () => {
  const tracker = new CostTracker(1000)
  tracker.add(500)
  expect(tracker.remaining()).toBeLessThan(Infinity)
  expect(tracker.remaining()).toBeGreaterThan(0)
  expect(tracker.available()).toBe(true)
})

it('returns correct boolean after reset', () => {
  const tracker = new CostTracker(100)
  tracker.add(100)
  expect(tracker.available()).toBe(false)
  tracker.reset()
  expect(tracker.available()).toBe(true)
})

it('returns correct boolean after subtract', () => {
  const tracker = new CostTracker(100)
  tracker.add(100)
  expect(tracker.available()).toBe(false)
  tracker.subtract(50)
  expect(tracker.available()).toBe(true)
})
})
