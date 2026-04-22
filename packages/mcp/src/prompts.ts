export interface McpPromptDefinition {
  name: string
  description: string
  arguments?: Array<{ name: string; description: string; required?: boolean }>
  template: string
}

export const prompts: McpPromptDefinition[] = [
  {
    name: "verify-and-fix",
    description: "Verify this workspace and fix any issues found",
    template: [
      "Run bollard_verify on this workspace.",
      "If any checks fail:",
      "1. Read the failing files",
      "2. Identify the root cause of each failure",
      "3. Suggest specific fixes with code snippets",
      "4. After fixing, re-run bollard_verify to confirm",
    ].join("\n"),
  },
  {
    name: "contract-review",
    description: "Review the contract graph for risks and violations",
    arguments: [
      { name: "focus", description: "Optional module or edge to focus on", required: false },
    ],
    template: [
      "Run bollard_contract to get the module dependency graph.",
      "Analyze the graph for:",
      "- Circular dependencies",
      "- Modules with too many dependents (high fan-in)",
      "- Cross-boundary exports that should be internal",
      "- Recently changed edges that may indicate contract violations",
      "Summarize findings with specific module names and recommendations.",
    ].join("\n"),
  },
  {
    name: "behavioral-audit",
    description: "Audit behavioral coverage and identify gaps",
    template: [
      "Run bollard_behavioral to get the behavioral context catalog.",
      "Review:",
      "- Endpoints without failure mode coverage",
      "- External dependencies without resilience testing",
      "- Configuration surfaces without validation tests",
      "Prioritize gaps by risk: external-facing endpoints first, then internal APIs.",
    ].join("\n"),
  },
]
