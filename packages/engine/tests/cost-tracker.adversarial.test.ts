import { describe, it, expect, vi } from "vitest"
import { CostTracker } from "../src/cost-tracker.js"
import { BollardError } from "../src/errors.js"

describe("boundary tests", () => {
it('formatCost() with no arguments returns 2 decimal places', () => {
  const tracker = new CostTracker(100)
  tracker.add(1.23)
  const result = tracker.formatCost()
  expect(result).toBe('$1.23')
})

it('formatCost(3) returns 3 decimal places', () => {
  const tracker = new CostTracker(100)
  tracker.add(1.2345)
  const result = tracker.formatCost(3)
  expect(result).toBe('$1.235')
})

it('formatCost() returns $0.00 when total is 0', () => {
  const tracker = new CostTracker(100)
  const result = tracker.formatCost()
  expect(result).toBe('$0.00')
})

it('formatCost() is idempotent and does not modify state', () => {
  const tracker = new CostTracker(100)
  tracker.add(5.5)
  const result1 = tracker.formatCost()
  const result2 = tracker.formatCost()
  const result3 = tracker.formatCost()
  expect(result1).toBe(result2)
  expect(result2).toBe(result3)
  expect(result1).toBe('$5.50')
  expect(tracker.total()).toBe(5.5)
})

it('formatCost() handles very small decimals', () => {
  const tracker = new CostTracker(100)
  tracker.add(0.001)
  const result = tracker.formatCost()
  expect(result).toBe('$0.00')
  const resultWith3 = tracker.formatCost(3)
  expect(resultWith3).toBe('$0.001')
})

it('formatCost() handles large numbers', () => {
  const tracker = new CostTracker(1000000)
  tracker.add(999999.99)
  const result = tracker.formatCost()
  expect(result).toBe('$999999.99')
})

it('formatCost() returns string with $ prefix', () => {
  const tracker = new CostTracker(100)
  tracker.add(42.5)
  const result = tracker.formatCost()
  expect(typeof result).toBe('string')
  expect(result.startsWith('$')).toBe(true)
  expect(result).toMatch(/^\$\d+\.\d{2}$/)
})

it('formatCost(-1) throws BollardError with CONTRACT_VIOLATION', () => {
  const tracker = new CostTracker(100)
  tracker.add(5)
  expect(() => tracker.formatCost(-1)).toThrow(BollardError)
  try {
    tracker.formatCost(-1)
  } catch (err) {
    expect(err).toBeInstanceOf(BollardError)
    expect(err.code).toBe('CONTRACT_VIOLATION')
  }
})

it('formatCost(1.5) throws BollardError with CONTRACT_VIOLATION', () => {
  const tracker = new CostTracker(100)
  tracker.add(5)
  expect(() => tracker.formatCost(1.5)).toThrow(BollardError)
  try {
    tracker.formatCost(1.5)
  } catch (err) {
    expect(err).toBeInstanceOf(BollardError)
    expect(err.code).toBe('CONTRACT_VIOLATION')
  }
})

it('formatCost(0) returns 0 decimal places', () => {
  const tracker = new CostTracker(100)
  tracker.add(1.99)
  const result = tracker.formatCost(0)
  expect(result).toBe('$2')
})

it('formatCost() handles rounding consistently with toFixed()', () => {
  const tracker = new CostTracker(100)
  tracker.add(1.005)
  const result = tracker.formatCost(2)
  expect(result).toBe('$1.01')
})

it('formatCost() preserves all internal state', () => {
  const tracker = new CostTracker(50)
  tracker.add(10)
  tracker.add(5)
  const totalBefore = tracker.total()
  const runCountBefore = tracker.runCount()
  const remainingBefore = tracker.remaining()
  tracker.formatCost()
  tracker.formatCost(2)
  tracker.formatCost(0)
  expect(tracker.total()).toBe(totalBefore)
  expect(tracker.runCount()).toBe(runCountBefore)
  expect(tracker.remaining()).toBe(remainingBefore)
})

it('formatCost() reflects accumulated costs from multiple add() calls', () => {
  const tracker = new CostTracker(100)
  tracker.add(0.5)
  tracker.add(0.75)
  tracker.add(0.48)
  const result = tracker.formatCost()
  expect(result).toBe('$1.73')
})

it('formatCost() reflects state after subtract()', () => {
  const tracker = new CostTracker(100)
  tracker.add(10)
  tracker.subtract(3)
  const result = tracker.formatCost()
  expect(result).toBe('$7.00')
})

it('formatCost(10) returns 10 decimal places', () => {
  const tracker = new CostTracker(100)
  tracker.add(1.123456789)
  const result = tracker.formatCost(10)
  expect(result).toMatch(/^\$1\.\d{10}$/)
  expect(result).toBe('$1.1234567890')
})
})
