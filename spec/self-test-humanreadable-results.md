# Self-Test: CostTracker.humanReadable() — Post-5e Hardening Validation

**Date:** 2026-06-04  
**Authoritative run ID:** `20260604-0303-run-7c191e`  
**Task:** Add `CostTracker.humanReadable(): string` — human-readable cost summary (e.g. `$1.23 / $10.00 (12.3%)`)

## Overall Result

| Metric | Value | Target |
|--------|-------|--------|
| Status | ✓ success | — |
| Total cost | **$1.55** | < $1.96 ceiling; < $3.00 retag |
| Duration | 244s (~4m 4s) | — |
| Top-level steps | **17/17** | 17/17 |
| Coder turns | **26** | < 40 |
| Implement node cost | $1.44 / 195s | — |

Pipeline branch: `bollard/20260604-0303-run-7c191e`. Prompt fix commit applied before run (semantic-reviewer ADR-0003 self-check).

## Scope Grounding

| Scope | Proposed | Kept/Grounded | Dropped | Drop rate |
|-------|----------|---------------|---------|-----------|
| Boundary | 14 | 14 | 0 | **0%** |
| Contract | 8 | 8 | 0 | **0%** |
| Semantic review | 4 | 1 | 3 | **75%** |

**Contract / boundary:** ✓ Phase 5e corpus + contract-tester self-check held (0% contract drop).

**Semantic review:** 1/4 findings kept (25%) vs pre-fix `available()` run (1/11 ≈ 9%). Improvement but **below** the >50% target — three findings still dropped at `verify-review-grounding` (likely paraphrase or plan-quote mismatch). The kept finding was `error` severity (`severityCounts.error: 1`).

## Infrastructure Signals

| Signal | Result |
|--------|--------|
| `write_file` overwrite guard | **Did not fire** — new test file `cost-tracker-humanreadable.test.ts` created at coder turn 5 (expected) |
| Phase 18b write-once (test file) | Not assessed — coder used `run_command` on new test file at turn 6 (within `MAX_TEST_INVOCATIONS`) |
| `static-checks` | **fail** (skipped) — typecheck/lint failure on workspace after implement |
| `run-tests` (boundary) | Not extracted from log; pipeline continued |
| Stryker preflight | **Fired** — `tsc --noEmit` failed on `cost-tracker.ts`; mutation skipped (`stryker_no_mutants` warn) |

**Follow-up:** Fix any tsc errors on branch `bollard/20260604-0303-run-7c191e` before merge; re-run `pnpm run typecheck` / full test suite on `main` after merge.

## Validation Table (plan gate)

| Metric | Result | Target |
|--------|--------|--------|
| CLI success | ✓ | ✓ |
| Total cost | $1.55 | < $3.00 retag |
| Coder turns | 26 | < 40 |
| Contract drop | 0% | < 20% |
| Semantic kept rate | 25% (1/4) | > 50% — **miss** |
| Cost baseline retag | `post-5e-hardening` @ $1.5494 | conditional ✓ |

## Cost Baseline

Tagged **`post-5e-hardening`** from run `20260604-0303-run-7c191e` ($1.5494, 15% threshold). Prior tag: `stage5a-validated` ($1.633). `cost-baseline diff`: insufficient data (0 runs since tag — expected immediately after tag).

## Commits / Prompt

- **Stage 5e prompt:** `semantic-reviewer.md` — ADR-0003 bad/good example + BEFORE EMITTING checklist (prompt-only, 1420/6).
- **Orchestration:** archived from `spec/prompts/semantic-reviewer-grounding-selftest.md`.
