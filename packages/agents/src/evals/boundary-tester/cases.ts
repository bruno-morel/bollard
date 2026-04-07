import type { EvalCase } from "@bollard/engine/src/eval-runner.js"

const BOUNDARY_TESTER_SYSTEM =
  "You are a boundary-scope adversarial tester. You have NOT seen the implementation. Write a complete Vitest test file based ONLY on the signatures and acceptance criteria provided. Use fast-check for property-based tests. Include negative tests. Output ONLY the TypeScript test code."

const COST_TRACKER_SIGNATURES = `
## Signatures
export class CostTracker {
  constructor(limitUsd: number) { ... }
  add(costUsd: number): void { ... }
  total(): number { ... }
  exceeded(): boolean { ... }
  remaining(): number { ... }
}
`

const COST_TRACKER_CRITERIA = [
  "CostTracker tracks cumulative cost and reports when the limit is exceeded",
  "add() rejects negative cost values",
  "remaining() returns the difference between limit and total",
  "exceeded() returns true only when total surpasses the limit",
]

export const boundaryTesterEvalCases: EvalCase[] = [
  {
    id: "boundary-tester-valid-vitest",
    description: "Produces a valid Vitest test file with imports and describe blocks",
    systemPrompt: BOUNDARY_TESTER_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          "# Task",
          "Implement a CostTracker class",
          "",
          "# Acceptance Criteria",
          ...COST_TRACKER_CRITERIA.map((c, i) => `${i + 1}. ${c}`),
          "",
          "# Public API Surface",
          COST_TRACKER_SIGNATURES,
          "",
          "# Instructions",
          "Write a complete test file. Output ONLY the TypeScript test code.",
        ].join("\n"),
      },
    ],
    assertions: [
      { type: "contains", value: "import", description: "Has import statements" },
      { type: "contains", value: "describe", description: "Has describe blocks" },
      { type: "contains", value: "it(", description: "Has test cases" },
      { type: "contains", value: "expect", description: "Has assertions" },
    ],
  },
  {
    id: "boundary-tester-tests-criteria-not-implementation",
    description: "Tests reference acceptance criteria, not implementation details",
    systemPrompt: BOUNDARY_TESTER_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          "# Task",
          "Implement a CostTracker class",
          "",
          "# Acceptance Criteria",
          ...COST_TRACKER_CRITERIA.map((c, i) => `${i + 1}. ${c}`),
          "",
          "# Public API Surface",
          COST_TRACKER_SIGNATURES,
          "",
          "# Instructions",
          "Write a complete test file. Output ONLY the TypeScript test code.",
        ].join("\n"),
      },
    ],
    assertions: [
      { type: "contains", value: "exceeded", description: "Tests exceeded behavior" },
      { type: "contains", value: "remaining", description: "Tests remaining behavior" },
      { type: "not_contains", value: "_total", description: "Does not reference private _total" },
      { type: "not_contains", value: "_limit", description: "Does not reference private _limit" },
    ],
  },
  {
    id: "boundary-tester-includes-negative-tests",
    description: "Output includes negative/boundary test cases",
    systemPrompt: BOUNDARY_TESTER_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          "# Task",
          "Implement a CostTracker class",
          "",
          "# Acceptance Criteria",
          ...COST_TRACKER_CRITERIA.map((c, i) => `${i + 1}. ${c}`),
          "",
          "# Public API Surface",
          COST_TRACKER_SIGNATURES,
          "",
          "# Instructions",
          "Write a complete test file. Include negative tests for invalid inputs. Output ONLY the TypeScript test code.",
        ].join("\n"),
      },
    ],
    assertions: [
      { type: "contains", value: "negative", description: "References negative values" },
      { type: "contains", value: "throw", description: "Tests for thrown errors" },
    ],
  },
  {
    id: "boundary-tester-includes-property-based",
    description: "Output includes property-based tests using fast-check",
    systemPrompt: BOUNDARY_TESTER_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          "# Task",
          "Implement a CostTracker class",
          "",
          "# Acceptance Criteria",
          ...COST_TRACKER_CRITERIA.map((c, i) => `${i + 1}. ${c}`),
          "",
          "# Public API Surface",
          COST_TRACKER_SIGNATURES,
          "",
          "# Instructions",
          "Write a complete test file. Use fast-check for property-based tests on numeric inputs. Output ONLY the TypeScript test code.",
        ].join("\n"),
      },
    ],
    assertions: [
      { type: "contains", value: "fc.", description: "Uses fast-check assertions" },
      {
        type: "matches_regex",
        value: "fast-check|fc\\.property|fc\\.assert",
        description: "Has property-based test patterns",
      },
    ],
  },
]
