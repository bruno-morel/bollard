import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import type { GeneratedFile, IdeGeneratorResult } from "../init-ide.js"
import { renderTemplate } from "../template-renderer.js"

const CURSOR_RULES_TEMPLATE = `---
rule-type: Always
---

# Bollard — Artifact Integrity Framework

This project uses Bollard for adversarial verification. You have Bollard MCP tools available.

## WHY USE BOLLARD MCP TOOLS

Bollard MCP tools understand this project's language, framework, test runner, linter, and
verification layers. They auto-detect the toolchain and run the correct checks. Raw shell
commands (\`pnpm run lint\`, \`docker compose run ... test\`, \`npx tsc\`) do NOT — they may use
wrong config, miss checks, or produce unstructured output you cannot act on.

**\`bollard_verify\` returns structured results:** each check (typecheck, lint, audit, secrets)
reports pass/fail with the specific error output. When checks fail, you get actionable
diagnostics. Raw commands give you a wall of text.

**Use the MCP tools. Do not bypass them.**

## CRITICAL: DO NOT RUN VERIFICATION COMMANDS DIRECTLY

Do NOT run any of the following commands yourself. Use \`bollard_verify\` instead:

- ❌ \`pnpm run typecheck\` / \`pnpm exec tsc\` / \`npx tsc\`
- ❌ \`pnpm run lint\` / \`pnpm exec biome\` / \`npx biome\`
- ❌ \`pnpm audit\`
- ❌ \`docker compose run --rm dev run typecheck\`
- ❌ \`docker compose run --rm dev run lint\`
- ❌ \`docker compose run --rm dev run test\`

✅ Instead, call \`bollard_verify\`. It runs ALL of these checks with the correct toolchain
profile and returns structured, actionable results.

The only exception: \`pnpm run test\` or \`pnpm exec vitest\` for running tests during
implementation (the coder workflow). Verification checks go through \`bollard_verify\`.

## VERIFICATION PROTOCOL (MANDATORY)

You MUST follow these rules in every task. They are non-negotiable.

### 1. AFTER COMPLETING IMPLEMENTATION — ALWAYS VERIFY

When you finish implementing a logical unit of work (a feature, a fix, a refactor),
you MUST call \`bollard_verify\` before doing anything else. This is not optional.

- If \`bollard_verify\` reports failures: fix every failure before continuing.
- Do NOT tell the user "verification failed, you can fix it" — fix it yourself.
- Do NOT skip verification because "it's a small change." Small changes break builds.
- Do NOT move to the next task until \`bollard_verify\` passes.

### 2. BEFORE ANY GIT COMMIT — VERIFY AND DRIFT-CHECK

Before running \`git commit\`, you MUST:
1. Call \`bollard_verify\` — if it fails, fix and re-verify.
2. Call \`bollard_drift_check\` — if drift is detected, report it to the user.
3. Only after both pass: proceed with the commit.

Never commit unverified code. Never skip drift check.

### 3. BEFORE MODIFYING CROSS-MODULE INTERFACES — CHECK CONTRACTS

Before changing any export, public API, or cross-module interface, you MUST:
1. Call \`bollard_contract\` to see the module dependency graph.
2. Identify which modules depend on the interface you are changing.
3. After the change: call \`bollard_verify\` to confirm nothing broke downstream.

### 4. WHEN TOUCHING ENDPOINTS, CONFIG, OR EXTERNAL INTEGRATIONS — CHECK BEHAVIORAL

When modifying HTTP endpoints, configuration surfaces, external service calls,
or failure handling, call \`bollard_behavioral\` to see what Bollard knows about
the system's observable behavior.

### 5. DO NOT VERIFY ON EVERY SMALL EDIT

Verification is expensive (typecheck + lint + audit + secret scanning).
Call it at logical checkpoints:
- Implementation of a task complete
- Before committing
- After a refactor that touches multiple files
- When the user asks

DO NOT call \`bollard_verify\` after every individual file edit. That wastes resources.

## BEFORE REPORTING COMPLETION — SELF-CHECK

Before telling the user you are done, review your actions:

- [ ] Did you call \`bollard_verify\` after implementation? If not, do it now.
- [ ] Did all checks pass? If not, fix the failures first.
- [ ] If you changed exports or cross-module interfaces, did you call \`bollard_contract\` first?
- [ ] Did you avoid running raw shell verification commands (tsc, biome, pnpm audit)?

If you skipped any step, go back and complete it before reporting done.

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

## Adversarial Testing

Bollard generates adversarial tests automatically across three scopes:
- **Boundary** — edge cases, invalid inputs, error paths
- **Contract** — cross-module assumptions, interface compliance
- **Behavioral** — endpoint behavior, failure modes, config surface

Your tests should focus on happy-path behavior and integration scenarios.
Do NOT write boundary, contract, or behavioral edge-case tests — Bollard handles those.

## Available MCP Tools

| Tool | When to use |
|------|------------|
| \`bollard_verify\` | After implementation, before commit, after refactor |
| \`bollard_contract\` | Before changing exports or cross-module interfaces |
| \`bollard_behavioral\` | When touching endpoints, config, or failure handling |
| \`bollard_probe_run\` | To test live deployed endpoints |
| \`bollard_drift_check\` | Before committing — detect unverified changes |
| \`bollard_implement\` | To run the full 28-node pipeline for a task |
`

const CURSOR_CMD_VERIFY = `---
description: Run Bollard static verification (typecheck, lint, audit)
---

Run Bollard verification on the current workspace. Use the \`bollard_verify\` MCP tool
to check typecheck, lint, and audit status. If any check fails, explain what went wrong
and suggest fixes.
`

const CURSOR_CMD_IMPLEMENT = `---
description: Run full Bollard implement-feature pipeline (28 nodes)
---

Run the full Bollard implement-feature pipeline. Ask the user for a task description,
then use \`bollard_implement\` with the task. Monitor progress and report the outcome
of each pipeline node.
`

const CURSOR_CMD_CONTRACT = `---
description: Inspect module dependency graph and contract edges
---

Inspect the contract-scope module graph using \`bollard_contract\`. Show the module
dependency structure, highlight any affected edges from recent changes, and identify
potential contract violations.
`

const CURSOR_CMD_DRIFT = `---
description: Check for code drift since last verification
---

Check for code drift since the last verified deployment using \`bollard_drift_check\`.
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
    "Verification protocol: agent verifies at logical checkpoints (see rules file)",
    "See .cursor/bollard-automations-guide.md for scheduled automation setup",
    "",
    "⚠ ACTION REQUIRED: Enable the Bollard MCP server in Cursor:",
    "  Cursor Settings → Tools → bollard tab → toggle ON under Workspace MCP Servers",
    "  (Cursor disables new workspace MCP servers by default for security)",
  )

  return { platform: "cursor", files, messages }
}
