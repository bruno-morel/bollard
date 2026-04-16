import type { EvalCase } from "@bollard/engine/src/eval-runner.js"

const BEHAVIORAL_SYSTEM =
  "You are a behavioral-scope adversarial tester. Output ONLY a JSON claims document wrapped in a ```json fence. Each claim must have id, concern, claim, grounding (verbatim quotes from BehavioralContext lines), and test."

const SAMPLE_CONTEXT = JSON.stringify(
  {
    endpoints: [
      {
        method: "GET",
        path: "/api/health",
        handler: "express:app.get",
        sourceFile: "src/server.ts",
      },
    ],
    config: [{ key: "PORT", source: "code", sourceFile: "src/server.ts" }],
    dependencies: [
      {
        name: "redis",
        type: "cache",
        clientLibrary: "ioredis",
        sourceFile: "src/cache.ts",
      },
    ],
    failureModes: [{ dependency: "redis", mode: "timeout", severity: "medium" }],
  },
  null,
  2,
)

export const behavioralTesterEvalCases: EvalCase[] = [
  {
    id: "behavioral-tester-emits-json-claims",
    description: "Produces JSON claims with executable test stubs grounded in endpoints/deps",
    systemPrompt: BEHAVIORAL_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          "# Task",
          "Verify health and cache behavior under stress",
          "",
          "# BehavioralContext",
          SAMPLE_CONTEXT,
          "",
          "# Instructions",
          "Emit behavioral JSON claims. Ground quotes in the context strings.",
        ].join("\n"),
      },
    ],
    assertions: [
      { type: "contains", value: '"claims"', description: "Has claims array key" },
      {
        type: "contains",
        value: "/api/health",
        description: "References endpoint path from context",
      },
      { type: "contains", value: "redis", description: "References dependency from context" },
    ],
  },
  {
    id: "behavioral-tester-grounding-shape",
    description: "Claims include grounding array with quote and source",
    systemPrompt: BEHAVIORAL_SYSTEM,
    messages: [
      {
        role: "user",
        content: ["# Task", "Probe resilience", "", "# BehavioralContext", SAMPLE_CONTEXT].join(
          "\n",
        ),
      },
    ],
    assertions: [
      { type: "contains", value: '"grounding"', description: "Has grounding field" },
      { type: "contains", value: '"quote"', description: "Has quote field" },
    ],
  },
  {
    id: "behavioral-tester-resilience-concern",
    description: "Can emit resilience-tagged concerns when failure modes exist",
    systemPrompt: BEHAVIORAL_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          "# BehavioralContext",
          SAMPLE_CONTEXT,
          "",
          "# Instructions",
          "Include at least one claim with concern resilience when failureModes are present.",
        ].join("\n"),
      },
    ],
    assertions: [
      { type: "contains", value: "resilience", description: "Mentions resilience concern" },
      { type: "contains", value: '"test"', description: "Includes test field" },
    ],
  },
]
