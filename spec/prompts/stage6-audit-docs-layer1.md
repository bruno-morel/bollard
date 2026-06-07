---
name: stage6-audit-docs-layer1
overview: "Stage 6 (docs domain, Layer 1): bollard audit-docs — deterministic doc-stats audit catching numeric/structural README drift. Zero LLM. Mirrors audit-protocol. Deliberately minimal: four checks, one CLI command, one CI step."
todos:
  - id: step-1-audit-docs
    content: "Create packages/cli/src/audit-docs.ts: four deterministic checks, auditDocs() + formatAuditDocsResult()"
    status: pending
  - id: step-2-cli
    content: "Wire audit-docs command into index.ts (mirror audit-protocol routing, exit 1 on failure)"
    status: pending
  - id: step-3-tests
    content: "~10 tests in packages/cli/tests/audit-docs.test.ts against fixture strings"
    status: pending
  - id: step-4-ci
    content: "Add one audit-docs step to existing bollard-verify.yml (no new workflow)"
    status: pending
  - id: step-5-validate
    content: "typecheck/lint/test green; audit-docs passes on current repo; mutate README locally to confirm it fails"
    status: pending
isProject: false
---

# Stage 6 docs domain, Layer 1 — `bollard audit-docs`

## Goal

Deterministic guard against the README drift incident of 2026-06-05 (README claimed 1305/6 tests and 16 MCP tools while reality was 1513/6 and 17; doc tables missed `09-model-selection.md` and ADR-0005). Design rationale and traps recorded in [spec/ROADMAP.md](../ROADMAP.md) Stage 6 docs-domain entry — read it first. **This is Layer 1 only.** No LLM, no `takeover.docs` plumbing, no agent. Mirror the shape of [`packages/cli/src/audit-protocol.ts`](packages/cli/src/audit-protocol.ts) (Stage 5a Phase 6): typed check results, `allPassed`, `format*` renderer, exit 1.

## Step 1 — `packages/cli/src/audit-docs.ts`

Four checks, all pure file-system/string work against `workDir`:

```ts
export type DocsCheckId =
  | "mcp-tool-count"        // README "MCP server: N tools" === tools.length from @bollard/mcp/src/tools.js (code is truth)
  | "spec-doc-links"        // every spec/NN-*.md (two-digit prefix) is linked somewhere in README.md
  | "adr-links"             // every spec/adr/NNNN-*.md is linked somewhere in README.md
  | "test-count-consistency" // README "X passed / Y skipped" === CLAUDE.md "Latest count" line; same for "Adversarial suite: N passed"

export interface DocsCheckResult {
  id: DocsCheckId
  label: string
  passed: boolean
  expected?: string
  actual?: string
}

export interface AuditDocsResult { allPassed: boolean; checks: DocsCheckResult[] }

export async function auditDocs(workDir: string): Promise<AuditDocsResult>
export function formatAuditDocsResult(result: AuditDocsResult): string
```

Rules:

- **A missing claim is a failure, not a skip.** If the README stat line or the CLAUDE.md "Latest count" line can't be parsed, the check fails with `actual: "claim not found"` — otherwise drift-by-deletion goes unnoticed.
- **Only exactly-reproducible values.** Do NOT add checks on cost, mutation score, run IDs, stage-status prose, or dates (ROADMAP trap note). If tempted, stop.
- `mcp-tool-count`: `const { tools } = await import("@bollard/mcp/src/tools.js")` and compare `tools.length` to the README number (regex like `/MCP server:\*?\*?\s*(\d+)\s+tools/i` — check the actual README line and keep the regex tolerant of bold markers).
- `spec-doc-links` / `adr-links`: `readdir` the directories, filter `^\d{2}-.*\.md$` / `^\d{4}-.*\.md$`, assert each filename substring appears in README content. Report the missing filenames in `actual`.
- `test-count-consistency`: parse `(\d+) passed / (\d+) skipped` from README and the backticked numbers from CLAUDE.md's `**Latest count` line; parse `Adversarial suite:? \`?(\d+)\`? passed` from both. Compare pairwise. This is doc-to-doc consistency — CLAUDE.md is updated every phase, so independent drift gets caught without running the test suite.

## Step 2 — CLI wiring

In [`packages/cli/src/index.ts`](packages/cli/src/index.ts), copy the `audit-protocol` routing block (~line 951): `audit-docs` → `header`, `auditDocs(workDir)`, print formatted result, `process.exit(result.allPassed ? 0 : 1)`. Add one line to the help text. Respect `--work-dir`.

## Step 3 — Tests (`packages/cli/tests/audit-docs.test.ts`, ~10)

Use temp dirs with fixture README/CLAUDE.md/spec files (same pattern as `audit-protocol.test.ts` if it uses fixtures, else simple `mkdtemp`):

- all four checks pass on a consistent fixture
- tool count mismatch fails with expected/actual populated
- missing stat line in README fails with "claim not found"
- spec file present on disk but absent from README fails and names the file
- ADR same
- test-count mismatch between README and CLAUDE.md fails; adversarial-count mismatch fails
- `formatAuditDocsResult` renders pass and fail lines

For `mcp-tool-count` in unit tests, allow injecting the count (e.g. optional `options?: { toolCount?: number }` on `auditDocs`) so fixtures don't need the real `@bollard/mcp` import; the CLI path uses the real import.

## Step 4 — CI (one step, no new workflow)

In [`.github/workflows/bollard-verify.yml`](.github/workflows/bollard-verify.yml), add a step after the existing verify step that runs `bollard audit-docs` inside the dev container. Zero LLM cost, seconds of runtime. Do NOT create a separate workflow file.

## Step 5 — Validation

1. `docker compose run --rm dev run typecheck && docker compose run --rm dev run lint` — clean
2. `docker compose run --rm dev run test` — ≥ 1513 + ~10 new / 6 skipped
3. `docker compose run --rm dev --filter @bollard/cli run start -- audit-docs` — **passes on the current repo** (README was refreshed 2026-06-07; if it fails, the README or CLAUDE.md genuinely drifted again — fix the doc, not the check)
4. Temporarily change the README tool count to 99, re-run, confirm exit 1 with a clear message; revert
5. Update CLAUDE.md (command table + a one-line Stage 6 docs Layer 1 entry + new test count) and ROADMAP.md (mark Layer 1 done in the docs-domain entry); archive this prompt to `spec/archive/`; commit: `Stage 6 (docs Layer 1): bollard audit-docs deterministic doc-stats audit` + `docs:` commit

## Out of scope — DO NOT

- No `curate-docs` agent, no `takeover.docs` enforcement, no LLM calls — Layer 2 is a separate future phase
- No checks on variable values (cost, mutation score, dates, stage prose)
- No new workflow file, no MCP tool, no `.bollard.yml` config surface
- Do not auto-fix the README — this command only reports; fixing stays human (Layer 2's job later)
