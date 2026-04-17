import { describe, expect, it } from "vitest"

import type { RolloutState } from "../src/providers/types.js"
import { computeRolloutPlan, nextRolloutStep, shouldAdvance } from "../src/rollout.js"

describe("computeRolloutPlan", () => {
  it("low tier jumps to full", () => {
    const p = computeRolloutPlan("low")
    expect(p.stages[p.stages.length - 1]?.percent).toBe(100)
    expect(p.requiresHumanApproval).toBe(false)
  })

  it("medium tier has canary and 30m window", () => {
    const p = computeRolloutPlan("medium")
    expect(p.stages.some((s) => s.stage === "canary")).toBe(true)
    expect(p.probeWindowMs).toBe(30 * 60 * 1000)
  })

  it("high tier requires human", () => {
    const p = computeRolloutPlan("high")
    expect(p.requiresHumanApproval).toBe(true)
    expect(p.probeWindowMs).toBe(60 * 60 * 1000)
  })

  it("critical tier has longest window", () => {
    const p = computeRolloutPlan("critical")
    expect(p.probeWindowMs).toBe(120 * 60 * 1000)
  })
})

describe("nextRolloutStep", () => {
  it("returns next stage", () => {
    const plan = computeRolloutPlan("medium")
    const n = nextRolloutStep(plan, 0)
    expect(n?.stage).toBe("canary")
  })
})

describe("shouldAdvance", () => {
  const baseState = (): RolloutState => ({
    flagId: "f",
    riskTier: "medium",
    stage: "canary",
    percent: 5,
    startedAt: 0,
    lastAdvancedAt: 0,
    probeWindowMs: 30 * 60 * 1000,
    requiresHumanApproval: false,
    history: [],
  })

  it("blocks when probes failed", () => {
    const s = baseState()
    const dec = shouldAdvance(
      s,
      { total: 1, passed: 0, failed: 1, results: [], duration_ms: 1 },
      { now: Date.now() + 999999999 },
    )
    expect(dec.advance).toBe(false)
  })

  it("blocks until window elapsed", () => {
    const s = baseState()
    const dec = shouldAdvance(
      s,
      { total: 1, passed: 1, failed: 0, results: [], duration_ms: 1 },
      { now: 1000 },
    )
    expect(dec.advance).toBe(false)
  })

  it("requires human for high tier without approval", () => {
    const s: RolloutState = {
      ...baseState(),
      riskTier: "high",
    }
    const plan = computeRolloutPlan("high")
    s.probeWindowMs = plan.probeWindowMs
    const dec = shouldAdvance(
      s,
      { total: 1, passed: 1, failed: 0, results: [], duration_ms: 1 },
      { now: Date.now() + s.probeWindowMs + 1 },
    )
    expect(dec.requiresHuman).toBe(true)
  })

  it("advances medium when healthy and window elapsed", () => {
    const s = baseState()
    const dec = shouldAdvance(
      s,
      { total: 1, passed: 1, failed: 0, results: [], duration_ms: 1 },
      { now: s.lastAdvancedAt + s.probeWindowMs + 1 },
    )
    expect(dec.advance).toBe(true)
  })
})
