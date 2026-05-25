# Self-Test: CostTracker.toJSON() — Phase 15 Live Pipeline Validation

**Date:** 2026-05-25  
**Authoritative run ID:** `20260525-2222-run-39f3e2`  
**Task:** Add `toJSON(): { totalCostUsd, limitUsd, runCount }` to `CostTracker`

## Overall Result (authoritative run)

| Metric | Value | Target |
|--------|-------|--------|
| Status | ✓ success | — |
| Total cost | $1.32 | < $1.96 ceiling |
| Duration | 208s (3m 28s) | — |
| Nodes | 31/31 | 31/31 |
| Coder turns | 16 | < 40 |
| Implement node cost | $1.19 / 99s | — |

Pipeline branch: `bollard/20260525-2222-run-39f3e2`. Coder completed implement at turn 16 with `stop=end_turn`. `static-checks` passed.

## Pre-flight baseline (Step 0)

| Item | Value |
|------|-------|
| Git SHA (start) | `e019439f6e3e87f1580abc9be4d7e37d99e2e5b7` |
| Tests before | 1237 passed / 6 skipped |
| Cost baseline | `stage5a-validated` — $1.633, 20% threshold ($1.96 ceiling) |

## Phase 15 Validation — Stryker Mutation Signal

| Metric | Value |
|--------|-------|
| `totalMutants` | **204** |
| `killed` | 184 |
| `survived` | 20 |
| `noCoverage` | 0 |
| `stryker_no_mutants` warning? | **absent** |
| Mutation score | **90.20%** |
| Duration (node 22) | 42.0s |
| `scopedToFiles` | true (1 affected file) |
| Vitest config used | `vitest.stryker.config.ts` (via `deriveVitestConfigFile` fix) |

**Verdict:** ✓ **Phase 15 live pipeline GREEN** — Docker smoke (202 mutants) and node 22 pipeline run (204 mutants) both produce real mutation signal.

## Phase 14 Validation — Contract Grounding

| Scope | Proposed | Grounded | Dropped | Drop rate |
|-------|----------|----------|---------|-----------|
| Boundary | 12 | 12 | 0 | 0% |
| Contract | 7 | 5 | 2 | **28.6%** |

**Verdict:** ✓ held (28.6% < 30%)

**Dropped contract claims:** `c5`, `c6` (`grounding_not_in_context`).

## Node-by-node status (31/31)

| # | Node | Status |
|---|------|--------|
| 1 | create-branch | ok |
| 2 | generate-plan | ok |
| 3 | approve-plan | ok |
| 4 | expand-affected-files | ok |
| 5 | implement | ok |
| 6 | static-checks | ok |
| 7 | extract-signatures | ok |
| 8 | generate-tests | ok |
| 9 | verify-boundary-grounding | ok |
| 10 | write-tests | ok |
| 11 | run-tests | ok |
| 12 | assess-contract-risk | ok |
| 13 | extract-contracts | ok |
| 14 | generate-contract-tests | ok |
| 15 | verify-claim-grounding | ok |
| 16 | write-contract-tests | ok |
| 17 | run-contract-tests | ok |
| 18 | extract-behavioral-context | ok |
| 19 | generate-behavioral-tests | ok |
| 20 | verify-behavioral-grounding | ok |
| 21 | write-behavioral-tests | ok |
| 22 | run-behavioral-tests | ok |
| 23 | extract-probes | ok |
| 24 | run-mutation-testing | ok |
| 25 | generate-review-diff | ok |
| 26 | extract-code-metrics | ok |
| 27 | semantic-review | ok |
| 28 | verify-review-grounding | ok |
| 29 | docker-verify | ok |
| 30 | generate-diff | ok |
| 31 | approve-pr | ok |

## Infrastructure fix shipped with this self-test

`deriveVitestConfigFile(workDir, profile)` in [`packages/verify/src/mutation.ts`](../packages/verify/src/mutation.ts) now prefers `vitest.stryker.config.ts` when present in the workspace. Without this, Stryker used `vitest.config.ts` and the initial dry-run failed when integration tests failed (or when the default suite was incompatible with mutation).

## First pipeline attempt (failed Phase 15 gate)

| Item | Value |
|------|-------|
| Run ID | `20260525-2205-run-adbe8f` |
| Nodes | 31/31 (CLI success) |
| Cost | $5.11 |
| Coder turns | 54 |
| Stryker | `totalMutants: 0`, `stryker_no_mutants` |
| Root cause | Stryker dry-run: `ConfigError: There were failed tests in the initial test run` — coder broke `summary()` (`totalFormatted` undefined) and used `vitest.config.ts` |

This run is documented for regression context; **authoritative validation** is run `39f3e2` after the vitest.stryker fix on `main`.

## Cost regression

| Metric | Value |
|--------|-------|
| This run (39f3e2) | $1.32 |
| Baseline ceiling | $1.96 |
| `cost-baseline diff` (repo aggregate) | **fail** (+77% avg over 7 runs since tag — dominated by prior $5+ self-tests) |

Per-run cost for the authoritative run is **under** the $1.96 ceiling.

## Test suite

| Before (pre-flight) | After (post GREEN run) |
|---------------------|------------------------|
| 1237 passed / 6 skipped | 1251 passed / 6 skipped |

+14 net new tests from `toJSON()` describe block (+1 mutation test for vitest.stryker preference).

## Implementation notes

`toJSON()` returns `{ totalCostUsd: this.total(), limitUsd: this.limitUsd(), runCount: this.runCount() }` — pure read, no side effects. Tests cover direct calls, `JSON.stringify(tracker)` auto-invocation, idempotency, and state preservation.

## Validation gate checklist

| Gate | Result |
|------|--------|
| 31/31 nodes | ✓ |
| `totalMutants > 0`, no `stryker_no_mutants` | ✓ (204 mutants) |
| Contract drop ≤ 30% | ✓ (28.6%) |

**Phase 15 fully closed:** Docker smoke + live `implement-feature` node 22.
