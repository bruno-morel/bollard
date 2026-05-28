import { describe, it, expect, vi } from "vitest"
import { CostTracker } from "@bollard/engine/src/cost-tracker.js"

describe("boundary tests", () => {
it('reset() returns undefined', () => {
  const tracker = new CostTracker(100)
  tracker.add(50)
  const result = tracker.reset()
  expect(result).toBeUndefined()
})

it('reset() sets total to 0', () => {
  const tracker = new CostTracker(100)
  tracker.add(50)
  expect(tracker.total()).toBe(50)
  tracker.reset()
  expect(tracker.total()).toBe(0)
})

it('reset() clears runCount to 0', () => {
  const tracker = new CostTracker(100)
  tracker.add(10)
  tracker.add(20)
  expect(tracker.runCount()).toBeGreaterThan(0)
  tracker.reset()
  expect(tracker.runCount()).toBe(0)
})

it('reset() restores remaining budget to original limit', () => {
  const limit = 100
  const tracker = new CostTracker(limit)
  tracker.add(60)
  expect(tracker.remaining()).toBe(40)
  tracker.reset()
  expect(tracker.remaining()).toBe(limit)
})

it('reset() clears exceeded state', () => {
  const tracker = new CostTracker(50)
  tracker.add(60)
  expect(tracker.exceeded()).toBe(true)
  tracker.reset()
  expect(tracker.exceeded()).toBe(false)
})

it('reset() works with zero limit', () => {
  const tracker = new CostTracker(0)
  tracker.add(0)
  tracker.reset()
  expect(tracker.total()).toBe(0)
  expect(tracker.remaining()).toBe(0)
  expect(tracker.runCount()).toBe(0)
})

it('reset() works with large limit values', () => {
  const largeLimit = 1000000
  const tracker = new CostTracker(largeLimit)
  tracker.add(500000)
  expect(tracker.total()).toBe(500000)
  tracker.reset()
  expect(tracker.total()).toBe(0)
  expect(tracker.remaining()).toBe(largeLimit)
})

it('reset() is callable multiple times safely', () => {
  const tracker = new CostTracker(100)
  tracker.add(50)
  tracker.reset()
  expect(tracker.total()).toBe(0)
  tracker.add(30)
  tracker.reset()
  expect(tracker.total()).toBe(0)
  tracker.reset()
  expect(tracker.total()).toBe(0)
})

it('reset() after multiple add operations', () => {
  const tracker = new CostTracker(100)
  tracker.add(10)
  tracker.add(20)
  tracker.add(30)
  expect(tracker.total()).toBe(60)
  expect(tracker.runCount()).toBeGreaterThan(0)
  tracker.reset()
  expect(tracker.total()).toBe(0)
  expect(tracker.runCount()).toBe(0)
  expect(tracker.remaining()).toBe(100)
})

it('reset() on exceeded tracker', () => {
  const tracker = new CostTracker(50)
  tracker.add(75)
  expect(tracker.exceeded()).toBe(true)
  expect(tracker.total()).toBe(75)
  tracker.reset()
  expect(tracker.exceeded()).toBe(false)
  expect(tracker.total()).toBe(0)
  expect(tracker.remaining()).toBe(50)
})

it('reset() preserves original limit', () => {
  const originalLimit = 250
  const tracker = new CostTracker(originalLimit)
  tracker.add(100)
  tracker.reset()
  expect(tracker.limitUsd()).toBe(originalLimit)
})

it('reset() with positive limit values', () => {
  const tracker = new CostTracker(75.50)
  tracker.add(25.25)
  tracker.reset()
  expect(tracker.total()).toBe(0)
  expect(tracker.remaining()).toBe(75.50)
  expect(tracker.exceeded()).toBe(false)
})
})
