import { describe, it, expect, vi } from "vitest"
import { CostTracker } from "../src/cost-tracker.js"
import { BollardError } from "../src/errors.js"

describe("boundary tests", () => {
it('floor() with no arguments truncates to 2 decimal places', () => {
  const tracker = new CostTracker(100)
  tracker.add(10.12345)
  tracker.floor()
  expect(tracker.total()).toBe(10.12)
})

it('floor() default truncates down correctly', () => {
  const tracker = new CostTracker(100)
  tracker.add(5.9999)
  tracker.floor()
  expect(tracker.total()).toBe(5.99)
})

it('floor() default handles exact 2-decimal values', () => {
  const tracker = new CostTracker(100)
  tracker.add(7.50)
  tracker.floor()
  expect(tracker.total()).toBe(7.50)
})

it('floor(0) truncates to 0 decimal places', () => {
  const tracker = new CostTracker(100)
  tracker.add(3.7)
  tracker.floor(0)
  expect(tracker.total()).toBe(3)
})

it('floor(1) truncates to 1 decimal place', () => {
  const tracker = new CostTracker(100)
  tracker.add(2.456)
  tracker.floor(1)
  expect(tracker.total()).toBe(2.4)
})

it('floor(3) truncates to 3 decimal places', () => {
  const tracker = new CostTracker(100)
  tracker.add(1.23456789)
  tracker.floor(3)
  expect(tracker.total()).toBe(1.234)
})

it('floor(5) truncates to 5 decimal places', () => {
  const tracker = new CostTracker(100)
  tracker.add(0.123456789)
  tracker.floor(5)
  expect(tracker.total()).toBe(0.12345)
})

it('floor() returns this for chaining', () => {
  const tracker = new CostTracker(100)
  tracker.add(5.555)
  const result = tracker.floor(2)
  expect(result).toBe(tracker)
})

it('floor() enables method chaining', () => {
  const tracker = new CostTracker(100)
  tracker.add(10.999)
  const result = tracker.floor(1).floor(0)
  expect(result).toBe(tracker)
  expect(tracker.total()).toBe(10)
})

it('floor() mutates _total in place', () => {
  const tracker = new CostTracker(100)
  tracker.add(3.14159)
  const totalBefore = tracker.total()
  tracker.floor(2)
  const totalAfter = tracker.total()
  expect(totalBefore).toBe(3.14159)
  expect(totalAfter).toBe(3.14)
  expect(tracker.total()).toBe(3.14)
})

it('floor() handles zero total', () => {
  const tracker = new CostTracker(100)
  tracker.floor(2)
  expect(tracker.total()).toBe(0)
})

it('floor() handles very small decimals', () => {
  const tracker = new CostTracker(100)
  tracker.add(0.0001)
  tracker.floor(3)
  expect(tracker.total()).toBe(0)
})

it('floor() handles very small decimals that survive truncation', () => {
  const tracker = new CostTracker(100)
  tracker.add(0.001)
  tracker.floor(3)
  expect(tracker.total()).toBe(0.001)
})

it('floor() handles large numbers', () => {
  const tracker = new CostTracker(1000000)
  tracker.add(999999.9999)
  tracker.floor(2)
  expect(tracker.total()).toBe(999999.99)
})

it('floor() handles large numbers with many decimals', () => {
  const tracker = new CostTracker(1000000)
  tracker.add(123456.789123)
  tracker.floor(4)
  expect(tracker.total()).toBe(123456.7891)
})

it('floor(0) truncates 0.99 to 0', () => {
  const tracker = new CostTracker(100)
  tracker.add(0.99)
  tracker.floor(0)
  expect(tracker.total()).toBe(0)
})

it('floor(0) truncates 5.1 to 5', () => {
  const tracker = new CostTracker(100)
  tracker.add(5.1)
  tracker.floor(0)
  expect(tracker.total()).toBe(5)
})

it('floor(2) rounds down 1.999 to 1.99', () => {
  const tracker = new CostTracker(100)
  tracker.add(1.999)
  tracker.floor(2)
  expect(tracker.total()).toBe(1.99)
})

it('floor(2) rounds down 2.996 to 2.99', () => {
  const tracker = new CostTracker(100)
  tracker.add(2.996)
  tracker.floor(2)
  expect(tracker.total()).toBe(2.99)
})

it('floor() rejects Infinity', () => {
  const tracker = new CostTracker(100)
  tracker.add(5.5)
  try {
    tracker.floor(Infinity)
    expect.fail('should have thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(BollardError)
    expect(err.code).toBe('CONTRACT_VIOLATION')
  }
})

it('floor() rejects NaN', () => {
  const tracker = new CostTracker(100)
  tracker.add(5.5)
  try {
    tracker.floor(NaN)
    expect.fail('should have thrown')
  } catch (err) {
    expect(err).toBeInstanceOf(BollardError)
    expect(err.code).toBe('CONTRACT_VIOLATION')
  }
})

it('floor(0) is valid and truncates to integer', () => {
  const tracker = new CostTracker(100)
  tracker.add(7.89)
  const result = tracker.floor(0)
  expect(result).toBe(tracker)
  expect(tracker.total()).toBe(7)
})

it('floor(10) preserves 10 decimal places', () => {
  const tracker = new CostTracker(100)
  tracker.add(0.1234567890123)
  tracker.floor(10)
  expect(tracker.total()).toBe(0.1234567890)
})

it('floor() without argument uses default of 2', () => {
  const tracker1 = new CostTracker(100)
  tracker1.add(5.12345)
  tracker1.floor()
  
  const tracker2 = new CostTracker(100)
  tracker2.add(5.12345)
  tracker2.floor(2)
  
  expect(tracker1.total()).toBe(tracker2.total())
  expect(tracker1.total()).toBe(5.12)
})
})
