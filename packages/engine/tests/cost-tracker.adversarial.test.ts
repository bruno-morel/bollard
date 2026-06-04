import { describe, it, expect, vi } from "vitest"
import { CostTracker } from "../src/cost-tracker.js"

describe("boundary tests", () => {
it('breakdown returns object with exactly five properties', () => {
  const tracker = new CostTracker(100)
  const result = tracker.breakdown()
  const keys = Object.keys(result).sort()
  expect(keys).toEqual(['isUnlimited', 'limitUsd', 'percentUsed', 'remainingUsd', 'totalCostUsd'])
  expect(keys.length).toBe(5)
})

it('totalCostUsd equals accumulated total', () => {
  const tracker = new CostTracker(100)
  tracker.add(25)
  tracker.add(30)
  const result = tracker.breakdown()
  expect(result.totalCostUsd).toBe(55)
})

it('limitUsd equals constructor limit', () => {
  const tracker = new CostTracker(250)
  const result = tracker.breakdown()
  expect(result.limitUsd).toBe(250)
})

it('remainingUsd is limit minus total for finite limit', () => {
  const tracker = new CostTracker(100)
  tracker.add(30)
  const result = tracker.breakdown()
  expect(result.remainingUsd).toBe(70)
})

it('remainingUsd clamped to 0 when over limit', () => {
  const tracker = new CostTracker(100)
  tracker.add(150)
  const result = tracker.breakdown()
  expect(result.remainingUsd).toBe(0)
})

it('remainingUsd is Infinity for unlimited budget', () => {
  const tracker = new CostTracker(Infinity)
  tracker.add(1000000)
  const result = tracker.breakdown()
  expect(result.remainingUsd).toBe(Infinity)
})

it('percentUsed is 0 for unlimited budget', () => {
  const tracker = new CostTracker(Infinity)
  tracker.add(500)
  const result = tracker.breakdown()
  expect(result.percentUsed).toBe(0)
})

it('percentUsed is 0 when total is 0', () => {
  const tracker = new CostTracker(100)
  const result = tracker.breakdown()
  expect(result.percentUsed).toBe(0)
})

it('percentUsed is (total/limit)*100 for finite limit', () => {
  const tracker = new CostTracker(100)
  tracker.add(50)
  const result = tracker.breakdown()
  expect(result.percentUsed).toBe(50)
})

it('percentUsed clamped to 100 when over limit', () => {
  const tracker = new CostTracker(100)
  tracker.add(150)
  const result = tracker.breakdown()
  expect(result.percentUsed).toBe(100)
})

it('isUnlimited is true for Infinity limit', () => {
  const tracker = new CostTracker(Infinity)
  const result = tracker.breakdown()
  expect(result.isUnlimited).toBe(true)
})

it('isUnlimited is false for finite limit', () => {
  const tracker = new CostTracker(100)
  const result = tracker.breakdown()
  expect(result.isUnlimited).toBe(false)
})

it('breakdown is idempotent', () => {
  const tracker = new CostTracker(100)
  tracker.add(25)
  const result1 = tracker.breakdown()
  const result2 = tracker.breakdown()
  expect(result1).toEqual(result2)
  expect(result1.totalCostUsd).toBe(result2.totalCostUsd)
  expect(result1.limitUsd).toBe(result2.limitUsd)
  expect(result1.remainingUsd).toBe(result2.remainingUsd)
  expect(result1.percentUsed).toBe(result2.percentUsed)
  expect(result1.isUnlimited).toBe(result2.isUnlimited)
})

it('breakdown returns new object each call', () => {
  const tracker = new CostTracker(100)
  const result1 = tracker.breakdown()
  const result2 = tracker.breakdown()
  expect(result1).not.toBe(result2)
})

it('breakdown does not modify internal state', () => {
  const tracker = new CostTracker(100)
  tracker.add(25)
  const totalBefore = tracker.total()
  const limitBefore = tracker.limitUsd()
  const runCountBefore = tracker.runCount()
  tracker.breakdown()
  tracker.breakdown()
  expect(tracker.total()).toBe(totalBefore)
  expect(tracker.limitUsd()).toBe(limitBefore)
  expect(tracker.runCount()).toBe(runCountBefore)
})

it('breakdown works with zero limit', () => {
  const tracker = new CostTracker(0)
  tracker.add(5)
  const result = tracker.breakdown()
  expect(result.limitUsd).toBe(0)
  expect(result.totalCostUsd).toBe(5)
  expect(result.remainingUsd).toBe(0)
  expect(result.percentUsed).toBe(100)
  expect(result.isUnlimited).toBe(false)
})

it('breakdown percentUsed is precise for fractional values', () => {
  const tracker = new CostTracker(3)
  tracker.add(1)
  const result = tracker.breakdown()
  expect(result.percentUsed).toBeCloseTo(33.333333, 5)
})

it('breakdown handles very small costs', () => {
  const tracker = new CostTracker(1)
  tracker.add(0.0001)
  const result = tracker.breakdown()
  expect(result.totalCostUsd).toBe(0.0001)
  expect(result.remainingUsd).toBeCloseTo(0.9999, 4)
})

it('breakdown handles large cost values', () => {
  const tracker = new CostTracker(1000000)
  tracker.add(500000)
  const result = tracker.breakdown()
  expect(result.totalCostUsd).toBe(500000)
  expect(result.remainingUsd).toBe(500000)
  expect(result.percentUsed).toBe(50)
})

it('breakdown accumulates multiple adds correctly', () => {
  const tracker = new CostTracker(100)
  tracker.add(10)
  tracker.add(20)
  tracker.add(15)
  tracker.add(5)
  const result = tracker.breakdown()
  expect(result.totalCostUsd).toBe(50)
  expect(result.remainingUsd).toBe(50)
  expect(result.percentUsed).toBe(50)
})
})
