import { describe, it, expect, vi } from "vitest"
import { CostTracker } from "@bollard/engine/src/cost-tracker.js"

describe("boundary tests", () => {
it('returns true when constructed with Infinity', () => {
  const tracker = new CostTracker(Number.POSITIVE_INFINITY)
  expect(tracker.isUnlimited()).toBe(true)
})

it('returns false when constructed with finite positive number', () => {
  const tracker = new CostTracker(100.50)
  expect(tracker.isUnlimited()).toBe(false)
})

it('returns false when constructed with 0', () => {
  const tracker = new CostTracker(0)
  expect(tracker.isUnlimited()).toBe(false)
})

it('is idempotent and does not modify state', () => {
  const tracker = new CostTracker(Number.POSITIVE_INFINITY)
  const result1 = tracker.isUnlimited()
  const result2 = tracker.isUnlimited()
  const result3 = tracker.isUnlimited()
  expect(result1).toBe(true)
  expect(result2).toBe(true)
  expect(result3).toBe(true)
  expect(tracker.total()).toBe(0)
  expect(tracker.limitUsd()).toBe(Number.POSITIVE_INFINITY)
})

it('returns false for various finite limits', () => {
  const limits = [0, 0.01, 1, 10, 100, 1000, Number.MAX_SAFE_INTEGER]
  limits.forEach(limit => {
    const tracker = new CostTracker(limit)
    expect(tracker.isUnlimited()).toBe(false)
  })
})

it('returns a boolean type', () => {
  const trackerUnlimited = new CostTracker(Number.POSITIVE_INFINITY)
  const trackerLimited = new CostTracker(50)
  expect(typeof trackerUnlimited.isUnlimited()).toBe('boolean')
  expect(typeof trackerLimited.isUnlimited()).toBe('boolean')
})

it('does not affect subsequent tracker operations', () => {
  const tracker = new CostTracker(100)
  tracker.isUnlimited()
  tracker.add(25)
  expect(tracker.total()).toBe(25)
  tracker.isUnlimited()
  tracker.add(30)
  expect(tracker.total()).toBe(55)
  expect(tracker.isUnlimited()).toBe(false)
})
})
