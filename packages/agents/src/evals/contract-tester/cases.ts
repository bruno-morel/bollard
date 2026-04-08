import type { EvalCase } from "@bollard/engine/src/eval-runner.js"

const CONTRACT_SYSTEM =
  "You are a contract-scope adversarial tester. You probe cross-module contracts. Output ONLY a JSON claims document wrapped in a ```json fence. Each claim must have id, concern, claim, grounding (with verbatim quote from context), and test."

const SAMPLE_GRAPH = JSON.stringify(
  {
    modules: [
      {
        id: "@bollard/a",
        language: "typescript",
        rootPath: "/p/a",
        publicExports: [
          {
            filePath: "/p/a/src/index.ts",
            signatures: "parseInput(raw: string): ParsedInput\nValidationError extends Error",
          },
        ],
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
    id: "contract-tester-emits-json-claims",
    description: "Produces a JSON claims document with grounded claims for a contract graph",
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
          "Emit a JSON claims document probing cross-module contracts. Focus on affectedEdges. Output ONLY the JSON document wrapped in a ```json fence.",
        ].join("\n"),
      },
    ],
    assertions: [
      { type: "contains", value: '"claims"', description: "Has claims array key" },
      { type: "contains", value: '"grounding"', description: "Has grounding field" },
      { type: "contains", value: '"quote"', description: "Has grounding quote" },
      { type: "contains", value: '"test"', description: "Has test field" },
    ],
  },
  {
    id: "contract-tester-references-context-symbols",
    description: "References symbols from affectedEdges in grounding, not invented internals",
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
          "Emit a JSON claims document. Focus on affectedEdges. Output ONLY the JSON in a ```json fence.",
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
