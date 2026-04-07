import type { EvalCase } from "@bollard/engine/src/eval-runner.js"

const CONTRACT_SYSTEM =
  "You are a contract-scope adversarial tester. You probe cross-module contracts. Output ONLY a single test file using the requested framework. No markdown fences."

const SAMPLE_GRAPH = JSON.stringify(
  {
    modules: [
      {
        id: "@bollard/a",
        language: "typescript",
        rootPath: "/p/a",
        publicExports: [],
        errorTypes: ["ValidationError"],
      },
      {
        id: "@bollard/b",
        language: "typescript",
        rootPath: "/p/b",
        publicExports: [],
        errorTypes: [],
      },
    ],
    edges: [
      {
        from: "@bollard/b",
        to: "@bollard/a",
        importedSymbols: ["parseInput"],
        providerErrors: ["ValidationError"],
        consumerCatches: [],
      },
    ],
    affectedEdges: [
      {
        from: "@bollard/b",
        to: "@bollard/a",
        importedSymbols: ["parseInput"],
        providerErrors: ["ValidationError"],
        consumerCatches: [],
      },
    ],
  },
  null,
  2,
)

export const contractTesterEvalCases: EvalCase[] = [
  {
    id: "contract-tester-emits-vitest-file",
    description: "Produces Vitest-shaped test output for a contract graph",
    systemPrompt: CONTRACT_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          "# Task",
          "Harden boundary between @bollard/a and @bollard/b",
          "",
          "# ContractContext",
          SAMPLE_GRAPH,
          "",
          "# Plan summary",
          "Ensure ValidationError from provider is observable at consumer",
          "",
          "# Acceptance criteria",
          "1. Consumer handles or propagates ValidationError correctly",
          "",
          "# Instructions",
          "Write one test file probing cross-module contracts. Output ONLY the test code.",
        ].join("\n"),
      },
    ],
    assertions: [
      { type: "contains", value: "import", description: "Has imports" },
      { type: "contains", value: "describe", description: "Has describe" },
      { type: "contains", value: "it(", description: "Has it(" },
      { type: "contains", value: "expect", description: "Has expect" },
    ],
  },
  {
    id: "contract-tester-mentions-affected-edge",
    description: "References symbols from affectedEdges, not invented internals",
    systemPrompt: CONTRACT_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          "# Task",
          "Contract tests for module graph",
          "",
          "# ContractContext",
          SAMPLE_GRAPH,
          "",
          "# Instructions",
          "Focus on affectedEdges. Output ONLY Vitest TypeScript.",
        ].join("\n"),
      },
    ],
    assertions: [
      { type: "contains", value: "parseInput", description: "Uses imported symbol from graph" },
      { type: "contains", value: "ValidationError", description: "Mentions provider error type" },
      { type: "not_contains", value: "_secretInternal", description: "No invented private ids" },
    ],
  },
]
