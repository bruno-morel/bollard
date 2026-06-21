---
name: adr0006-increment3c-spec-detect-only
overview: "Small tiering fix: all eligible docs under spec/ are detect-only, not just spec/0N-*/adr/ROADMAP. Closes a safety gap where 15 spec/ design docs (spec/stage*.md, spec/README.md) were classified curate=editable and could be auto-rewritten by curate-docs — violating ADR-0006's intent-doc protection."
status: done
completed: 2026-06-20
todos:
  - id: step-1-resolver
    content: "docs-resolver.ts defaultTierForPath: any eligible doc under spec/ → detect-only (generalize the DETECT_ONLY_PATTERNS). Update tests."
    status: completed
  - id: step-2-validate-docs
    content: "Confirm spec/stage*.md + spec/README.md now detect-only via list-drift; full suite green; close out ADR/CLAUDE/ROADMAP."
    status: completed
isProject: false
---

# ADR-0006 increment 3c — all of spec/ is detect-only

A tiny but real safety fix. ADR-0006's intent-doc protection (detect-only = report-not-rewrite) only matched `spec/0N-*.md`, `spec/adr/*`, `spec/ROADMAP.md`. But `spec/` holds **15 other eligible design docs** — `spec/stage4a-behavioral-scope.md`, `spec/stage5d-token-economy.md`, `spec/stage6-docs-integrity.md`, `spec/README.md`, etc. — all currently classified **curate (editable)**, meaning `curate-docs` could auto-rewrite them. These are intent docs; their divergence from code is often deliberate. They must be detect-only. Surfaced when `spec/stage5d-token-economy.md` had a stale status line (real drift in an editable design doc).

ADR-0006 already updated: detect-only ⟺ eligible & under `spec/`.

## Step 1 — Resolver

`packages/engine/src/docs-resolver.ts`, `defaultTierForPath(relPath)`:

Replace the `DETECT_ONLY_PATTERNS` loop with a generalization: an eligible doc whose normalized path starts with `spec/` → `"detect-only"`; otherwise `"curate"`. (Exclusion zones `spec/archive`/`spec/prompts` and the `*-results`/`self-test-*` denylist already run *before* tier assignment, so they remain `never-touch` — this only affects the eligible `spec/` remainder.)

```ts
function defaultTierForPath(relPath: string): DocTier {
  const normalized = normalizeRelPath(relPath)
  if (normalized === "spec" || normalized.startsWith("spec/")) return "detect-only"
  return "curate"
}
```

Keep `DETECT_ONLY_PATTERNS` only if something else references it; otherwise remove it as now-redundant. Front-matter `tier:` override still wins (unchanged).

## Step 2 — Tests + validate + close out

- `packages/engine/tests/docs-resolver.test.ts`: add/adjust — `spec/stage5d-token-economy.md` → detect-only; `spec/README.md` → detect-only; `spec/01-architecture.md` still detect-only; a root doc (`CONTRIBUTING.md`) and a package README stay curate; `spec/archive/x.md` still never-touch; `spec/self-test-foo-results.md` still never-touch. A front-matter `tier: curate` on a spec doc still overrides to curate (escape hatch intact).
- `docker compose run --rm dev run typecheck && … lint && … test` — full suite green.
- `docker compose run --rm dev --filter @bollard/cli run start -- curate-docs list-drift` — confirm the curate tier shrank (no `spec/stage*` docs) and detect-only grew accordingly.
- Close out: `CLAUDE.md` (tier rule: spec/ = detect-only), `spec/ROADMAP.md` note, ADR-0006 already updated (commit it). Archive this prompt. One commit for code+tests, one for docs.

## Out of scope

- No change to grounding, candidate selection, audit-docs, or the curate mechanism — only the tier assignment for `spec/`.
- The old `spec/stage3c-workstream*-prompt.md` files become detect-only (safe — reported, never rewritten); a finer `*-prompt.md` → never-touch denylist is optional and not needed here.
