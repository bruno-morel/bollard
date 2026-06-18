import type { CapabilityLevel } from "./model-registry.js"

export interface ModelRequirements {
  reasoning: CapabilityLevel
  codegen: CapabilityLevel
  needsToolUse: boolean
  minContext: number
  minOutput: number
}

const TESTER_REQUIREMENTS: ModelRequirements = {
  reasoning: "standard",
  codegen: "light",
  needsToolUse: false,
  minContext: 100_000,
  minOutput: 16_000,
}

/** Per-role capability profile. Roles absent here fall through to config.llm.default (see forAgent). */
export const ROLE_REQUIREMENTS: Record<string, ModelRequirements> = {
  planner: {
    reasoning: "standard",
    codegen: "light",
    needsToolUse: true,
    minContext: 100_000,
    minOutput: 8_000,
  },
  coder: {
    reasoning: "frontier",
    codegen: "frontier",
    needsToolUse: true,
    minContext: 200_000,
    minOutput: 16_000,
  },
  "boundary-tester": TESTER_REQUIREMENTS,
  "contract-tester": TESTER_REQUIREMENTS,
  "behavioral-tester": TESTER_REQUIREMENTS,
  "semantic-reviewer": {
    reasoning: "standard",
    codegen: "light",
    needsToolUse: false,
    minContext: 100_000,
    minOutput: 8_000,
  },
  "test-curator": {
    reasoning: "standard",
    codegen: "light",
    needsToolUse: false,
    minContext: 100_000,
    minOutput: 8_000,
  },
  "llm-fallback-extractor": {
    reasoning: "light",
    codegen: "light",
    needsToolUse: false,
    minContext: 32_000,
    minOutput: 8_000,
  },
}
