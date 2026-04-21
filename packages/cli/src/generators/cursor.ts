import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import type { GeneratedFile, IdeGeneratorResult } from "../init-ide.js"
import { renderTemplate } from "../template-renderer.js"

const CURSOR_RULES_TEMPLATE = `---
rule-type: Always
---

# Bollard — Artifact Integrity Framework

This project uses Bollard for adversarial verification. Every code change must pass boundary, contract, and behavioral verification.

## Verification Commands

Before submitting any code change, run:
- \`bollard_verify\` — static checks (typecheck, lint, audit)
- \`bollard_contract\` — inspect module dependency graph
- \`bollard_behavioral\` — inspect endpoint and failure mode catalog

## Coding Standards ({{language}})

{{#if isTypeScript}}- All errors must use structured error types (not raw strings)
- All public APIs must have explicit return type annotations
- No \`any\` types — use \`unknown\` and narrow
- No default exports — named exports only
- Test files co-located in \`tests/\` directories{{/if}}{{#if isPython}}- All public functions must have type hints (PEP 484)
- No bare \`except:\` — always catch specific exceptions
- Use \`dataclass\` or \`TypedDict\` for structured data
- Test files in \`tests/\` parallel to source{{/if}}{{#if isGo}}- All exported functions must have doc comments
- Error handling: return errors, don't panic
- Test files co-located as \`_test.go\`{{/if}}{{#if isRust}}- No \`unwrap()\` in production code — use \`?\` or explicit error handling
- All public items must have \`///\` doc comments
- Test modules co-located in source files{{/if}}{{#if isJava}}- All public methods must have Javadoc
- Use structured exceptions, not raw RuntimeException
- Test files in \`src/test/java/\` mirroring source{{/if}}{{#if isKotlin}}- All public functions must have KDoc
- Use sealed classes for error hierarchies
- Test files in \`src/test/kotlin/\` mirroring source{{/if}}

## When Writing Tests

Bollard generates adversarial tests automatically. Your tests should focus on:
- Happy-path behavior and integration scenarios
- Bollard handles: boundary edge cases, contract assumptions, behavioral failure modes

## Available Bollard MCP Tools

Use \`bollard_verify\` to check code, \`bollard_contract\` to inspect module graph,
\`bollard_behavioral\` to inspect endpoints and failure modes, \`bollard_probe_run\`
to test live endpoints, \`bollard_drift_check\` to detect code drift.
`

const CURSOR_CMD_VERIFY = `Run Bollard verification on the current workspace. Use the \`bollard_verify\` MCP tool
to check typecheck, lint, and audit status. If any check fails, explain what went wrong
and suggest fixes.
`

const CURSOR_CMD_IMPLEMENT = `Run the full Bollard implement-feature pipeline. Ask the user for a task description,
then use \`bollard_implement\` with the task. Monitor progress and report the outcome
of each pipeline node.
`

const CURSOR_CMD_CONTRACT = `Inspect the contract-scope module graph using \`bollard_contract\`. Show the module
dependency structure, highlight any affected edges from recent changes, and identify
potential contract violations.
`

const CURSOR_CMD_DRIFT = `Check for code drift since the last verified deployment using \`bollard_drift_check\`.
If drift is detected, recommend running verification before the next deployment.
`

const CURSOR_AUTOMATIONS_GUIDE = `# Bollard Cursor Automations

Set up these automations in Cursor Settings > Automations:

## Nightly Verification
- **Trigger:** Schedule (daily, 2:00 AM)
- **Instruction:** Run \`bollard_verify\` on the project and report any regressions.

## PR Verification
- **Trigger:** GitHub PR opened
- **Instruction:** Run \`bollard_contract\` and \`bollard_behavioral\` on the changed files.
  Report any contract violations or behavioral regressions as PR comments.

## Post-Deploy Probe Check
- **Trigger:** GitHub deployment event
- **Instruction:** Run \`bollard_probe_run\` against the staging URL. If any probes fail,
  alert the team via Slack.
`

export async function generateCursorConfig(
  _cwd: string,
  profile: ToolchainProfile,
): Promise<IdeGeneratorResult> {
  const files: GeneratedFile[] = []
  const messages: string[] = []

  files.push({
    path: ".cursor/mcp.json",
    content: JSON.stringify(
      {
        mcpServers: {
          bollard: {
            command: "docker",
            args: [
              "compose",
              "run",
              "--rm",
              "-T",
              "dev",
              "--filter",
              "@bollard/mcp",
              "run",
              "start",
            ],
            env: {
              ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}",
            },
          },
        },
      },
      null,
      2,
    ),
    merge: true,
  })

  files.push({
    path: ".cursor/rules/bollard.mdc",
    content: renderTemplate(CURSOR_RULES_TEMPLATE, profile),
  })

  files.push({
    path: ".cursor/hooks.json",
    content: JSON.stringify(
      {
        version: 1,
        hooks: {
          afterFileEdit: [
            {
              command:
                "docker compose run --rm -T dev --filter @bollard/cli run start -- verify --quiet",
              description: "Bollard: verify after edit",
            },
          ],
        },
      },
      null,
      2,
    ),
  })

  files.push(
    { path: ".cursor/commands/bollard-verify.md", content: CURSOR_CMD_VERIFY },
    { path: ".cursor/commands/bollard-implement.md", content: CURSOR_CMD_IMPLEMENT },
    { path: ".cursor/commands/bollard-contract.md", content: CURSOR_CMD_CONTRACT },
    { path: ".cursor/commands/bollard-drift.md", content: CURSOR_CMD_DRIFT },
  )

  files.push({
    path: ".cursor/bollard-automations-guide.md",
    content: CURSOR_AUTOMATIONS_GUIDE,
  })

  messages.push(
    "MCP tools available: bollard_verify, bollard_contract, bollard_behavioral, bollard_probe_run, bollard_drift_check",
    "Slash commands: /bollard-verify, /bollard-implement, /bollard-contract, /bollard-drift",
    "Hooks: afterFileEdit runs bollard verify --quiet automatically",
    "See .cursor/bollard-automations-guide.md for scheduled automation setup",
  )

  return { platform: "cursor", files, messages }
}
