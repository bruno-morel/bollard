import type { EvalCase } from "@bollard/engine/src/eval-runner.js"

const BOUNDARY_TESTER_SYSTEM =
  "You are a boundary-scope adversarial tester. You have NOT seen the implementation. Output ONLY a JSON claims document wrapped in a ```json fence. Each claim must have id (prefix bnd), concern, claim, grounding (verbatim quote from the user message: task, criteria, or signatures), and test (framework wrapper + body; imports before the wrapper). Use fast-check in TypeScript claims where appropriate. Do not import vitest primitives."

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

const USER_MESSAGE = [
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
  "Emit JSON claims per your system prompt. Ground every quote in the task, criteria, or signatures above.",
].join("\n")

export const boundaryTesterEvalCases: EvalCase[] = [
  {
    id: "boundary-tester-valid-claims-json",
    description: "Produces a JSON claims document with grounding and test fields",
    systemPrompt: BOUNDARY_TESTER_SYSTEM,
    messages: [{ role: "user", content: USER_MESSAGE }],
    assertions: [
      { type: "contains", value: '"claims"', description: "Has claims array key" },
      { type: "contains", value: '"grounding"', description: "Has grounding field" },
      { type: "contains", value: '"quote"', description: "Has grounding quote" },
      { type: "contains", value: '"test"', description: "Has test field" },
      {
        type: "matches_regex",
        value: '"id"\\s*:\\s*"bnd',
        description: "Uses bnd-prefixed claim ids",
      },
    ],
  },
  {
    id: "boundary-tester-tests-criteria-not-implementation",
    description: "Claims reference acceptance criteria, not invented private fields",
    systemPrompt: BOUNDARY_TESTER_SYSTEM,
    messages: [{ role: "user", content: USER_MESSAGE }],
    assertions: [
      { type: "contains", value: "exceeded", description: "Touches exceeded surface" },
      { type: "contains", value: "remaining", description: "Touches remaining surface" },
      { type: "not_contains", value: "_total", description: "Does not reference private _total" },
      { type: "not_contains", value: "_limit", description: "Does not reference private _limit" },
    ],
  },
  {
    id: "boundary-tester-includes-negative-tests",
    description: "Output includes negative or invalid-input coverage in claim text or tests",
    systemPrompt: BOUNDARY_TESTER_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          USER_MESSAGE,
          "",
          "Include at least one claim about rejecting invalid or negative inputs.",
        ].join("\n"),
      },
    ],
    assertions: [
      { type: "contains", value: "negative", description: "References negative or invalid inputs" },
      { type: "contains", value: "reject", description: "Mentions rejection or throw" },
    ],
  },
  {
    id: "boundary-tester-includes-property-based",
    description: "TypeScript claims may use fast-check in the test body",
    systemPrompt: BOUNDARY_TESTER_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          USER_MESSAGE,
          "",
          "Use fast-check (fc) in at least one claim's test field for numeric inputs.",
        ].join("\n"),
      },
    ],
    assertions: [
      { type: "contains", value: "fc.", description: "Uses fast-check in a test body" },
      {
        type: "matches_regex",
        value: "fast-check|fc\\.property|fc\\.assert",
        description: "Has property-based patterns",
      },
    ],
  },
]
