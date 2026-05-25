# Self-Test: CostTracker.limitUsd() — Phase 15 Validation Results

**Date:** 2026-05-25
**Run ID:** 20260525-2109-run-b8c50b
**Task:** Add limitUsd(): number to CostTracker

## Overall Result

| Metric | Value |
|--------|-------|
| Status | ✓ success |
| Total cost | $5.02 |
| Duration | 249.1s |
| Nodes | 31/31 |
| Coder turns | 54 |

Pipeline branch: `bollard/20260525-2109-run-b8c50b`. Coder completed implement node at turn 54 with `stop=end_turn` ($4.91, 176.2s). `static-checks` recorded **fail** (duplicate `context` key in `subtract()`, test file parse error) — skipped per `onFailure: skip`. Post-run manual fix removed duplicate key and repaired test file nesting before commit.

## Phase 15 Validation — Stryker Mutation Signal

| Metric | Value |
|--------|-------|
| `totalMutants` | 0 |
| `killed` | 0 |
| `survived` | 0 |
| `stryker_no_mutants` warning? | **yes** |
| Mutation score | 0% |

**Verdict:** ✗ still no-op (`stryker_no_mutants` logged)

Stryker ran for 15.6s (`scopedToFiles: true`, 1 affected file) but produced zero mutants. Blueprint node correctly emitted `warning: "stryker_no_mutants"` and returned `{ skipped: true, reason: "stryker_no_mutants" }`. The direct binary path fix is wired but insufficient — a deeper Docker/vitest-runner environment issue remains (same class of failure as merge run pre-fix, now explicitly flagged).

## Phase 14 Validation — Contract Grounding (continued observation)

| Scope | Proposed | Grounded | Dropped | Drop rate | vs pre-fix |
|-------|----------|----------|---------|-----------|------------|
| Boundary | 11 | 9 | 2 | 18.2% | — |
| Contract | 8 | 6 | 2 | 25% | pre-fix: 55–88%, withLimit(): 25% |

**Verdict:** ✓ held (drop rate 25% < 30%)

**Dropped contract claims:** `c5`, `c8` (`grounding_not_in_context`). All 6 surviving claims produced passing contract tests (6/6 at `run-contract-tests`). No negative-remaining assertions — task choice validated.

## Hardening Fixes — Continued Observation

| Fix | Fired? | Notes |
|-----|--------|-------|
| Scope guard (`allowedWritePaths`) | no | No `not in the plan's affected_files` errors on coder tools |
| Structured test output | no | No `test failure summary:` in log — coder vitest runs exited 0 or did not hit structured failure path |
| Hard-exit injection | no (visible) | Turn 52–53 still used tools; turn 54 `stop=end_turn`. No `SYSTEM: You have` / forced-completion text in log |
| JSDoc fix (remaining/exceeded) | n/a | Applied pre-run |

## Token Economy

| Metric | Value | vs prior runs |
|--------|-------|---------------|
| Coder turns | 54 | prev: 19 (runCount), 32 (formatCost), 54 (withLimit) |
| Total coder cost (implement) | $4.91 | — |
| Pipeline total cost | $5.02 | +207% vs $1.96 ceiling |
| Forced-completion injected | no (visible) | — |
| Rollback occurred | no | — |

**Turn budget drivers:** Despite a 3-line getter, coder spent turns 13–52 on repeated vitest invocations and test-file surgery (duplicate braces, merge block split). Planner produced **4** acceptance criteria (within 3–5 cap).

## Signal 1 — Promotion Candidates

none — no promotion candidates surfaced at `approve-pr`.

## Cost Regression

| Metric | Value |
|--------|-------|
| Baseline ceiling | $1.96 |
| This run cost | $5.02 |
| `cost-baseline diff` | **fail** (+69.15% avg vs baseline; 5 runs since tag) |

## Test Suite

| Before run | After run |
|------------|-----------|
| 1226 passed / 6 skipped | 1234 passed / 6 skipped |

+8 net new tests from `limitUsd()` describe block (after post-run syntax repair).

## Protocol Compliance

| Platform | Score |
|----------|-------|
| cursor | 5/5 |
| claude-code | 5/5 |

## Issues Found

1. **`static-checks` fail (skipped):** Coder introduced duplicate `context:` key in `subtract()` error object (TS1117) and broke test file nesting (extra `})`, orphaned merge tests). Fixed manually before commit.

2. **Coder turn bloat on simple getter:** 54 turns / $4.91 for a one-line `return this._limit` — dominated by test-file editing loops, not implementation.

3. **`write-tests` replaced adversarial suite:** Boundary node overwrote `cost-tracker.adversarial.test.ts` (283-line clamp corpus → 9 limitUsd tests). Reverted from main at commit time (not in commit scope).

4. **Phase 15 not validated (pre-15b):** `stryker_no_mutants` on run `20260525-2109-run-b8c50b` — superseded by Phase 15b/15c Docker validation (202 mutants). See [stage5d-phase15b-validation-results.md](./stage5d-phase15b-validation-results.md).

5. **Semantic review findings:** 6 proposed, 0 kept (100% drop at grounding layer).

6. **Diff included unplanned files in gate summary:** `run-command.ts`, `ROADMAP.md` appeared in approve-pr diff but were not present on host working tree at end of run (scope guard or branch artifact).

## Observations vs Previous Runs

| Run | Cost | Coder turns | Nodes | Contract grounding | Stryker |
|-----|------|-------------|-------|-------------------|---------|
| 2026-05-18 runCount() | $0.88 | 19 | 31/31 | 5/8 (37.5% drop) | 0 mutants |
| 2026-05-19 formatCost() | $1.63 | 32 | 31/31 | — | — |
| 2026-05-25 withLimit() | $4.75 | 54 | **16/31 halt** | 6/8 (25% drop) | not reached |
| 2026-05-25 merge() | $4.75 | 51 | 31/31 | 1/8 (87.5% drop) | 0 mutants (silent) |
| **2026-05-25 limitUsd()** | **$5.02** | **54** | **31/31** | **6/8 (25% drop)** | **0 mutants (`stryker_no_mutants`)** |

**Phase 14:** Held at 25% — consistent with withLimit() partial run. Task + acceptance_criteria corpus fix confirmed across two forward observations.

**Phase 15:** First full 31/31 run reaching `run-mutation-testing` post-fix. Binary path runs but still 0 mutants; warning path works as designed. Live validation **deferred** — deeper env fix needed.

**Task choice:** `limitUsd()` completed full pipeline including contract tests (6/6 pass) — validates JSDoc + getter task strategy vs withLimit() halt.

## Recommended Follow-ups

1. ~~**Stryker Docker env (Phase 15 remainder):**~~ **DONE (2026-05-25).** Phase 15b (`node` + `stryker.js`) + 15c (explicit `plugins` in generated config). Docker validation: 202 mutants, 90.10% score. See [stage5d-phase15b-validation-results.md](./stage5d-phase15b-validation-results.md).

2. **Coder test-file churn:** 54 turns on a getter suggests post-completion verify hook or prompt hardening for "do not re-run full suite more than twice" — token economy follow-up.

3. **Boundary write-tests overwrite:** `write-tests` replaced entire adversarial file instead of appending limitUsd cases — lifecycle/scoping prompt or assembler guard.

4. **Tier 1 patcher on static-checks:** Duplicate key + parse error survived coder hook — patcher should catch TS1117 and biome parse errors before node completes.
