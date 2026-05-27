# Self-Test: CostTracker.cap() — Phase 16 Third Validation + Baseline Retag Attempt

**Date:** 2026-05-27  
**Authoritative run ID:** `20260527-0134-run-3be761` (31/31 GREEN — verification-only)  
**Task:** Add `cap(maxUsd: number): CostTracker` — ceiling-only in-place mutator returning `this` for chaining

## Overall Result (authoritative run)

| Metric | Value | Target |
|--------|-------|--------|
| Status | ✓ success | — |
| Total cost | $0.20 | < $1.96 ceiling |
| Duration | 148s (2m 28s) | — |
| Nodes | 31/31 | 31/31 |
| Coder turns | 3 | < 25 (Phase 16) |
| Implement node cost | $0.06 / 53s | — |

**Degenerate scenario:** `cap()` and unit tests were already on `main` from two prior forward attempts before run `3be761`. Planner emitted `affected_files.modify: []`; coder verified existing implementation in 3 turns (same pattern as `snapshotTotal()` Phase 10 degenerate run).

## Pre-flight baseline (Step 0)

| Item | Value |
|------|-------|
| Git SHA (start) | `4ab6f3f9667fbb71daeafc3e9a2a96b7e9a0724b` |
| Tests before | 1252 passed / 6 skipped |
| Cost baseline | `stage5a-validated` — $1.633, 20% threshold ($1.96 ceiling) |

## Forward implement attempts (prior to GREEN verification run)

Two full forward runs failed before manual unit-test hardening and verification re-run:

| Run ID | Nodes | Total cost | Coder turns | Failure |
|--------|-------|------------|-------------|---------|
| `20260527-0119-run-5dce47` | 17/31 | $3.17 | 34 | Contract test LLM bug (`add(30).cap(50).add(10)` expected 50, correct 40) |
| `20260527-0126-run-2a12d4` | 23/31 | $3.63 | ~38 | Mutation score 78.7% < 80% threshold (`cap()` mutants NoCoverage — adversarial tests excluded from Stryker config) |

**Manual follow-up (between attempts 2 and 3):** Added 9 `cap()` unit tests to `cost-tracker.test.ts` (post–Layer 1 hardening, same pattern as divide self-test). Local Stryker on `cost-tracker.ts`: **85.11%** (200 killed / 235 total).

## Phase 16 Validation — Test-Surgery-Loop Guard

### Forward runs (`5dce47`, `2a12d4`)

| Signal | Result |
|--------|--------|
| Layer 1 (strip pre-existing `*.test.ts` from `allowedWritePaths`) | **Fired** — planner listed `cost-tracker.test.ts`; coder attempted `edit_file` at turns 5–13, 25+; **no bytes changed** on disk |
| Layer 2 (`MAX_TEST_INVOCATIONS` = 5) | **Did not fire** on either run |
| `cost-tracker.test.ts` in final diff | **No** (until manual hardening after run 2) |
| Surgery-loop pattern | **Partially mitigated** — Layer 1 blocked unit-test edits, but coder still burned **34–38 turns** on test-file workarounds (scratch files, repeated `edit_file` attempts) vs percentUsed **22 turns / $1.90** |

### Verification run (`3be761`)

| Signal | Result |
|--------|--------|
| Layer 1 | **Did not fire** — `affected_files.modify: []`; no test-file edit attempts |
| Layer 2 | **Did not fire** |
| Coder turns | **3** |

## Phase 14 Validation — Contract Grounding (run `3be761`)

| Scope | Proposed | Grounded | Dropped | Drop rate |
|-------|----------|----------|---------|-----------|
| Boundary | 18 | 16 | 2 | 11.1% |
| Contract | 6 | 6 | 0 | **0%** |

**Verdict:** ✓ held (0% contract drop < 30%)

## Phase 15 Validation — Stryker Mutation Signal

| Metric | Run `3be761` | Manual (post unit tests) |
|--------|--------------|--------------------------|
| `totalMutants` | **0** (`stryker_no_mutants` — verification-only, `affectedFileCount: 0`) | **235** |
| Mutation score | skipped | **85.11%** |
| `stryker_no_mutants` warning? | **present** (expected for verification-only) | absent |

**Verdict:** ✓ Phase 15 holds on manual Stryker smoke; pipeline node skipped mutants on verification-only scope (same class as prior re-verification runs).

## Validation table (authoritative run `3be761`)

| Metric | Result | Target |
|--------|--------|--------|
| Total nodes | 31/31 | 31/31 |
| Total cost | $0.20 | < $1.96 |
| Coder turns | 3 | < 25 |
| Layer 1 fired? | no (verification-only) | either ok |
| Layer 2 fired? | no | ideal |
| Boundary grounding | 16/18 (drop 11.1%) | drop 0 (informational) |
| Contract grounding | 6/6 (drop 0%) | ≤ 30% |
| Stryker totalMutants | 0 (skip) | > 0 on forward runs |
| `cost-tracker.test.ts` edited by coder | no | **no** |
| cost-baseline diff | fail (+51.96% repo avg) | informational |

## Baseline retag — **SKIPPED**

Forward implement runs **$3.17** and **$3.63** both exceed the **$1.96** per-run ceiling. Verification-only run **$0.20** is not comparable to forward `toJSON` ($1.32) / `percentUsed` ($1.90) runs for three-run average retag.

| Run | Cost | Usable for retag avg? |
|-----|------|----------------------|
| toJSON (`20260525-2222-run-39f3e2`) | $1.32 | yes |
| percentUsed (`20260527-0056-run-ace38a`) | $1.90 | yes |
| cap forward (`5dce47` / `2a12d4`) | $3.17 / $3.63 | **no** — over ceiling + incomplete |
| cap verification (`3be761`) | $0.20 | **no** — degenerate (pre-merged code) |

Baseline remains `stage5a-validated` at $1.633.

## Cost regression

| Metric | Value |
|--------|-------|
| Authoritative run (`3be761`) | $0.20 |
| `cost-baseline diff` | **fail** (+51.96% avg over 9 runs since tag — includes $3–5 surgery-loop era runs) |

## Test suite

| Before (pre-flight) | After (post GREEN + unit tests) |
|---------------------|----------------------------------|
| 1252 passed / 6 skipped | **1261 passed / 6 skipped** (+9 `cap()` unit tests) |

## Implementation notes

`cap(maxUsd)` inserted after `clamp()` in [`packages/engine/src/cost-tracker.ts`](../packages/engine/src/cost-tracker.ts):

- Validates `Number.isFinite(maxUsd) && maxUsd >= 0` → `CONTRACT_VIOLATION`
- If `this._total > maxUsd`, sets `this._total = maxUsd`
- Returns `this` for chaining
- Equivalent ceiling semantics to `clamp(0, maxUsd)` without floor branch

## Validation gate checklist

- [x] 31/31 nodes completed (run `3be761`)
- [x] Coder turns < 25 on authoritative run (3)
- [x] Coder did not edit `cost-tracker.test.ts` during pipeline runs
- [x] Stryker `totalMutants` > 0 on manual smoke (235)
- [ ] Cost baseline retagged — **skipped** (no forward run under $1.96)

## Notable findings

1. **Contract-tester arithmetic bug (run 1):** Generated test expected `50` after `add(30).cap(50).add(10)`; correct total is **40**. Infrastructure failure mode for chained mutators.
2. **Stryker NoCoverage on `cap()` without unit tests:** Adversarial tests live in `*.adversarial.test.ts`, excluded from `vitest.stryker.config.ts`. Forward run 2 failed 78.7% < 80% until unit tests added — same gap as percentUsed (which passed 85% because prior methods already had unit coverage).
3. **Phase 16 Layer 1 effective but turn cost remains high** when planner lists `cost-tracker.test.ts`: 34–38 coder turns vs 22 for percentUsed — blocked edits still consume turns on workarounds.
