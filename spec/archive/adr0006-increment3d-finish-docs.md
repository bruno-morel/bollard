---
name: adr0006-increment3d-finish-docs
overview: "Finish the docs-integrity arc — two deterministic gaps, no new LLM. (1) Detect-only drift report: run the existing selectDriftCandidates signals over the detect-only tier so it actually reports which intent docs have drifted (ADR-0006 §3 promised a 'report', shipped only a file list). (2) Persist the grounding dropped-edit detail (ADR item 4 — the d2-mystery fix) so curate-docs calibration is auditable without keeping logs."
status: done
completed: 2026-06-20
todos:
  - id: step-1-detect-only-drift
    content: "Generalize selectDriftCandidates to also score the detect-only set; assess-docs-drift returns detectOnlyDrift; list-drift + MCP dryRun report detect-only docs WITH drift signals (not just the file list). Zero LLM."
    status: completed
  - id: step-2-persist-grounding
    content: "verify-docs-grounding writes a grounding-report.json (kept + dropped[ {id,reason,detail} ] + candidate reasons) to .bollard/curation/docs/. ADR item 4."
    status: completed
  - id: step-3-validate-docs
    content: "Tests for detect-only drift scoring + grounding-report persistence; list-drift on real repo shows detect-only drift; full suite green; close out ADR item 4 + 3d."
    status: completed
isProject: false
---

# ADR-0006 increment 3d — finish the docs arc (detect-only report + grounding audit trail)

Two deterministic gaps, no new LLM surface. Closes ADR-0006 item 4 and the detect-only "report" promise (§3).

## Gap 1 — Detect-only tier must REPORT drift, not just list files

ADR-0006 §3: detect-only docs "emit a drift **report**, never an edit." Today `curate-docs list-drift` only *lists* the detect-only paths. The drift signals already exist — `selectDriftCandidates` (`packages/engine/src/docs-drift-signals.ts`) computes audit-implication + git-staleness — but only over the *editable* set. Run them over the detect-only set too and surface the result.

### Step 1

- **Generalize the scorer.** `selectDriftCandidates` already takes a doc list; factor its per-doc scoring so it can run over any path set. Add (or call it twice): score the `detectOnly` paths → `detectOnlyDrift: DriftCandidate[]` (same `{ path, reasons }` shape). Reuse the exact signals — for a `detect-only` spec doc, git staleness compares the doc's commit time vs its `doc→code` link targets (most specs link to `packages/...` source), and audit-implication still applies (a spec owning a dangling link). No new signal logic.
- **Wire through `assess-docs-drift`** (`packages/blueprints/src/curate-docs.ts`): return `detectOnlyDrift` alongside `candidates`/`detectOnly`. The agent is **still never given detect-only docs** — this is report-only; `allowedFiles` is unchanged (curate candidates only). The detect-only drift never enters the LLM path.
- **Surface it:**
  - `curate-docs list-drift` (`packages/cli/src/curate-docs.ts`): a new section — `Detect-only docs WITH drift signals (review manually — not auto-rewritten):` listing each drifted detect-only doc + its reasons. Docs with no signal are omitted (don't print all 16). Keep the plain detect-only count line too.
  - MCP `bollard_curate_docs` dryRun: include `detectOnlyDrift` next to `candidates`.
- **Out of scope:** no LLM analysis of detect-only docs, no edits, no audit-docs change (keep the git-based drift in `curate-docs`/`list-drift`, not in the git-free `audit-docs` checks).

This makes detect-only a *useful* tier: a human gets a deterministic "these intent docs look stale — go review" list, exactly what the ADR promised, at zero token cost.

## Gap 2 — Persist dropped-edit detail (ADR item 4)

The first live run's `d2` drop reason was unrecoverable: `verify-docs-grounding` logs `docs_curation_grounding_result` *counts* only; the dropped bodies + reasons vanish with the console.

### Step 2

- In the `verify-docs-grounding` node (`packages/blueprints/src/curate-docs.ts`), after `verifyDocsCurationGrounding`, write `.bollard/curation/docs/grounding-report.json`:
  ```json
  {
    "runId": "...",
    "timestamp": ...,
    "kept": [ { "id", "file" } ],
    "dropped": [ { "id", "file", "reason", "detail" } ],
    "candidates": [ { "path", "reasons" } ]
  }
  ```
  (Reuse the `DocsGroundingResult` `kept`/`dropped` shape; include the candidate reasons from `assess-docs-drift` so the full "why this run touched these docs and dropped these edits" trail is on disk.)
- This is a sibling of the existing `plan.json` staging file — same directory, same gitignored `.bollard/` scratch. Non-fatal write (try/catch + warn), like other `.bollard` writes.
- Now "why was edit X dropped?" is answerable from disk — the calibration audit trail the d2 mystery showed we lacked.

## Step 3 — Tests + validate + close out

- **Tests:**
  - detect-only drift scoring: a fixture detect-only doc whose linked code is newer → appears in `detectOnlyDrift` with a file-named reason; a fresh detect-only doc → omitted. Reuse the stubbed git-time pattern from `docs-drift-signals.test.ts`.
  - grounding-report persistence: after a grounding run with kept + dropped edits, assert `grounding-report.json` exists with the expected `kept`/`dropped` arrays (unit-level on the helper, or a blueprint-node test with a temp `.bollard`).
- `docker compose run --rm dev run typecheck && … lint && … test` — full suite green (currently 1628/6 + new).
- `docker compose run --rm dev --filter @bollard/cli run start -- curate-docs list-drift` — confirm the new "detect-only docs WITH drift signals" section appears (or is empty if none drifted) distinct from the full detect-only list.
- Close out: `CLAUDE.md` (detect-only now reports drift; grounding-report.json audit trail), `spec/ROADMAP.md` + `spec/adr/0006-docs-curation-scope.md` (check **item 4**; note §3 detect-only report now implemented), `spec/stage6-docs-integrity.md`. Archive this prompt. Commits: (1) engine + blueprint + CLI/MCP code + tests, (2) docs.

## Out of scope (the genuinely-deferred remainder)

- Auto-move of stray docs (ADR item 5 — only if placement detection shows real sprawl; it hasn't).
- Any LLM analysis/rewrite of detect-only docs (dangerous; detect-only is deterministic-report-only forever).
- Anchor/external-URL link checking; per-run token cap (selector made it unnecessary).

After this, the docs-integrity arc is **complete with no gaps between ADR-0006 and the implementation**: detect (audit-docs) → resolve (tiers) → select (candidates, both tiers reported) → rewrite (curate tier only, grounded, gated, targeted, auditable).
