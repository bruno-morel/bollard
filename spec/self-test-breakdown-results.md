# Self-Test: CostTracker.breakdown() — Determinism Fixes Validation

**Date:** 2026-06-04  
**Authoritative run ID:** `20260604-0406-run-fa5c2b`  
**Task:** Add `CostTracker.breakdown()` — structured snapshot of current cost state

## Overall Result

| Metric | Value | Target |
|--------|-------|--------|
| Status | ✓ success | — |
| Total cost | **$1.38** | < $1.96 ceiling; < $3.00 retag |
| Duration | 258s (~4m 18s) | — |
| Top-level steps | **17/17** | 17/17 |
| Coder turns | **23** | < 40 |
| Implement node cost | $1.26 / 2m 26s | — |

Pipeline branch: `bollard/20260604-0406-run-fa5c2b`. Infra commit applied before run: project-aware Stryker preflight + semantic review identifier fallback + vitest audit override.

## Scope Grounding

| Scope | Proposed | Kept/Grounded | Dropped | Drop rate |
|-------|----------|---------------|---------|-----------|
| Boundary | 20 | 20 | 0 | **0%** |
| Contract | 10 | 10 | 0 | **0%** |
| Semantic review | 4 | 2 | 2 | **50%** (50% kept) |

**Contract / boundary:** ✓ 0% drop on both scopes.

**Semantic review:** 2/4 findings kept (50%) vs isUnlimited() run (2/5 = 40%). **Identifier-presence fallback validated** — improved from 40% to 50%; meets the improvement goal but not strictly above the >50% target (borderline at exactly 50%).

## Infrastructure Signals

| Signal | Result |
|--------|--------|
| `write_file` overwrite guard | **Did not fire** — new test file `cost-tracker-breakdown.test.ts` created (expected) |
| Phase 18b write-once (test file) | Not assessed — coder used `edit_file` on source; wrote unit test once |
| `static-checks` | **pass** (`status: ok`) — typecheck, lint, audit, secretScan all passed |
| Stryker / mutation | **Ran** — 387 totalMutants, 86.56% score, 63s duration; preflight used project-aware `tsc --noEmit --project packages/engine/tsconfig.json` |
| Mutation preflight | **No false positive** — project mode resolved cross-package imports |

## Validation Table (plan gate vs isUnlimited)

| Metric | isUnlimited() | breakdown() | Target |
|--------|---------------|-------------|--------|
| CLI success | ✓ 17/17 | ✓ 17/17 | ✓ |
| Total cost | $1.05 | $1.38 | < $3.00 ✓ |
| Coder turns | 17 | 23 | < 40 ✓ |
| Contract drop | 0% | 0% | < 20% ✓ |
| Boundary drop | 0% | 0% | < 20% ✓ |
| Semantic kept rate | 40% (2/5) | **50% (2/4)** | > 50% — **borderline** |
| static-checks | fail (audit) | **pass** | pass ✓ |
| Mutation | skipped (preflight FP) | **387 mutants** | runs ✓ |
| Cost baseline retag | `post-prompt-hardening` | `post-determinism-fixes` | conditional ✓ |

## Primary Fix Validations

1. **static-checks pass:** Audit advisory cleared by vitest `pnpm.overrides`; all four checks green.
2. **Stryker runs:** `runStrykerPreflight` project mode eliminated the isUnlimited() false positive; mutation node completed with score 86.56%.
3. **Semantic grounding:** Identifier fallback kept paraphrased diff findings when method names (`breakdown`, etc.) appear in the diff — 50% kept vs 40% pre-fix baseline.

## Cost Baseline

Retagged **`post-determinism-fixes`** from run `20260604-0406-run-fa5c2b` ($1.38, 15% threshold). Prior tag: `post-prompt-hardening` ($1.0537).

## Commits

- **Infra:** determinism fixes (project-aware preflight + identifier fallback + audit override) — 1446/6.
- **Implementation:** `CostTracker.breakdown()` + `cost-tracker-breakdown.test.ts` + adversarial test refresh.

## Follow-up

1. Semantic kept rate at exactly 50% — consider tightening identifier regex or requiring diff-line prefix for remaining drops if next run stays ≤50%.
2. Coder spent 23 turns with multiple redundant test invocations (turns 4–23) — test-surgery guard Layer 2 did not cap all vitest invocations on the new file path; monitor but not a regression vs isUnlimited() cost ($1.38 vs $1.05).
