import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import type { GeneratedFile, IdeGeneratorResult } from "../init-ide.js"

const CC_CMD_VERIFY = `---
description: Run Bollard static verification
tools: [Bash]
---

Run Bollard verification. Execute:
\`\`\`
docker compose run --rm dev --filter @bollard/cli run start -- verify
\`\`\`

Report the results. If any check fails, explain the failure and suggest a fix.
If $ARGUMENTS is provided, use it as --work-dir.
`

const CC_CMD_IMPLEMENT = `---
description: Run full Bollard implement-feature pipeline
tools: [Bash, Read, Write, Edit]
---

Run the Bollard implement-feature pipeline for the task described in $ARGUMENTS.
Execute:
\`\`\`
docker compose run --rm -e BOLLARD_AUTO_APPROVE=1 dev sh -c \\
  'pnpm --filter @bollard/cli run start -- run implement-feature --task "$ARGUMENTS" --work-dir /app'
\`\`\`

Monitor the output and report progress for each of the 28 pipeline nodes.
`

const CC_CMD_CONTRACT = `---
description: Inspect module contract graph
tools: [Bash]
---

Print the Bollard contract graph. Execute:
\`\`\`
docker compose run --rm dev --filter @bollard/cli run start -- contract
\`\`\`

Summarize the modules, edges, and any cross-module dependencies.
If $ARGUMENTS contains a plan JSON path, add --plan $ARGUMENTS.
`

const CC_CMD_PROBE = `---
description: Run HTTP probes against services
tools: [Bash]
---

Run Bollard HTTP probes. Execute:
\`\`\`
docker compose run --rm dev --filter @bollard/cli run start -- probe run
\`\`\`

Report probe results. If $ARGUMENTS contains a URL, add --url $ARGUMENTS.
`

const CC_AGENT_VERIFIER = `---
role: Bollard Verification Agent
tools: [Bash, Read]
permissions: auto
model: claude-sonnet-4-6
---

You are Bollard's verification agent. Your only job is to verify code changes.

When asked to verify:
1. Run \`docker compose run --rm dev --filter @bollard/cli run start -- verify\`
2. If checks fail, read the failing files and explain exactly what's wrong
3. Suggest specific fixes with code snippets
4. Never modify files yourself — only report findings

When asked about contracts:
1. Run \`docker compose run --rm dev --filter @bollard/cli run start -- contract\`
2. Summarize the module graph and highlight any concerning dependencies

When asked about behavioral coverage:
1. Run \`docker compose run --rm dev --filter @bollard/cli run start -- behavioral\`
2. List discovered endpoints, failure modes, and gaps in coverage

Always report findings in structured format: PASS/FAIL, affected files, specific issues.
`

const CLAUDE_MD_SECTION = `

## Bollard Integration

This project uses Bollard for adversarial verification. You have access to Bollard MCP tools.
Follow the verification protocol below. These rules are mandatory.

### VERIFICATION PROTOCOL

**AFTER completing implementation:** Call \`bollard_verify\`. Fix all failures before continuing.
Do not tell the user to fix issues — fix them yourself. Do not skip for "small changes."

**BEFORE any git commit:** Call \`bollard_verify\` and \`bollard_drift_check\`. Both must pass.

**BEFORE changing exports or cross-module interfaces:** Call \`bollard_contract\` to understand
the dependency graph. After the change, call \`bollard_verify\` to confirm nothing broke.

**WHEN touching endpoints, config, or external integrations:** Call \`bollard_behavioral\`
to see what Bollard knows about the system's observable behavior.

**DO NOT verify after every small edit.** Verify at logical checkpoints: implementation
complete, before commit, after refactor, when the user asks.

### Available tools
- \`bollard_verify\` — static checks (typecheck, lint, audit, secrets)
- \`bollard_contract\` — module dependency graph JSON
- \`bollard_behavioral\` — endpoint and failure mode catalog
- \`bollard_probe_run\` — execute HTTP probes against live services
- \`bollard_drift_check\` — detect code drift since last verification
`

export async function generateClaudeCodeConfig(
  cwd: string,
  _profile: ToolchainProfile,
): Promise<IdeGeneratorResult> {
  const files: GeneratedFile[] = []
  const messages: string[] = []

  files.push({
    path: ".mcp.json",
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

  files.push(
    { path: ".claude/commands/bollard-verify.md", content: CC_CMD_VERIFY },
    { path: ".claude/commands/bollard-implement.md", content: CC_CMD_IMPLEMENT },
    { path: ".claude/commands/bollard-contract.md", content: CC_CMD_CONTRACT },
    { path: ".claude/commands/bollard-probe.md", content: CC_CMD_PROBE },
  )

  files.push({
    path: ".claude/agents/bollard-verifier.md",
    content: CC_AGENT_VERIFIER,
  })

  // deepMerge replaces arrays (does not concat). Re-running init replaces the hooks array;
  // hook entries use unique name fields and users may curate manually after merge.
  files.push({
    path: ".claude/settings.json",
    content: JSON.stringify(
      {
        hooks: [
          {
            name: "bollard-lint-pre-commit",
            if: "Bash(git commit*)",
            run: "docker compose run --rm -T dev --filter @bollard/cli run start -- verify --quiet",
            async: false,
          },
        ],
      },
      null,
      2,
    ),
    merge: true,
  })

  const claudeMdPath = join(cwd, "CLAUDE.md")
  const claudeMdMarker = "## Bollard Integration"
  if (existsSync(claudeMdPath)) {
    const existing = readFileSync(claudeMdPath, "utf-8")
    if (!existing.includes(claudeMdMarker)) {
      files.push({
        path: "CLAUDE.md",
        content: CLAUDE_MD_SECTION,
        appendText: true,
      })
      messages.push("Appended Bollard integration section to existing CLAUDE.md")
    } else {
      messages.push("CLAUDE.md already has Bollard section — skipped")
    }
  } else {
    files.push({
      path: "CLAUDE.md",
      content: CLAUDE_MD_SECTION,
    })
    messages.push("Created CLAUDE.md with Bollard integration section")
  }

  messages.push(
    "MCP tools available: bollard_verify, bollard_contract, bollard_behavioral, bollard_probe_run, bollard_drift_check",
    "Slash commands: /bollard-verify, /bollard-implement, /bollard-contract, /bollard-probe",
    "Subagent: @bollard-verifier for verification tasks",
    "Hooks: blocking pre-commit verification gate",
  )

  return { platform: "claude-code", files, messages }
}
