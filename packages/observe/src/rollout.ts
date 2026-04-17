import type {
  AdvanceDecision,
  ProbeRunSummary,
  RiskTier,
  RolloutPlan,
  RolloutStage,
  RolloutState,
} from "./providers/types.js"

export function computeRolloutPlan(riskTier: RiskTier): RolloutPlan {
  switch (riskTier) {
    case "low":
      return {
        riskTier,
        stages: [
          { stage: "off", percent: 0 },
          { stage: "full", percent: 100 },
        ],
        probeWindowMs: 0,
        requiresHumanApproval: false,
      }
    case "medium":
      return {
        riskTier,
        stages: [
          { stage: "off", percent: 0 },
          { stage: "canary", percent: 5 },
          { stage: "partial", percent: 25 },
          { stage: "full", percent: 100 },
        ],
        probeWindowMs: 30 * 60 * 1000,
        requiresHumanApproval: false,
      }
    case "high":
      return {
        riskTier,
        stages: [
          { stage: "off", percent: 0 },
          { stage: "canary", percent: 5 },
          { stage: "partial", percent: 25 },
          { stage: "full", percent: 50 },
          { stage: "full", percent: 100 },
        ],
        probeWindowMs: 60 * 60 * 1000,
        requiresHumanApproval: true,
      }
    default:
      return {
        riskTier: "critical",
        stages: [
          { stage: "off", percent: 0 },
          { stage: "canary", percent: 5 },
          { stage: "partial", percent: 10 },
          { stage: "partial", percent: 25 },
          { stage: "full", percent: 50 },
          { stage: "full", percent: 100 },
        ],
        probeWindowMs: 120 * 60 * 1000,
        requiresHumanApproval: true,
      }
  }
}

export interface ShouldAdvanceOptions {
  now: number
  humanApproved?: boolean
}

/**
 * Advance when probe window elapsed and recent probe run is healthy.
 * High/critical tiers require explicit human approval between steps.
 */
export function shouldAdvance(
  state: RolloutState,
  probeResults: ProbeRunSummary,
  opts: ShouldAdvanceOptions,
): AdvanceDecision {
  const plan = computeRolloutPlan(state.riskTier)
  if (plan.requiresHumanApproval && !opts.humanApproved) {
    return { advance: false, requiresHuman: true, reason: "human approval required" }
  }

  if (probeResults.failed > 0) {
    return { advance: false, requiresHuman: false, reason: "probe failures in window" }
  }

  const elapsed = opts.now - state.lastAdvancedAt
  if (plan.probeWindowMs > 0 && elapsed < plan.probeWindowMs) {
    return { advance: false, requiresHuman: false, reason: "probe window not elapsed" }
  }

  return { advance: true, requiresHuman: false }
}

/** Zero-based index into `computeRolloutPlan(...).stages`. */
export function nextRolloutStep(
  plan: RolloutPlan,
  currentStageIndex: number,
): { stage: RolloutStage; percent: number } | undefined {
  const nextIdx = currentStageIndex + 1
  if (nextIdx >= plan.stages.length) return undefined
  return plan.stages[nextIdx]
}
