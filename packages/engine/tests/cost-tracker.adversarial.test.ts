import { describe, it, expect, vi } from "vitest"
import { CostTracker } from "../src/cost-tracker.js"

describe("boundary tests", () => {
it('snapshotTotal is a public method callable with no arguments', () => {
  const tracker = new CostTracker(100)
  const result = tracker.snapshotTotal()
  expect(typeof result).toBe('number')
})

it('snapshotTotal returns value equal to total', () => {
  const tracker = new CostTracker(100)
  tracker.add(25)
  const snapshot = tracker.snapshotTotal()
  const total = tracker.total()
  expect(snapshot).toBe(total)
})

it('snapshotTotal does not modify state', () => {
  const tracker = new CostTracker(100)
  tracker.add(50)
  const totalBefore = tracker.total()
  const remainingBefore = tracker.remaining()
  const snapshot = tracker.snapshotTotal()
  const totalAfter = tracker.total()
  const remainingAfter = tracker.remaining()
  expect(totalAfter).toBe(totalBefore)
  expect(remainingAfter).toBe(remainingBefore)
  expect(snapshot).toBe(totalBefore)
})

it('snapshotTotal returns consistent value across multiple calls when total unchanged', () => {
  const tracker = new CostTracker(100)
  tracker.add(30)
  const snapshot1 = tracker.snapshotTotal()
  const snapshot2 = tracker.snapshotTotal()
  const snapshot3 = tracker.snapshotTotal()
  expect(snapshot1).toBe(snapshot2)
  expect(snapshot2).toBe(snapshot3)
})

it('snapshotTotal returns 0 for new CostTracker', () => {
  const tracker = new CostTracker(100)
  expect(tracker.snapshotTotal()).toBe(0)
})

it('snapshotTotal reflects accumulated add calls', () => {
  const tracker = new CostTracker(100)
  tracker.add(10)
  expect(tracker.snapshotTotal()).toBe(10)
  tracker.add(20)
  expect(tracker.snapshotTotal()).toBe(30)
  tracker.add(5)
  expect(tracker.snapshotTotal()).toBe(35)
})

it('snapshotTotal reflects subtract calls', () => {
  const tracker = new CostTracker(100)
  tracker.add(50)
  expect(tracker.snapshotTotal()).toBe(50)
  tracker.subtract(15)
  expect(tracker.snapshotTotal()).toBe(35)
  tracker.subtract(10)
  expect(tracker.snapshotTotal()).toBe(25)
})

it('snapshotTotal reflects reset calls', () => {
  const tracker = new CostTracker(100)
  tracker.add(50)
  expect(tracker.snapshotTotal()).toBe(50)
  tracker.reset()
  expect(tracker.snapshotTotal()).toBe(0)
})

it('snapshotTotal reflects divide calls', () => {
  const tracker = new CostTracker(100)
  tracker.add(100)
  expect(tracker.snapshotTotal()).toBe(100)
  tracker.divide(2)
  expect(tracker.snapshotTotal()).toBe(50)
  tracker.divide(5)
  expect(tracker.snapshotTotal()).toBe(10)
})

it('snapshotTotal does not trigger state modifications through method calls', () => {
  const tracker = new CostTracker(100)
  tracker.add(40)
  const beforeExceeded = tracker.exceeded()
  const snapshot = tracker.snapshotTotal()
  const afterExceeded = tracker.exceeded()
  expect(beforeExceeded).toBe(afterExceeded)
  expect(snapshot).toBe(40)
})

it('snapshotTotal equals total after complex state changes', () => {
  const tracker = new CostTracker(100)
  tracker.add(30)
  tracker.add(20)
  tracker.subtract(5)
  const snapshot = tracker.snapshotTotal()
  const total = tracker.total()
  expect(snapshot).toBe(total)
  expect(snapshot).toBe(45)
})
})
