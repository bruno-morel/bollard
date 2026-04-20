# Stage 4d — Developer Experience & Agent Integrations

> **Status:** Planning  
> **Prerequisite:** Stage 4c Part 2 GREEN (Java/Kotlin Wave 1)  
> **Spec version:** 2026-04-17

---

## 1. Goal

Make Bollard a first-class citizen inside the AI coding agents developers actually use. Today, Bollard is a Docker-only CLI with an MCP server. After Stage 4d, `bollard init` generates platform-specific configuration that gives each agent deep, native Bollard integration — not just tool access, but rules, hooks, commands, and automated verification workflows.

**Primary targets (deep integration):**

- **Cursor** — rules files, hooks, slash commands, automations templates
- **Claude Code** — CLAUDE.md patterns, hooks, slash commands, subagents, skills, plugin packaging

**Secondary targets (MCP + config templates):**

- **Google Antigravity** — MCP config, basic setup guide
- **OpenAI Codex** — MCP config, basic setup guide

**What ships:**

1. **`bollard init --ide <platform>`** — generates platform-specific config files alongside `.bollard.yml`
2. **Cursor integration bundle** — `.cursor/rules/bollard.mdc`, hooks, slash commands, MCP config
3. **Claude Code integration bundle** — `.claude/` commands, agents, hooks, settings, CLAUDE.md augmentation
4. **MCP server v2** — richer tool descriptions, resource endpoints, prompt templates, progress streaming
5. **Antigravity / Codex config generators** — `mcp_config.json` / `.codex/config.toml` templates
6. **`bollard watch`** — file-watcher mode that re-verifies on save (feeds hooks and automations)

---

## 2. Integration Architecture

### 2.1 The Three Layers

Every platform integration follows the same three-layer model:

| Layer | What it does | Cursor | Claude Code | Antigravity | Codex |
|-------|-------------|--------|-------------|-------------|-------|
| **L1: MCP tools** | Expose Bollard operations as callable tools | `.cursor/mcp.json` | `.mcp.json` | `mcp_config.json` | `.codex/config.toml` |
| **L2: Context** | Inject Bollard knowledge into the agent's system prompt | `.cursor/rules/bollard.mdc` | `CLAUDE.md` augmentation | — | — |
| **L3: Automation** | Run Bollard automatically without explicit invocation | `.cursor/hooks.json` + automations | `.claude/settings.json` hooks | — | — |

**L1 is universal.** Every platform gets it. L2 and L3 are platform-specific and where the real DX value lives.

### 2.2 The `bollard init --ide` Command

Extends the existing `bollard init` command:

```bash
# Detect project + generate .bollard.yml + platform config
bollard init --ide cursor
bollard init --ide claude-code
bollard init --ide codex
bollard init --ide antigravity
bollard init --ide all          # generates configs for all detected platforms

# Without --ide, behaves as today (just .bollard.yml)
bollard init
```

When `--ide` is specified, `bollard init` additionally:

1. Detects which platform config directories already exist (`.cursor/`, `.claude/`, `.codex/`)
2. Generates platform-specific files (never overwrites existing files — merges or skips with warning)
3. Prints a summary of what was generated and what the agent can now do

---

## 3. Cursor Integration (Deep)

### 3.1 MCP Server Registration

**Generated file:** `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "bollard": {
      "command": "docker",
      "args": [
        "compose", "run", "--rm", "-T", "dev",
        "--filter", "@bollard/mcp", "run", "start"
      ],
      "env": {
        "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}"
      }
    }
  }
}
```

Alternative for non-Docker setups (when `bollard` CLI is on PATH):

```json
{
  "mcpServers": {
    "bollard": {
      "command": "npx",
      "args": ["-y", "@bollard/mcp"],
      "env": {
        "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}"
      }
    }
  }
}
```

### 3.2 Rules File

**Generated file:** `.cursor/rules/bollard.mdc`

```markdown
---
rule-type: Always
---

# Bollard — Artifact Integrity Framework

This project uses Bollard for adversarial verification. Every code change must pass boundary, contract, and behavioral verification.

## Verification Commands

Before submitting any code change, run:
- `bollard verify` — static checks (typecheck, lint, audit)
- `bollard contract` — inspect module dependency graph
- `bollard behavioral` — inspect endpoint and failure mode catalog

## Coding Standards

{{language-specific section generated from ToolchainProfile}}

- All errors must use structured error types (not raw strings)
- All public APIs must have type annotations
- Test files must be co-located with source or in a parallel `tests/` directory
- No `any` types (TypeScript) / no bare `except:` (Python) / no `unwrap()` in production (Rust)

## When Writing Tests

Bollard generates adversarial tests automatically. Your tests should focus on:
- Happy-path behavior and integration scenarios
- Bollard handles: boundary edge cases, contract assumptions, behavioral failure modes

## Available Bollard MCP Tools

Use `bollard_verify` to check code, `bollard_contract` to inspect module graph,
`bollard_behavioral` to inspect endpoints and failure modes, `bollard_probe_run`
to test live endpoints, `bollard_drift_check` to detect code drift.
```

The rules file is generated from the detected `ToolchainProfile` — language-specific sections are templated.

### 3.3 Hooks

**Generated file:** `.cursor/hooks.json`

```json
{
  "version": 1,
  "hooks": {
    "afterFileEdit": [
      {
        "command": "docker compose run --rm -T dev --filter @bollard/cli run start -- verify --quiet",
        "description": "Bollard: verify after edit"
      }
    ]
  }
}
```

This gives the agent immediate feedback when it writes code that breaks typecheck or lint. The `--quiet` flag (new) suppresses progress output and only emits a JSON result on failure.

### 3.4 Slash Commands

**Generated files:** `.cursor/commands/`

**`bollard-verify.md`:**
```markdown
Run Bollard verification on the current workspace. Use the `bollard_verify` MCP tool
to check typecheck, lint, and audit status. If any check fails, explain what went wrong
and suggest fixes.
```

**`bollard-implement.md`:**
```markdown
Run the full Bollard implement-feature pipeline. Ask the user for a task description,
then use `bollard_implement` with the task. Monitor progress and report the outcome
of each pipeline node.
```

**`bollard-contract.md`:**
```markdown
Inspect the contract-scope module graph using `bollard_contract`. Show the module
dependency structure, highlight any affected edges from recent changes, and identify
potential contract violations.
```

**`bollard-drift.md`:**
```markdown
Check for code drift since the last verified deployment using `bollard_drift_check`.
If drift is detected, recommend running verification before the next deployment.
```

### 3.5 Automations Templates (Documentation)

Bollard can't register Cursor Automations directly (they're cloud-configured), but we generate a guide:

**Generated file:** `.cursor/bollard-automations-guide.md`

```markdown
# Bollard Cursor Automations

Set up these automations in Cursor Settings > Automations:

## Nightly Verification
- **Trigger:** Schedule (daily, 2:00 AM)
- **Instruction:** Run `bollard_verify` on the project and report any regressions.

## PR Verification
- **Trigger:** GitHub PR opened
- **Instruction:** Run `bollard_contract` and `bollard_behavioral` on the changed files.
  Report any contract violations or behavioral regressions as PR comments.

## Post-Deploy Probe Check
- **Trigger:** GitHub deployment event
- **Instruction:** Run `bollard_probe_run` against the staging URL. If any probes fail,
  alert the team via Slack.
```

---

## 4. Claude Code Integration (Deep)

### 4.1 MCP Server Registration

**Generated file:** `.mcp.json` (project root)

```json
{
  "mcpServers": {
    "bollard": {
      "command": "docker",
      "args": [
        "compose", "run", "--rm", "-T", "dev",
        "--filter", "@bollard/mcp", "run", "start"
      ],
      "env": {
        "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}"
      }
    }
  }
}
```

### 4.2 CLAUDE.md Augmentation

`bollard init --ide claude-code` appends a Bollard section to the project's `CLAUDE.md` (or creates one if absent):

```markdown
## Bollard Integration

This project uses [Bollard](https://github.com/...) for adversarial verification.
Bollard MCP tools are available — use them to verify changes, inspect contracts,
and check behavioral coverage.

### Key commands
- `bollard_verify` — static checks (typecheck, lint, audit, secrets)
- `bollard_contract` — module dependency graph JSON
- `bollard_behavioral` — endpoint and failure mode catalog
- `bollard_probe_run` — execute HTTP probes against live services
- `bollard_drift_check` — detect code drift since last verification

### Workflow
1. Before implementing: check `bollard_contract` to understand module boundaries
2. After implementing: run `bollard_verify` to catch type/lint/audit issues
3. Before committing: check `bollard_drift_check` for unverified changes
```

### 4.3 Slash Commands

**Generated files:** `.claude/commands/`

**`bollard-verify.md`:**
```markdown
---
description: Run Bollard static verification
tools: [Bash]
---

Run Bollard verification. Execute:
```
docker compose run --rm dev --filter @bollard/cli run start -- verify
```

Report the results. If any check fails, explain the failure and suggest a fix.
If $ARGUMENTS is provided, use it as --work-dir.
```

**`bollard-implement.md`:**
```markdown
---
description: Run full Bollard implement-feature pipeline
tools: [Bash, Read, Write, Edit]
---

Run the Bollard implement-feature pipeline for the task described in $ARGUMENTS.
Execute:
```
docker compose run --rm -e BOLLARD_AUTO_APPROVE=1 dev sh -c \
  'pnpm --filter @bollard/cli run start -- run implement-feature --task "$ARGUMENTS" --work-dir /app'
```

Monitor the output and report progress for each of the 28 pipeline nodes.
```

**`bollard-contract.md`:**
```markdown
---
description: Inspect module contract graph
tools: [Bash]
---

Print the Bollard contract graph. Execute:
```
docker compose run --rm dev --filter @bollard/cli run start -- contract
```

Summarize the modules, edges, and any cross-module dependencies.
If $ARGUMENTS contains a plan JSON path, add --plan $ARGUMENTS.
```

**`bollard-probe.md`:**
```markdown
---
description: Run HTTP probes against services
tools: [Bash]
---

Run Bollard HTTP probes. Execute:
```
docker compose run --rm dev --filter @bollard/cli run start -- probe run
```

Report probe results. If $ARGUMENTS contains a URL, add --url $ARGUMENTS.
```

### 4.4 Custom Subagent

**Generated file:** `.claude/agents/bollard-verifier.md`

```markdown
---
role: Bollard Verification Agent
tools: [Bash, Read]
permissions: auto
model: claude-sonnet-4-6
---

You are Bollard's verification agent. Your only job is to verify code changes.

When asked to verify:
1. Run `docker compose run --rm dev --filter @bollard/cli run start -- verify`
2. If checks fail, read the failing files and explain exactly what's wrong
3. Suggest specific fixes with code snippets
4. Never modify files yourself — only report findings

When asked about contracts:
1. Run `docker compose run --rm dev --filter @bollard/cli run start -- contract`
2. Summarize the module graph and highlight any concerning dependencies

When asked about behavioral coverage:
1. Run `docker compose run --rm dev --filter @bollard/cli run start -- behavioral`
2. List discovered endpoints, failure modes, and gaps in coverage

Always report findings in structured format: PASS/FAIL, affected files, specific issues.
```

### 4.5 Hooks

**Generated additions to:** `.claude/settings.json`

```json
{
  "hooks": [
    {
      "name": "bollard-verify-on-edit",
      "if": "Edit|Write",
      "run": "docker compose run --rm -T dev --filter @bollard/cli run start -- verify --quiet 2>/dev/null || echo 'BOLLARD_VERIFY_FAILED'",
      "async": true
    },
    {
      "name": "bollard-lint-pre-commit",
      "if": "Bash(git commit*)",
      "run": "docker compose run --rm -T dev --filter @bollard/cli run start -- verify --quiet",
      "async": false
    }
  ]
}
```

The `async: true` hook runs verification in the background after each edit — if it fails, the agent sees the output and can self-correct. The pre-commit hook blocks the commit if verification fails.

### 4.6 Claude Code Plugin Packaging

Package the entire Claude Code integration as a **Bollard plugin** that can be installed via:

```bash
claude plugin add bollard
```

**Plugin structure:**

```
bollard-claude-code-plugin/
├── plugin.json           # Plugin manifest
├── .claude/
│   ├── commands/
│   │   ├── bollard-verify.md
│   │   ├── bollard-implement.md
│   │   ├── bollard-contract.md
│   │   └── bollard-probe.md
│   ├── agents/
│   │   └── bollard-verifier.md
│   └── skills/
│       └── bollard-verification/
│           └── SKILL.md    # Bollard verification expertise
└── .mcp.json               # MCP server config
```

**`plugin.json`:**
```json
{
  "name": "bollard",
  "version": "1.0.0",
  "description": "Adversarial verification for AI-assisted development",
  "commands": [
    "bollard-verify",
    "bollard-implement",
    "bollard-contract",
    "bollard-probe"
  ],
  "agents": ["bollard-verifier"],
  "skills": ["bollard-verification"],
  "mcpServers": {
    "bollard": {
      "command": "npx",
      "args": ["-y", "@bollard/mcp"]
    }
  }
}
```

---

## 5. Secondary Platform Integrations

### 5.1 Google Antigravity

**Generated file:** `mcp_config.json` (or guide to add to existing)

```json
{
  "mcpServers": {
    "bollard": {
      "command": "docker",
      "args": [
        "compose", "run", "--rm", "-T", "dev",
        "--filter", "@bollard/mcp", "run", "start"
      ],
      "env": {
        "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}"
      }
    }
  }
}
```

Antigravity uses MCP natively. The agent can invoke `bollard_verify`, `bollard_contract`, etc. directly from the Agent Manager. No rules or hooks integration (Antigravity doesn't have these features yet).

### 5.2 OpenAI Codex

**Generated file:** `.codex/config.toml`

```toml
[mcp_servers.bollard]
command = "docker"
args = [
  "compose", "run", "--rm", "-T", "dev",
  "--filter", "@bollard/mcp", "run", "start"
]

[mcp_servers.bollard.env]
ANTHROPIC_API_KEY = "$ANTHROPIC_API_KEY"
```

Codex supports MCP via its config.toml. The Codex agent can invoke Bollard tools like any other MCP server.

---

## 6. MCP Server v2 Enhancements

### 6.1 Richer Tool Descriptions

Current tool descriptions are terse. Enhance them to help agents understand when and how to use each tool:

| Tool | Current | v2 |
|------|---------|-----|
| `bollard_verify` | "Run static verification (typecheck, lint, audit) on the workspace" | "Run static verification checks — typecheck, lint, audit, and secret scanning. Returns structured results with pass/fail per check, affected files, and specific error messages. Run this after every code change." |
| `bollard_contract` | "Build contract-scope context (module graph + edges) as JSON" | "Analyze the module dependency graph. Returns modules, their public exports, edges between modules (who imports what from whom), and which edges are affected by recent changes. Use before modifying cross-module interfaces." |

Apply the same enrichment pattern to all 12 tools.

### 6.2 MCP Resources

Add MCP resource endpoints so agents can read Bollard state without calling tools:

```typescript
// New resources
bollard://profile          // Current ToolchainProfile JSON
bollard://config           // Resolved .bollard.yml config
bollard://contract-graph   // Latest contract graph (cached)
bollard://probes           // List of defined probes
bollard://flags            // Current feature flag states
bollard://last-verified    // Last verified SHA + timestamp
```

Resources are read-only and cache-friendly. Agents can subscribe to them for context without consuming tool-call turns.

### 6.3 MCP Prompt Templates

Add MCP prompt templates that agents can use as starting points:

```typescript
// New prompts
bollard://prompts/verify-and-fix    // "Verify this workspace and fix any issues"
bollard://prompts/contract-review   // "Review the contract graph for risks"
bollard://prompts/behavioral-audit  // "Audit behavioral coverage"
```

### 6.4 `--quiet` Flag for Hooks

Add `--quiet` flag to the CLI's `verify` command:

- Suppress all progress/spinner output
- On success: exit 0, no stdout
- On failure: exit 1, emit compact JSON to stdout:

```json
{
  "status": "fail",
  "checks": [
    { "label": "typecheck", "passed": false, "message": "2 errors in src/foo.ts" },
    { "label": "lint", "passed": true },
    { "label": "audit", "passed": true }
  ]
}
```

This makes hooks fast and machine-readable.

### 6.5 `bollard watch` Command

New CLI command for continuous verification:

```bash
# Watch mode — re-verify on file changes
bollard watch

# Watch with specific checks only
bollard watch --checks typecheck,lint

# Watch with custom debounce
bollard watch --debounce 2000
```

Uses `fs.watch` (or `chokidar` if needed) on `sourcePatterns`. Debounces rapid saves. Outputs structured results to stdout. This powers the async hook pattern — instead of running Docker on every save, the hook can check if `bollard watch` is already running and read its latest output.

---

## 7. New CLI Command: `bollard init --ide`

### 7.1 Detection Logic

```typescript
async function detectIdeEnvironment(cwd: string): Promise<string[]> {
  const ides: string[] = []
  if (await exists(join(cwd, ".cursor"))) ides.push("cursor")
  if (await exists(join(cwd, ".claude"))) ides.push("claude-code")
  if (await exists(join(cwd, ".codex"))) ides.push("codex")
  // Antigravity uses mcp_config.json but that could be anything
  return ides
}
```

### 7.2 Generation Logic

For each platform, `bollard init --ide <platform>`:

1. **Read** the existing platform config (if any)
2. **Generate** Bollard-specific files
3. **Merge** (never overwrite) — if `.cursor/mcp.json` already exists, add the Bollard server entry
4. **Report** what was generated

### 7.3 `.gitignore` Awareness

Some generated files should be committed (rules, commands, agents), others are personal (local settings). The generator adds appropriate entries:

**Committed (team-shared):**
- `.cursor/rules/bollard.mdc`
- `.cursor/commands/bollard-*.md`
- `.claude/commands/bollard-*.md`
- `.claude/agents/bollard-verifier.md`
- `.mcp.json`

**Not committed (personal or secrets):**
- `.cursor/hooks.json` (may contain personal preferences)
- `.claude/settings.local.json`

---

## 8. Implementation Plan

### 8.1 New Files

| File | Description |
|------|-------------|
| `packages/cli/src/init-ide.ts` | IDE-specific config generation logic |
| `packages/cli/src/watch.ts` | File-watcher mode for continuous verification |
| `packages/cli/src/quiet-verify.ts` | Quiet/JSON-only verification mode |
| `packages/mcp/src/resources.ts` | MCP resource endpoint implementations |
| `packages/mcp/src/prompts.ts` | MCP prompt template definitions |
| `templates/cursor/rules/bollard.mdc.hbs` | Handlebars template for Cursor rules (profile-driven) |
| `templates/cursor/hooks.json.hbs` | Template for Cursor hooks |
| `templates/cursor/commands/*.md` | Cursor slash command templates |
| `templates/cursor/automations-guide.md` | Static automation setup guide |
| `templates/claude-code/commands/*.md` | Claude Code slash command templates |
| `templates/claude-code/agents/bollard-verifier.md` | Subagent definition |
| `templates/claude-code/mcp.json.hbs` | MCP config template |
| `templates/claude-code/claude-md-section.md.hbs` | CLAUDE.md augmentation template |
| `templates/antigravity/mcp_config.json.hbs` | Antigravity MCP config |
| `templates/codex/config.toml.hbs` | Codex config template |
| `plugin/claude-code/plugin.json` | Claude Code plugin manifest |
| `plugin/claude-code/.claude/` | Plugin file bundle |

### 8.2 Modified Files

| File | Changes |
|------|---------|
| `packages/cli/src/index.ts` | Add `--ide` flag to `init`, add `watch` command |
| `packages/mcp/src/server.ts` | Register resources and prompts |
| `packages/mcp/src/tools.ts` | Enrich tool descriptions |
| `packages/cli/src/config.ts` | Export `resolveConfig` result shape for template vars |

### 8.3 Template Engine

Use simple string replacement (no Handlebars dependency). Templates use `{{variable}}` placeholders filled from the `ToolchainProfile`:

```typescript
function renderTemplate(template: string, profile: ToolchainProfile): string {
  return template
    .replace(/\{\{language\}\}/g, profile.language)
    .replace(/\{\{packageManager\}\}/g, profile.packageManager ?? "")
    .replace(/\{\{testCommand\}\}/g, profile.checks.test?.cmd ?? "")
    // ... etc
}
```

This reuses the existing `fillPromptTemplate` pattern from `@bollard/agents`.

---

## 9. Test Plan

### 9.1 Config Generation Tests (~16)

1. Cursor MCP config generated correctly
2. Cursor rules file populated from TS profile
3. Cursor rules file populated from Python profile
4. Cursor hooks generated with correct Docker commands
5. Cursor slash commands generated (4 files)
6. Claude Code MCP config generated
7. Claude Code CLAUDE.md section appended (not overwriting)
8. Claude Code slash commands generated (4 files)
9. Claude Code subagent file generated
10. Claude Code hooks added to settings.json
11. Antigravity mcp_config.json generated
12. Codex config.toml generated
13. Merge behavior: existing MCP config preserved
14. Skip behavior: existing Bollard entry not duplicated
15. `--ide all` generates configs for all platforms
16. No files generated when `--ide` omitted (backward compat)

### 9.2 MCP Enhancement Tests (~8)

1. Enriched tool descriptions are longer and more actionable
2. Resource `bollard://profile` returns valid ToolchainProfile
3. Resource `bollard://config` returns resolved config
4. Resource `bollard://probes` returns probe list
5. Resource `bollard://flags` returns flag states
6. Prompt `bollard://prompts/verify-and-fix` returns valid template
7. `--quiet` flag produces JSON output on failure
8. `--quiet` flag produces no output on success

### 9.3 Watch Mode Tests (~4)

1. Watch detects file changes in source patterns
2. Watch debounces rapid changes
3. Watch outputs structured JSON results
4. Watch ignores files matching ignore patterns

### 9.4 Plugin Packaging Tests (~2)

1. Plugin directory structure matches Claude Code plugin spec
2. Plugin manifest references all commands, agents, skills

**Total estimated new tests: ~30**

---

## 10. Validation Plan

### 10.1 Unit Tests

```bash
docker compose run --rm dev run test
# Target: ~759 (post-4c) + ~30 = ~789 tests
```

### 10.2 Integration: Cursor

1. Run `bollard init --ide cursor` on a TypeScript project
2. Open project in Cursor
3. Verify MCP tools appear in Cursor's tool list
4. Invoke `/bollard-verify` slash command
5. Edit a file — confirm hook runs verification
6. Verify `.cursor/rules/bollard.mdc` affects agent behavior

### 10.3 Integration: Claude Code

1. Run `bollard init --ide claude-code` on a TypeScript project
2. Launch `claude` in the project directory
3. Verify MCP tools are available
4. Invoke `/bollard-verify` slash command
5. Verify CLAUDE.md section is present
6. Verify subagent is available via `@bollard-verifier`
7. Test pre-commit hook blocks on verification failure

---

## 11. Commit Guidance

```
Stage 4d: CLI --quiet flag for machine-readable verify output
Stage 4d: MCP resource endpoints (profile, config, probes, flags)
Stage 4d: MCP prompt templates
Stage 4d: enrich MCP tool descriptions for agent discoverability
Stage 4d: config generation templates (cursor, claude-code, codex, antigravity)
Stage 4d: bollard init --ide command with platform detection
Stage 4d: Cursor integration (rules, hooks, commands)
Stage 4d: Claude Code integration (commands, agents, hooks, CLAUDE.md)
Stage 4d: bollard watch — continuous verification with file watcher
Stage 4d: Claude Code plugin packaging
```

---

## 12. Design Decisions

### 12.1 No New Dependencies

Templates use simple string replacement, not Handlebars or EJS. File watching uses Node's built-in `fs.watch` with a small debounce wrapper (no `chokidar`). TOML generation is string concatenation (Codex config is ~10 lines).

### 12.2 Merge, Never Overwrite

If `.cursor/mcp.json` already exists, `bollard init --ide cursor` reads it, adds the `bollard` server entry (if not already present), and writes it back. Same for `.mcp.json`, `.claude/settings.json`, etc. This respects existing developer configuration.

### 12.3 Docker-First, npm-Fallback

All generated configs use `docker compose run` as the default command. If Bollard detects it's running outside Docker (e.g., `npx @bollard/mcp`), it generates `npx`-based configs instead. The MCP server works identically in both modes.

### 12.4 Templates Live in the Bollard Repo

Templates are committed to `templates/` in the Bollard repo and baked into the CLI. They're not separate packages. This keeps the dependency chain simple and avoids versioning complexity.

### 12.5 Claude Code Plugin is Optional

The plugin is a convenience packaging of files that `bollard init --ide claude-code` already generates individually. Users who prefer manual setup use `init --ide`; users who want one-click install use the plugin. Both paths produce the same files.

---

## 13. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Cursor hooks API changes (beta) | Medium | Medium | Hooks config is a single JSON file; easy to update if API changes |
| Claude Code plugin format not stable | Medium | Medium | Plugin is optional; core integration is file-based |
| MCP resource support varies by platform | Medium | Low | Resources are additive; tools remain primary interface |
| `bollard watch` performance on large repos | Low | Medium | Debounce + ignore patterns + only watch source patterns |
| Generated configs conflict with user customizations | Medium | Medium | Merge-only strategy; never overwrite; warn on skip |

---

## 14. Future Work (Not in Stage 4d)

- **Cursor Automations API** — If Cursor exposes a programmatic way to register automations (not just the UI), Bollard could auto-register nightly verification.
- **Claude Code webhook channels** — When Claude Code's webhook support matures, Bollard could push verification results into active sessions.
- **VS Code / JetBrains extensions** — Native editor extensions (not MCP) for inline Bollard diagnostics. Significant effort; deferred to Stage 5+.
- **Bollard Language Server Protocol (LSP)** — Provide real-time verification diagnostics as editor squiggles. Major undertaking; long-term goal.
- **CI integration** — GitHub Actions, GitLab CI templates. Complementary to IDE integration but different scope.
