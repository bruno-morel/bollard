import { describe, it, expect, vi } from "vitest"
import { CostTracker } from "../src/cost-tracker.js"
import { BollardError } from "../src/errors.js"

describe("boundary tests", () => {
it('returns correct format for finite limits', () => {
  const tracker = new CostTracker(10.00)
  tracker.add(1.23)
  const result = tracker.humanReadable()
  expect(result).toBe('$1.23 / $10.00 (12.3%)')
})

it('returns infinity format for infinite limits', () => {
  const tracker = new CostTracker(Infinity)
  tracker.add(5.50)
  const result = tracker.humanReadable()
  expect(result).toBe('$5.50 / ∞ (∞%)')
})

it('returns infinity percentage when limit is zero', () => {
  const tracker = new CostTracker(0)
  const result = tracker.humanReadable()
  expect(result).toBe('$0.00 / $0.00 (∞%)')
})

it('is idempotent and does not modify state', () => {
  const tracker = new CostTracker(10.00)
  tracker.add(2.50)
  const result1 = tracker.humanReadable()
  const result2 = tracker.humanReadable()
  const result3 = tracker.humanReadable()
  expect(result1).toBe(result2)
  expect(result2).toBe(result3)
  expect(tracker.total()).toBe(2.50)
  expect(tracker.limitUsd()).toBe(10.00)
})

it('throws CONTRACT_VIOLATION when total exceeds finite limit', () => {
  const tracker = new CostTracker(5.00)
  // Manually corrupt state by adding beyond limit
  tracker.add(3.00)
  tracker.add(3.00)
  expect(() => tracker.humanReadable()).toThrow(BollardError)
})

it('formats percentage to 1 decimal place', () => {
  const tracker = new CostTracker(3.00)
  tracker.add(1.00)
  const result = tracker.humanReadable()
  expect(result).toMatch(/\(33\.3%\)/)
  expect(result).not.toMatch(/\(33\.30%\)/)
})

it('formats dollar amounts to 2 decimal places', () => {
  const tracker = new CostTracker(100.00)
  tracker.add(0.1)
  const result = tracker.humanReadable()
  expect(result).toMatch(/\$0\.10 \/ \$100\.00/)
})

it('calculates percentage correctly for various ratios', () => {
  const tracker1 = new CostTracker(100.00)
  tracker1.add(50.00)
  expect(tracker1.humanReadable()).toBe('$50.00 / $100.00 (50.0%)')
  
  const tracker2 = new CostTracker(100.00)
  tracker2.add(33.33)
  expect(tracker2.humanReadable()).toMatch(/\(33\.3%\)/)
  
  const tracker3 = new CostTracker(100.00)
  tracker3.add(0.01)
  expect(tracker3.humanReadable()).toMatch(/\(0\.0%\)/)
})

it('handles zero total with finite limit', () => {
  const tracker = new CostTracker(10.00)
  const result = tracker.humanReadable()
  expect(result).toBe('$0.00 / $10.00 (0.0%)')
})

it('includes all required format elements', () => {
  const tracker = new CostTracker(50.00)
  tracker.add(12.50)
  const result = tracker.humanReadable()
  expect(result).toContain('$')
  expect(result).toContain('/')
  expect(result).toContain('(')
  expect(result).toContain(')')
  expect(result).toContain('%')
  expect(result).toBe('$12.50 / $50.00 (25.0%)')
})

it('handles very small percentages', () => {
  const tracker = new CostTracker(10000.00)
  tracker.add(0.05)
  const result = tracker.humanReadable()
  expect(result).toMatch(/\(0\.0%\)/)
})

it('handles percentages at or near 100%', () => {
  const tracker = new CostTracker(10.00)
  tracker.add(10.00)
  const result = tracker.humanReadable()
  expect(result).toBe('$10.00 / $10.00 (100.0%)')
})

it('output format is consistent and not injectable', () => {
  const tracker = new CostTracker(10.00)
  tracker.add(1.23)
  const result = tracker.humanReadable()
  const parts = result.match(/^\$(\d+\.\d{2}) \/ \$([\d.∞]+) \(([\d.∞]+)%\)$/)
  expect(parts).not.toBeNull()
  expect(parts?.length).toBe(4)
})

it('handles fractional costs with proper rounding', () => {
  const tracker = new CostTracker(10.00)
  tracker.add(0.005)
  tracker.add(0.004)
  const result = tracker.humanReadable()
  expect(result).toMatch(/\$0\.0[0-9] \/ \$10\.00/)
})
})
