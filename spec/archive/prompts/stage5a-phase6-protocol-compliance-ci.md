# Cursor Prompt — Stage 5a Phase 6: Protocol Compliance CI

> **Context:** Bollard generates IDE integration configs (Cursor rules, Claude Code CLAUDE.md augmentation) via `bollard init --ide`. These configs communicate the verification protocol to AI coding agents — they must contain three structural elements established in ADR-0003: a WHY section, a DO NOT list of raw commands, and a BEFORE REPORTING COMPLETION self-check. Without a CI check, a developer editing a generator could accidentally remove one of these elements and silently break protocol compliance for every user who runs `bollard init --ide`.
>
> Phase 6 adds a **deterministic** structural lint (`bollard audit-protocol`) that checks the generated configs for these elements, plus a GitHub Actions workflow that runs it on every change to generators, prompts, or MCP source files. Zero LLM cost — purely string/regex checks.
>
> **Read CLAUDE.md fully before writing any code.** Then read:
> - `packages/cli/src/generators/cursor.ts` — the Cursor rules template (look for WHY section, DO NOT list, BEFORE REPORTING COMPLETION)
> - `packages/cli/src/generators/claude-code.ts` — the Claude Code template (same three structural elements)
> - `packages/cli/src/init-ide.ts` — `generateIdeConfigs`, `writeGeneratedFiles` — how configs are generated into a temp/target dir
> - `packages/cli/src/index.ts` — how CLI commands are wired (look at `doctor`, `verify`, `promote-test` as patterns)
> - `packages/cli/src/human-gate.ts` — example of a small focused CLI module
> - `spec/adr/0003-agent-protocol-compliance.md` — the 5-point checklist this phase enforces
> - `.github/workflows/bollard-verify.yml` — pattern for CI workflows (pnpm setup, Docker build, docker compose run)

---

## What to build — two pieces

---

### Piece 1 — `packages/cli/src/audit-protocol.ts` (new file)

Pure deterministic structural checker. No LLM calls. No filesystem writes.

#### Types

```typescript
export type ComplianceCheckId =
  | "why-section"
  | "do-not-list"
  | "self-check-section"
  | "bollard-verify-reference"
  | "no-raw-command-encouragement"

export interface ComplianceCheckResult {
  id: ComplianceCheckId
  label: string
  passed: boolean
  evidence?: string  // what was found (or not found)
}

export interface PlatformComplianceResult {
  platform: "cursor" | "claude-code"
  score: number        // 0–5
  maxScore: number     // always 5
  passed: boolean      // score === maxScore
  checks: ComplianceCheckResult[]
  configPath: string   // path of the file that was checked
}

export interface AuditProtocolResult {
  allPassed: boolean
  platforms: PlatformComplianceResult[]
}
```

#### `checkProtocolCompliance(platform: "cursor" | "claude-code", content: string, configPath: string): PlatformComplianceResult`

Runs 5 deterministic checks against `content`:

1. **`why-section`** — `label: "WHY section present"`
   - Pass if content contains `## WHY USE BOLLARD MCP TOOLS` (case-insensitive substring match)
   - Evidence on fail: `"Missing '## WHY USE BOLLARD MCP TOOLS' section"`

2. **`do-not-list`** — `label: "DO NOT list with specific commands"`
   - Pass if content contains both a DO NOT section header (`DO NOT RUN VERIFICATION COMMANDS DIRECTLY` or `DO NOT.*direct` case-insensitive) AND at least two of: `pnpm run typecheck`, `pnpm run lint`, `biome`, `npx tsc`
   - Evidence on fail: `"Missing DO NOT list or specific command examples"`

3. **`self-check-section`** — `label: "BEFORE REPORTING COMPLETION self-check present"`
   - Pass if content contains `BEFORE REPORTING COMPLETION` (case-insensitive)
   - Evidence on fail: `"Missing 'BEFORE REPORTING COMPLETION' section"`

4. **`bollard-verify-reference`** — `label: "Self-check references bollard_verify"`
   - Pass if content contains `bollard_verify` in the same region as `BEFORE REPORTING COMPLETION` — i.e., within 800 characters after the self-check header
   - Evidence on fail: `"Self-check section does not reference bollard_verify"`

5. **`no-raw-command-encouragement`** — `label: "No encouragement of raw verification commands"`
   - Pass if content does NOT contain patterns like `run pnpm typecheck` or `run pnpm lint` or `execute.*tsc` outside of the DO NOT list context (i.e., not preceded by `❌` or `DO NOT` within 120 chars)
   - Simple heuristic: pass if `❌` appears before every occurrence of `pnpm run typecheck` in the content, OR if `pnpm run typecheck` only appears in negation context
   - **Keep this check lenient** — false positives (failing valid configs) are worse than false negatives here. If in doubt, pass. The check is a safety net for gross regressions, not a style linter.

Returns a `PlatformComplianceResult` with `score = checks.filter(c => c.passed).length` and `passed = score === 5`.

#### `auditProtocol(workDir: string): Promise<AuditProtocolResult>`

1. Call `generateIdeConfigs(profile, workDir)` for both `"cursor"` and `"claude-code"` platforms into a temp dir (`os.tmpdir() + "/" + randomUUID()`).
2. For Cursor: find the file with path ending in `bollard.mdc` (the rules file).
3. For Claude Code: find the file with path ending in `CLAUDE.md` (the augmentation file) — or the file ending in `.claude/settings.json` — use the one that contains the protocol content (the CLAUDE.md augmentation).
4. Read each file, call `checkProtocolCompliance`, collect results.
5. Clean up temp dir (`rm -rf`).
6. Return `{ allPassed: results.every(r => r.passed), platforms: results }`.

Use `detectToolchain(workDir)` to get the profile for `generateIdeConfigs`. Wrap in try/catch — if config generation fails, return a failed result with a single check `{ id: "why-section", passed: false, evidence: "Config generation failed: <error>" }` for that platform.

---

### Piece 2 — Wire into CLI in `packages/cli/src/index.ts`

Add `audit-protocol` command handler. Pattern mirrors `doctor`:

```typescript
if (command === "audit-protocol") {
  header("audit-protocol")
  const result = await auditProtocol(configCwd)
  process.stderr.write(formatAuditResult(result) + "\n")
  if (!result.allPassed) process.exit(1)
  return
}
```

Add `formatAuditResult(result: AuditProtocolResult): string` as a local helper in `index.ts` (or in `audit-protocol.ts` — either is fine):

```
  ✓ cursor (5/5) — .cursor/rules/bollard.mdc
    ✓ WHY section present
    ✓ DO NOT list with specific commands
    ✓ BEFORE REPORTING COMPLETION self-check present
    ✓ Self-check references bollard_verify
    ✓ No encouragement of raw verification commands

  ✓ claude-code (5/5) — .claude/CLAUDE.md
    ✓ ...
```

On failure, use `✗` for failed checks and include the `evidence` string.

Add to the help text in `index.ts`:
```
  audit-protocol                  Lint generated IDE configs for protocol compliance (exits 1 on failure)
```

---

### Piece 3 — `.github/workflows/protocol-compliance.yml` (new file)

```yaml
name: Protocol Compliance Check

on:
  push:
    branches: ["main"]
    paths:
      - "packages/cli/src/generators/**"
      - "packages/agents/prompts/**"
      - "packages/mcp/src/**"
  pull_request:
    branches: ["main"]
    paths:
      - "packages/cli/src/generators/**"
      - "packages/agents/prompts/**"
      - "packages/mcp/src/**"
  workflow_dispatch:

jobs:
  protocol-compliance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build dev image
        run: docker compose build dev

      - name: Audit protocol compliance
        run: |
          docker compose run --rm dev sh -c \
            'git config --global --add safe.directory /app && \
             pnpm --filter @bollard/cli run start -- audit-protocol'
```

No `ANTHROPIC_API_KEY` needed — fully deterministic.

---

## Tests to add

### `packages/cli/tests/audit-protocol.test.ts` (new — 8 tests)

Test `checkProtocolCompliance` directly (pure function, no filesystem).

1. **Full compliant Cursor content** — pass all 5 checks (use a minimal string containing all required markers)
2. **Missing WHY section** — `why-section` fails, others pass
3. **Missing DO NOT list** — `do-not-list` fails
4. **Missing BEFORE REPORTING COMPLETION** — `self-check-section` fails
5. **Self-check present but no `bollard_verify` reference in it** — `bollard-verify-reference` fails
6. **Score computed correctly** — 3 passing checks → `score: 3`, `passed: false`
7. **`checkProtocolCompliance` on actual Cursor generator output** — import `CURSOR_RULES_TEMPLATE` or call `generateIdeConfigs` in a temp dir and verify all 5 pass (regression test: if someone removes a structural element from the generator, this catches it)
8. **`checkProtocolCompliance` on actual Claude Code generator output** — same regression test for Claude Code

For tests 7 and 8: these are integration tests that call the real generator. They use `os.tmpdir() + crypto.randomUUID()` for the temp dir and clean up after. They require `detectToolchain` to succeed (bollard repo is TypeScript so it will). Mark with a descriptive name so it's clear these are the regression tests.

---

## CLAUDE.md update

Add a new `### Stage 5a Phase 6 (DONE)` section after the existing `### Stage 5a Phase 5 (DONE)` block:

```
### Stage 5a Phase 6 (DONE) — Protocol Compliance CI:

`bollard audit-protocol` — deterministic structural lint on generated IDE configs. Checks 5 structural elements (WHY section, DO NOT list with specific commands, BEFORE REPORTING COMPLETION self-check, `bollard_verify` reference in self-check, no raw-command encouragement) for both `cursor` and `claude-code` platforms. Exits 1 on any failure. `.github/workflows/protocol-compliance.yml` runs on push/PR when `generators/`, `prompts/`, or `packages/mcp/src/` change. Zero LLM cost — fully deterministic.
```

Update the forward roadmap line:
```
- **Stage 5a (self-hosting):** Phase 1–3 DONE … Phase 4a DONE … Phase 4b DONE … Phase 5 DONE … **Phase 6 DONE** (protocol compliance CI — `bollard audit-protocol`, structural lint on IDE configs, GitHub Actions workflow). Stage 5a complete.
```

## spec/ROADMAP.md update

Mark Phase 6 DONE:
```
- ~~**Protocol compliance CI (Phase 6):**~~ **DONE (2026-05-21).** `bollard audit-protocol` — deterministic 5-point structural lint on `cursor` and `claude-code` generated configs. `.github/workflows/protocol-compliance.yml` triggers on changes to generators/prompts/MCP source. Zero LLM cost.
```

---

## Validation

```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

Expected: clean typecheck + lint; test count increases by 8 (1118 → **1126** passed / 6 skipped).

Manual smoke test:
```bash
docker compose run --rm dev sh -c \
  'pnpm --filter @bollard/cli run start -- audit-protocol'
```

Expected output: both platforms 5/5, exit 0.

---

## Constraints

- **Zero LLM calls** — all checks are string/regex. `auditProtocol` calls `generateIdeConfigs` (deterministic) and `detectToolchain` (deterministic). No `LLMClient`, no API key required.
- **No new external dependencies** — uses only `node:fs`, `node:os`, `node:crypto`, `node:path` and existing internal imports.
- **Keep check 5 lenient** — false positives on compliant configs are worse than missed regressions. When in doubt, pass.
- **`exactOptionalPropertyTypes`** — no explicit `undefined` assignments.
- **No classes** — named exports only, kebab-case file.
- **Do not change `RunRecord` schema** — `ComplianceResult` in run history is a future item (Phase 6b). This phase writes no history records.
- **Do not change existing generators** — this phase audits them, it does not modify them. If the audit reveals the generators are already compliant (they are — validated in Stage 4d), that's the expected result.
