---
name: adr0006-increment3b-drift-candidates
overview: "ADR-0006 increment 3b (the scaling fix): a deterministic selectDriftCandidates that picks which curate-tier docs the LLM actually reviews — audit-docs implication + git staleness vs referenced code. No drift signal → doc not sent (zero LLM cost). Empty candidates → no-op (no LLM call). --all escape hatch for a deliberate full sweep. Makes 'curate all docs' practical instead of a ~100K-token firehose."
todos:
  - id: step-1-selector
    content: "Engine: selectDriftCandidates(workDir, editable) → DriftCandidate[] with reasons (audit-implication + git staleness vs doc→code links / package src). Pure-ish (git + fs), graceful git-absent degradation. Unit-tested."
    status: pending
  - id: step-2-wire
    content: "curate-docs assess-docs-drift runs the selector; corpus/message include only candidate file contents; empty candidates → CURATION_NO_PROGRESS (no agent call). Add --all to force full curate tier."
    status: pending
  - id: step-3-cli-mcp
    content: "list-drift prints candidates with reasons (and the full curate/detect-only tiers); run honors --all; MCP dryRun returns candidates + reasons."
    status: pending
  - id: step-4-tests
    content: "Selector unit tests: audit-implicated doc selected; stale-vs-code doc selected; no-signal doc (CODE_OF_CONDUCT) NOT selected; empty set → no-op; --all returns full tier; git-absent degrades to audit-implication only."
    status: pending
  - id: step-5-validate
    content: "typecheck/lint/test; list-drift shows a small candidate set on the real repo; optional live run is now cheap+targeted; audit-docs green; close out."
    status: pending
isProject: false
---

# ADR-0006 increment 3b — deterministic drift-candidate selection

Implements [spec/adr/0006-docs-curation-scope.md](../adr/0006-docs-curation-scope.md) Decision §5 + Action Item 3b. Increment 3 widened curate-docs to the full curate tier (~20 docs) but sends every file's content to the agent every run — a ~100K-token input firehose spending frontier tokens on docs that haven't drifted. This adds a deterministic selector that gates *which* curate-tier docs the LLM reviews and *whether it runs at all*.

## The principle (why this is the right shape)

Design principles 1 + 16: the deterministic layer does the selection; the frontier model is spent only where a concrete signal says a specific doc lags reality. Most runs should select 0–3 candidates. Empty set → the LLM is never called. This is the same determinism-first gating the rest of the system uses (risk gate skips contract testing; Stryker preflight skips mutation; etc.).

## Step 1 — `selectDriftCandidates` (engine, deterministic)

New in `packages/engine/src/docs-curation.ts` (or a sibling `docs-drift-signals.ts`):

```ts
export interface DriftCandidate {
  path: string
  reasons: string[]   // human-readable, e.g. "links to packages/foo/x.ts (changed 2026-06-15, doc last 2026-06-01)", "audit: dangling link", "package src newer than README"
}
export async function selectDriftCandidates(
  workDir: string,
  editable: string[],          // resolver curate-tier set
  opts?: { auditResult?: AuditDocsResult; all?: boolean },
): Promise<DriftCandidate[]>
```

Logic (per editable doc; a doc is a candidate if ANY signal fires):

1. **`all: true`** → every editable doc is a candidate (full-sweep escape hatch), reason `"--all"`. Short-circuit.
2. **audit-docs implication:** pass the `auditResult` (already computed in `assess-docs-drift`). If the doc's path appears in any failing check's `actual`/offenders (dangling-link owner, placement offender, or README/CLAUDE for `test-count-consistency`/`mcp-tool-count`), → candidate, reason names the check.
3. **git staleness vs referenced code** (the high-signal general case):
   - Doc's last-commit time: `git log -1 --format=%ct -- <path>` (reuse the git-shell pattern from `ownership.ts` `detectManagedFileConflicts`; non-throwing).
   - Referenced code files: parse the doc's `doc→code` links (reuse `extractRelativeMarkdownLinks` + resolve; keep targets that exist and are not `.md`). For a **package README** (`packages/*/README.md`), also include the package's `src/` files.
   - For each referenced code file, its last-commit time. If **any** referenced file's time > the doc's time → candidate, reason names the newest offending file + both timestamps.
4. **No signal → not a candidate** (not returned). `CODE_OF_CONDUCT.md`, `SECURITY.md` with no code refs and no audit hit are correctly skipped.

**Graceful degradation:** git unavailable (same probe as `detectManagedFileConflicts`) → skip signal 3; candidates come from audit-implication only. `--all` always works regardless of git.

Keep it pure-ish and unit-testable: factor the comparison (`isDocStaleVsRefs(docTime, refTimes)`) and the link→code extraction as pure helpers; isolate the git shell behind one injectable function so tests can stub timestamps.

## Step 2 — Wire into curate-docs

`packages/blueprints/src/curate-docs.ts`:

- `assess-docs-drift` already computes `editable`, `detectOnly`, `auditResult`. Add: `candidates = await selectDriftCandidates(workDir, editable, { auditResult, all: ctx.<allFlag> })`. Store `candidates` (paths + reasons) in the node data.
- **The agent now sees only candidate files.** `buildDocsCurationCorpus` / `buildDocsCuratorMessage` build `fileContents` and `allowedFiles` from the **candidate set**, not the full editable tier. (The reality *corpus* still includes CLAUDE.md + ROADMAP + audit facts as ground truth — only the *editable file contents blocks* shrink to candidates.) `allowedFiles` = candidate paths, so an edit to a non-candidate curate doc also drops `file_not_allowed` (tighter is fine).
- **Empty candidates → no-op:** if `candidates.length === 0`, skip the agent node and return `CURATION_NO_PROGRESS` (no LLM call, no cost). Mirror how the contract risk-gate skips downstream nodes.
- Thread an `all` flag from the CLI through the blueprint factory / context so `--all` forces the full tier.

## Step 3 — CLI + MCP

- `packages/cli/src/curate-docs.ts`:
  - `list-drift` prints three groups now: **drift candidates** (paths + reasons — the actionable set), full **curate tier** (count), **detect-only** (paths). This makes the deterministic selection inspectable with zero LLM cost — the cheap daily check.
  - `run` accepts `--all` (forces full curate tier; warn it's a costly full sweep). Default `run` is targeted (candidates only).
- MCP `bollard_curate_docs` dryRun: include `candidates` (with reasons) alongside `editable`/`detectOnly`.

## Step 4 — Tests

`packages/engine/tests/docs-curation.test.ts` (or new `docs-drift-signals.test.ts`) — stub the git-time function:

- audit-implicated doc (e.g. README with a count-mismatch in a fake `auditResult`) → selected, reason names the check.
- stale-vs-code: doc time < a referenced code file time → selected; reason names the file.
- fresh doc: doc time ≥ all referenced code times → NOT selected.
- no-signal doc (no code links, no audit hit) → NOT selected.
- empty editable or all-fresh → `[]` (drives the no-op path).
- `all: true` → every editable doc returned with reason `"--all"`.
- git-absent (git fn throws/returns null) → only audit-implicated docs returned; no crash.

Blueprint test: `assess-docs-drift` with empty candidates → pipeline short-circuits to `CURATION_NO_PROGRESS`, agent node not executed.

## Step 5 — Validate + close out

1. `docker compose run --rm dev run typecheck && … lint && … test` — full suite green + new tests.
2. `docker compose run --rm dev --filter @bollard/cli run start -- curate-docs list-drift` — on the real repo, confirm the **candidate set is small** (a handful of docs whose referenced code recently changed), distinct from the ~20-doc full curate tier. This is the proof the firehose is gone.
3. Optional live `curate-docs run` — now targeted + cheap; confirm it only sends candidates and still drops any detect-only edit. `curate-docs run --all` available for a deliberate full sweep.
4. `audit-docs` exit 0.
5. Close out: `CLAUDE.md` (drift-targeted selection; `--all`), `spec/ROADMAP.md` + ADR-0006 (check item 3b), `spec/stage6-docs-integrity.md` (Layer 2 now deterministically gated). Archive this prompt. Commits: (1) selector + tests, (2) blueprint/CLI/MCP wiring, (3) docs.

## Out of scope

- Auto-move (ADR-0006 deferred), LLM detect-only drift report (3b is selection, not the detect-only analysis), dropped-edit persistence (item 4), per-run hard token cap (the selector makes it unnecessary in practice).
- No change to the resolver tiers, the grounding gates, or the audit-docs checks.

## Watch-outs

- **Git timestamps use committed history.** Uncommitted doc edits have no commit time — handle the doc-has-no-commit case (treat as "very recent" / not stale, or fall back to fs mtime) so a brand-new uncommitted doc isn't spuriously flagged. Document the choice.
- **Reason strings are the UX.** `list-drift` candidates are only useful if the reason names the specific newer file + timestamps — invest in clear reason text; it's what a human acts on.
- **Don't let `--all` become the habit.** Default targeted; `--all` warns. The whole point is that the common path spends zero or minimal frontier tokens.
