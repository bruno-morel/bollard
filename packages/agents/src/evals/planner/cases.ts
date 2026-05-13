import type { EvalCase } from "@bollard/engine/src/eval-runner.js"

const PLANNER_SYSTEM =
  "You are a planning agent. Analyze the task and produce a JSON plan with: summary, acceptance_criteria (array), affected_files (object with modify/create/delete arrays), risk_assessment (object with blast_radius/reversibility/dollars_at_risk/security_sensitivity/novelty numbers and rationale string), steps (array of objects with description, files, tests, and optional runtimeConstraints array), non_goals (array of explicit out-of-scope items), notes. Each step's runtimeConstraints should list facts the test agent needs but can't infer from type signatures: filesystem requirements, validation strictness, allowlists, edge-case semantics. Output ONLY valid JSON."

export const plannerEvalCases: EvalCase[] = [
  {
    id: "planner-valid-json",
    description: "Simple task produces valid plan JSON with required fields",
    systemPrompt: PLANNER_SYSTEM,
    messages: [{ role: "user", content: "Task: Add a health check endpoint that returns 200 OK" }],
    assertions: [
      { type: "matches_regex", value: "\\{", description: "Response starts with JSON" },
      { type: "contains", value: "summary", description: "Contains summary field" },
      {
        type: "contains",
        value: "acceptance_criteria",
        description: "Contains acceptance_criteria",
      },
      { type: "contains", value: "affected_files", description: "Contains affected_files" },
      { type: "contains", value: "risk_assessment", description: "Contains risk_assessment" },
      { type: "contains", value: "steps", description: "Contains steps" },
      { type: "contains", value: "non_goals", description: "Contains non_goals" },
    ],
  },
  {
    id: "planner-security-risk",
    description: "Security-sensitive task gets non-zero security_sensitivity",
    systemPrompt: PLANNER_SYSTEM,
    messages: [
      {
        role: "user",
        content: "Task: Modify the authentication flow to support OAuth2 tokens",
      },
    ],
    assertions: [
      { type: "contains", value: "security_sensitivity", description: "Has security field" },
      {
        type: "not_contains",
        value: '"security_sensitivity": 0',
        description: "Security score is not zero for auth task",
      },
    ],
  },
  {
    id: "planner-has-steps",
    description: "Plan includes actionable steps with files",
    systemPrompt: PLANNER_SYSTEM,
    messages: [
      { role: "user", content: "Task: Add input validation to the user registration form" },
    ],
    assertions: [
      { type: "contains", value: "steps", description: "Has steps" },
      { type: "contains", value: "files", description: "Steps reference files" },
    ],
  },
  {
    id: "planner-affected-files-nonempty",
    description: "Affected files list is non-empty for any real task",
    systemPrompt: PLANNER_SYSTEM,
    messages: [{ role: "user", content: "Task: Add retry logic to the HTTP client" }],
    assertions: [
      { type: "contains", value: "affected_files", description: "Has affected_files" },
      {
        type: "not_contains",
        value: '"modify": []',
        description: "modify list is not empty (or create has entries)",
      },
    ],
  },
  {
    id: "planner-constraints-filesystem",
    description:
      "Filesystem-sensitive task produces runtimeConstraints mentioning path or directory",
    systemPrompt: PLANNER_SYSTEM,
    messages: [
      {
        role: "user",
        content:
          "Task: Add path-traversal validation to the file upload handler. Files must not escape the uploads/ directory. Write the handler and tests.",
      },
    ],
    assertions: [
      {
        type: "contains",
        value: "runtimeConstraints",
        description: "Plan includes runtimeConstraints field",
      },
      {
        type: "matches_regex",
        value: "path|directory|filesystem|temp|workDir",
        description: "At least one constraint mentions filesystem concepts",
      },
    ],
  },
  {
    id: "planner-constraints-rate-limiting",
    description: "Rate-limiting task produces runtimeConstraints mentioning limits or errors",
    systemPrompt: PLANNER_SYSTEM,
    messages: [
      {
        role: "user",
        content:
          "Task: Add rate limiting to the /api/search endpoint. Limit to 100 requests per minute per API key. Return 429 when exceeded.",
      },
    ],
    assertions: [
      {
        type: "contains",
        value: "runtimeConstraints",
        description: "Plan includes runtimeConstraints field",
      },
      {
        type: "matches_regex",
        value: "limit|rate|429|request|error",
        description: "At least one constraint mentions rate limiting concepts",
      },
    ],
  },
]
