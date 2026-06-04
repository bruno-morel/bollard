# Self-Test: CostTracker.isUnlimited() — Three-Prompt Hardening Validation

**Date:** 2026-06-04  
**Authoritative run ID:** `20260604-0334-run-b89290`  
**Task:** Add `CostTracker.isUnlimited(): boolean` — returns true when `limitUsd` is Infinity

## Overall Result

| Metric | Value | Target |
|--------|-------|--------|
| Status | ✓ success | — |
| Total cost | **$1.05** | < $1.96 ceiling; < $3.00 retag |
| Duration | 236s (~3m 56s) | — |
| Top-level steps | **17/17** | 17/17 |
| Coder turns | **17** | < 40 |
| Implement node cost | $0.95 / 198s | — |

Pipeline branch: `bollard/20260604-0334-run-b89290`. Prompt hardening commit applied before run (`c8b9ea5` — semantic-reviewer rule 5, coder enforcement language, boundary-tester BEFORE EMITTING).

## Scope Grounding

| Scope | Proposed | Kept/Grounded | Dropped | Drop rate |
|-------|----------|---------------|---------|-----------|
| Boundary | 7 | 7 | 0 | **0%** |
| Contract | 6 | 6 | 0 | **0%** |
| Semantic review | 5 | 2 | 3 | **60%** (40% kept) |

**Contract / boundary:** ✓ Phase 5e corpus + new boundary-tester self-check held (0% drop on both scopes).

**Semantic review:** 2/5 findings kept (40%) vs humanReadable() run (1/4 = 25%). **Improvement but below >50% target** — diff-anchor rule 5 helped but three findings still dropped at `verify-review-grounding`. Structural follow-up on `verify-review-grounding.ts` may be needed if next run stays ≤40%.

## Infrastructure Signals

| Signal | Result |
|--------|--------|
| `write_file` overwrite guard | **Did not fire** — new test file `cost-tracker-isunlimited.test.ts` created (expected) |
| Phase 18b write-once (test file) | Not assessed — coder completed without test-file edit loop |
| `static-checks` | **fail** (skipped) — **audit** only (`STATIC_CHECK_FAILED: audit`); full-workspace typecheck + lint pass post-run |
| `run-tests` (boundary) | 13 passed (7 boundary + 6 contract per history) |
| Stryker preflight | **Fired** — single-file `tsc --noEmit packages/engine/src/cost-tracker.ts` false positive (errors in imported `errors.ts` under isolated compile); full `tsc --build` passes; mutation skipped |

**Note:** static-checks failure is pre-existing audit/CVE on vitest dependency, not coder-introduced tsc errors. Overwrite guard validation inconclusive for static-checks pass (audit masks typecheck path), but coder used `edit_file` pattern on existing source and created new test file without full-file rewrite.

## Validation Table (plan gate)

| Metric | Result | Target |
|--------|--------|--------|
| CLI success | ✓ 17/17 | ✓ |
| Total cost | $1.05 | < $3.00 retag ✓ |
| Coder turns | 17 | < 40 ✓ |
| Contract drop | 0% | < 20% ✓ |
| Boundary drop | 0% | < 20% ✓ |
| Semantic kept rate | 40% (2/5) | > 50% — **miss** |
| static-checks | fail (audit) | pass — **miss** (pre-existing audit) |
| Mutation | skipped (preflight) | runs — **miss** (isolated tsc false positive) |
| Cost baseline retag | `post-prompt-hardening` | conditional ✓ |

## Cost Baseline

Retagged **`post-prompt-hardening`** from run `20260604-0334-run-b89290` ($1.05, 15% threshold). Prior tag: `post-5e-hardening` ($1.5494).

## Commits

- **Prompt hardening:** `c8b9ea5` — three-agent grounding rules (prompt-only, 1435/6).
- **Implementation:** `CostTracker.isUnlimited()` + `cost-tracker-isunlimited.test.ts` + adversarial test refresh (+6 tests → 1441/6).

## Follow-up

1. Semantic grounding still below 50% — consider deterministic filter in `verify-review-grounding.ts` (require `+`/`-` prefix for diff quotes at verifier layer).
2. Mutation preflight single-file `tsc` produces false negatives when imports pull in project-wide types — consider `tsc --build` scoped to package instead of single-file compile.
