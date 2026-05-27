# Self-Test: CostTracker.percentUsed() — Phase 16 Test-Surgery-Loop Guard Validation

**Date:** 2026-05-27  
**Authoritative run ID:** `20260527-0056-run-ace38a`  
**Task:** Add `percentUsed(): number` to `CostTracker` (scalar counterpart to `summary()` percentage logic, clamped to `[0, 100]`)

## Overall Result (authoritative run)

| Metric | Value | Target |
|--------|-------|--------|
| Status | ✓ success | — |
| Total cost | $1.90 | < $1.96 ceiling |
| Duration | 279s (4m 39s) | — |
| Nodes | 31/31 | 31/31 |
| Coder turns | 22 | < 25 (Phase 16) |
| Implement node cost | $1.77 / 163s | — |

Pipeline branch: `bollard/20260527-0056-run-ace38a`. Coder completed implement at turn 22 with `stop=end_turn`. `static-checks` passed.

## Pre-flight baseline (Step 0)

| Item | Value |
|------|-------|
| Git SHA (start) | `e0f889a4c8804c4fbdd1385de80fdc01d7703b14` |
| Tests before | 1252 passed / 6 skipped |
| Cost baseline | `stage5a-validated` — $1.633, 20% threshold ($1.96 ceiling) |

## Phase 16 Validation — Test-Surgery-Loop Guard

| Signal | Result |
|--------|--------|
| Layer 1 (strip pre-existing `*.test.ts` from `allowedWritePaths`) | **Fired** — planner listed `packages/engine/tests/cost-tracker.test.ts` in `affected_files.modify`; coder attempted `edit_file` on that path at turns 9, 10, and 13; **no bytes changed** on disk (`git diff` empty for that file) |
| Layer 2 (`MAX_TEST_INVOCATIONS` = 5) | **Did not fire** — 2 test-command invocations (turns 15–16) |
| `cost-tracker.test.ts` in final diff | **No** |
| Surgery-loop pattern vs clamp/merge/limitUsd | **Eliminated** — 22 turns / $1.90 vs 51–54 turns / $3.21–$5.02 |

**Coder test-workaround behavior (non-blocking):** After Layer 1 blocked unit-test edits, the coder wrote scratch files (`test-percentused.js` at workspace root, `packages/engine/src/temp-tests.txt`) — both blocked or not retained; declared completion without unit tests in `cost-tracker.test.ts`. Boundary scope updated `cost-tracker.adversarial.test.ts` via `write-tests` (pipeline node, outside Layer 1).

**Semantic review:** Finding `r1` noted plan/diff mismatch (plan: `cost-tracker.test.ts`, diff: `cost-tracker.adversarial.test.ts`) — expected under Phase 16.

## Phase 14 Validation — Contract Grounding

| Scope | Proposed | Grounded | Dropped | Drop rate |
|-------|----------|----------|---------|-----------|
| Boundary | 10 | 10 | 0 | 0% |
| Contract | 8 | 8 | 0 | **0%** |

**Verdict:** ✓ held (0% < 30%)

## Phase 15 Validation — Stryker Mutation Signal

| Metric | Value |
|--------|-------|
| `totalMutants` | **217** |
| `killed` | 185 |
| `survived` | 19 |
| `noCoverage` | 13 |
| `stryker_no_mutants` warning? | **absent** |
| Mutation score | **85.25%** |
| Duration (node 24) | 46.3s |

**Verdict:** ✓ Phase 15 continues to hold

## Validation table (plan gate)

| Metric | Result | Target |
|--------|--------|--------|
| Total nodes | 31/31 | 31/31 |
| Total cost | $1.90 | < $1.96 |
| Coder turns | 22 | < 25 |
| Layer 1 fired? | yes (effective block) | either ok |
| Layer 2 fired? | no | ideal |
| Boundary grounding | 10/10 (drop 0) | drop 0 |
| Contract grounding | 8/8 (drop 0%) | ≤ 30% |
| Stryker totalMutants | 217 | > 0 |
| cost-baseline diff | fail (repo avg) | informational |

**Phase 16 GREEN:** ✓ all four gates passed

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

## Cost regression

| Metric | Value |
|--------|-------|
| This run (ace38a) | $1.90 |
| Baseline ceiling | $1.96 |
| `cost-baseline diff` (repo aggregate) | **fail** (+69.45% avg over 8 runs since tag — prior $5+ self-tests dominate) |

Per-run cost is **under** the $1.96 ceiling.

## Test suite

| Before (pre-flight) | After (post GREEN run) |
|---------------------|------------------------|
| 1252 passed / 6 skipped | 1252 passed / 6 skipped |

No new main-suite unit tests in `cost-tracker.test.ts` (Layer 1); adversarial file churn only.

## Implementation notes

`percentUsed()` mirrors `summary()` zero-limit branches (`limit === 0` → 0 or 100) and adds `Math.min(Math.max(percentage, 0), 100)` clamping. Inserted immediately before `summary()` in [`packages/engine/src/cost-tracker.ts`](../packages/engine/src/cost-tracker.ts).

## Validation gate checklist

- [x] 31/31 nodes completed  
- [x] Coder turns < 25 (22)  
- [x] No edits to `packages/engine/tests/cost-tracker.test.ts`  
- [x] Stryker `totalMutants` > 0 (217)
