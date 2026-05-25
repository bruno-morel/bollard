import { describe, it, expect, vi } from "vitest"
import { CostTracker } from "../src/cost-tracker.js"

describe("boundary tests", () => {
it('toJSON returns object with three number properties', () => {
  const tracker = new CostTracker(100)
  tracker.add(25)
  const result = tracker.toJSON()
  expect(result).toHaveProperty('totalCostUsd')
  expect(result).toHaveProperty('limitUsd')
  expect(result).toHaveProperty('runCount')
  expect(typeof result.totalCostUsd).toBe('number')
  expect(typeof result.limitUsd).toBe('number')
  expect(typeof result.runCount).toBe('number')
  expect(Object.keys(result).length).toBe(3)
})

it('totalCostUsd equals total()', () => {
  const tracker = new CostTracker(100)
  tracker.add(15.5)
  tracker.add(24.3)
  const result = tracker.toJSON()
  expect(result.totalCostUsd).toBe(tracker.total())
})

it('limitUsd equals limitUsd()', () => {
  const tracker = new CostTracker(250.75)
  tracker.add(50)
  const result = tracker.toJSON()
  expect(result.limitUsd).toBe(tracker.limitUsd())
})

it('runCount equals runCount()', () => {
  const tracker = new CostTracker(100)
  tracker.add(10)
  tracker.add(20)
  tracker.add(30)
  const result = tracker.toJSON()
  expect(result.runCount).toBe(tracker.runCount())
})

it('toJSON does not modify internal state', () => {
  const tracker = new CostTracker(500)
  tracker.add(100)
  tracker.add(50)
  const totalBefore = tracker.total()
  const limitBefore = tracker.limitUsd()
  const runCountBefore = tracker.runCount()
  tracker.toJSON()
  const totalAfter = tracker.total()
  const limitAfter = tracker.limitUsd()
  const runCountAfter = tracker.runCount()
  expect(totalAfter).toBe(totalBefore)
  expect(limitAfter).toBe(limitBefore)
  expect(runCountAfter).toBe(runCountBefore)
})

it('toJSON result serializes with JSON.stringify', () => {
  const tracker = new CostTracker(1000)
  tracker.add(333.33)
  const result = tracker.toJSON()
  const jsonString = JSON.stringify(result)
  expect(typeof jsonString).toBe('string')
  const parsed = JSON.parse(jsonString)
  expect(parsed.totalCostUsd).toBe(result.totalCostUsd)
  expect(parsed.limitUsd).toBe(result.limitUsd)
  expect(parsed.runCount).toBe(result.runCount)
})

it('toJSON accepts no parameters and does not throw', () => {
  const tracker = new CostTracker(100)
  tracker.add(25)
  expect(() => {
    tracker.toJSON()
  }).not.toThrow()
})

it('toJSON returns a plain object', () => {
  const tracker = new CostTracker(100)
  tracker.add(50)
  const result = tracker.toJSON()
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
})

it('toJSON is idempotent', () => {
  const tracker = new CostTracker(200)
  tracker.add(75)
  const result1 = tracker.toJSON()
  const result2 = tracker.toJSON()
  const result3 = tracker.toJSON()
  expect(result1.totalCostUsd).toBe(result2.totalCostUsd)
  expect(result1.limitUsd).toBe(result2.limitUsd)
  expect(result1.runCount).toBe(result2.runCount)
  expect(result2.totalCostUsd).toBe(result3.totalCostUsd)
  expect(result2.limitUsd).toBe(result3.limitUsd)
  expect(result2.runCount).toBe(result3.runCount)
})

it('toJSON reflects current state after multiple operations', () => {
  const tracker = new CostTracker(500)
  tracker.add(100)
  let result = tracker.toJSON()
  expect(result.totalCostUsd).toBe(100)
  expect(result.runCount).toBe(1)
  tracker.add(50)
  result = tracker.toJSON()
  expect(result.totalCostUsd).toBe(150)
  expect(result.runCount).toBe(2)
  tracker.add(25)
  result = tracker.toJSON()
  expect(result.totalCostUsd).toBe(175)
  expect(result.runCount).toBe(3)
})

it('toJSON works with zero total and zero run count', () => {
  const tracker = new CostTracker(100)
  const result = tracker.toJSON()
  expect(result.totalCostUsd).toBe(0)
  expect(result.runCount).toBe(0)
  expect(result.limitUsd).toBe(100)
})

it('toJSON serializes correctly in nested JSON structures', () => {
  const tracker = new CostTracker(1000)
  tracker.add(250)
  const container = { tracker: tracker.toJSON(), metadata: 'test' }
  const jsonString = JSON.stringify(container)
  const parsed = JSON.parse(jsonString)
  expect(parsed.tracker.totalCostUsd).toBe(250)
  expect(parsed.tracker.limitUsd).toBe(1000)
  expect(parsed.tracker.runCount).toBe(1)
})
})
