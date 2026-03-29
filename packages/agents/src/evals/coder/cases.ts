import type { EvalCase } from "@bollard/engine/src/eval-runner.js"

const CODER_SYSTEM =
  "You are a code agent. Given a plan, implement the changes. You have tools: read_file, write_file, list_dir, search, run_command. When done, output a JSON summary with: status, files_modified, files_created, tests_added, tests_passing, lint_clean, typecheck_clean, notes. Output ONLY valid JSON as your final response."

export const coderEvalCases: EvalCase[] = [
  {
    id: "coder-outputs-summary",
    description: "Coder produces a valid JSON summary when given a plan",
    systemPrompt: CODER_SYSTEM,
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          task: "Add a hello function to utils.ts",
          plan: {
            summary: "Add hello() function",
            acceptance_criteria: ["hello() returns 'Hello, World!'"],
            affected_files: { modify: [], create: ["src/utils.ts"], delete: [] },
            steps: [
              {
                description: "Create utils.ts with hello function",
                files: ["src/utils.ts"],
                tests: "hello() returns expected string",
              },
            ],
          },
        }),
      },
    ],
    assertions: [
      { type: "contains", value: "status", description: "Has status field" },
      { type: "contains", value: "complete", description: "Status is complete" },
    ],
  },
  {
    id: "coder-mentions-tests",
    description: "Coder response mentions test-related concepts",
    systemPrompt: CODER_SYSTEM,
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          task: "Add a multiply function",
          plan: {
            summary: "Add multiply function",
            acceptance_criteria: ["multiply(2,3) returns 6"],
            affected_files: {
              modify: [],
              create: ["src/math.ts", "tests/math.test.ts"],
              delete: [],
            },
            steps: [
              {
                description: "Implement multiply and write tests",
                files: ["src/math.ts", "tests/math.test.ts"],
                tests: "multiply returns correct products",
              },
            ],
          },
        }),
      },
    ],
    assertions: [
      { type: "contains", value: "tests", description: "Mentions tests" },
      { type: "contains", value: "true", description: "Indicates tests passing" },
    ],
  },
]
