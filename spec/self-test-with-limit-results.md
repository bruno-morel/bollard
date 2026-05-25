# Self-Test: CostTracker.withLimit() — Phase 14/15 Validation Results

**Date:** 2026-05-25
**Run ID:** 20260525-2025-run-ecae8e
**Task:** Add withLimit(newLimit: number): CostTracker to CostTracker

## Overall Result

| Metric | Value |
|--------|-------|
| Status | ✗ failure (halted at `run-contract-tests`, node 17/31) |
| Total cost | $4.75 |
| Duration | 231.0s |
| Nodes | 16/31 completed before halt (`run-tests` skipped; `run-contract-tests` failed) |
| Coder turns | 54 |

Pipeline branch: `bollard/20260525-2025-run-ecae8e`. Coder completed implement node at turn 54 with `stop=end_turn` ($4.61, 174.3s). `static-checks` passed. Downstream halted when 3/6 contract tests failed (`TEST_FAILED` — contract node uses `onFailure: stop`, not skip).

## Phase 14 Validation — Contract Grounding Corpus

| Scope | Proposed | Grounded | Dropped | Drop rate | vs pre-fix |
|-------|----------|----------|---------|-----------|------------|
| Boundary | 15 | 15 | 0 | 0% | — |
| Contract | 8 | 6 | 2 | 25% | pre-fix: 37.5%–87.5% |
| Behavioral | skipped | — | — | — | `behavioral.enabled: false` |

**Verdict:** ✓ fixed (drop rate 25% < 30% threshold)

**Surviving claims (contract):**

| ID | Grounding sources | Notes |
|----|-------------------|-------|
| c2 | plan summary, **acceptance criteria** | Immutability — would have dropped pre-fix |
| c3 | **acceptance criteria** | exceeded/remaining reflect newLimit |
| c4 | plan summary, **acceptance criteria** | negative newLimit → CONTRACT_VIOLATION |
| c5 | plan summary | non-finite newLimit → CONTRACT_VIOLATION |
| c6 | plan summary | zero as valid newLimit |
| c8 | signature, plan summary | runCount preservation (test design issue, not task requirement) |

**Dropped claims:**

| ID | Reason | Detail |
|----|--------|--------|
| c1 | `grounding_not_in_context` | Full task string cited as `plan summary` — quote does not match `plan.summary` corpus entry (shorter planner summary) |
| c7 | `grounding_not_in_context` | Cross-module `@bollard/cli → @bollard/engine` edge paraphrase — expected graph-scope gap |

Phase 14 corpus fix confirmed: **4/6 surviving claims** ground against **acceptance criteria** or task-adjacent plan text that was absent from the pre-fix corpus. Drop rate fell from **87.5%** (merge run) to **25%**.

## Phase 15 Validation — Stryker Mutation Signal

| Metric | Value |
|--------|-------|
| `totalMutants` | — (node not reached) |
| `killed` | — |
| `survived` | — |
| `stryker_no_mutants` warning? | no |
| Mutation score | — |

**Verdict:** ✗ skipped — pipeline halted at node 17 before `run-mutation-testing` (node 22). Phase 15 live validation deferred to next full forward run.

## Hardening Fixes — Continued Observation

| Fix | Fired? | Notes |
|-----|--------|-------|
| Scope guard (`allowedWritePaths`) | no (coder) | No `not in the plan's affected_files` errors. Coder stayed within `cost-tracker.ts` + `cost-tracker.test.ts`. Turn 28 `write_file` to `test-withLimit.js` at workspace root succeeded in-container but file not retained on host (not committed). |
| Structured test output | no | No `test failure summary:` in log — coder test commands exited 0 or did not hit vitest failure paths. |
| Hard-exit injection | no | Coder ended at turn 54 with `stop=end_turn`; no `SYSTEM: You have` / forced-completion message in log. |
| agentBudgets cap | n/a (YAML) | `.bollard.yml` has no `agentBudgets`; per-attempt cap $5 (`max_cost_usd / 2`). Implement cost $4.61 — under cap. |

## Token Economy

| Metric | Value | vs prior runs |
|--------|-------|---------------|
| Coder turns | 54 | prev: 19 (runCount), 32 (formatCost), 51 (merge) |
| Total coder cost (implement) | $4.61 | — |
| Pipeline total cost | $4.75 | +191% vs formatCost; same band as merge ($4.75) |
| Forced-completion injected | no | — |
| Rollback occurred | no | — |

**Turn budget drivers:** Same pattern as merge() — extensive in-plan `cost-tracker.test.ts` editing (describe block insertion, lint/format loops turns 40–52). Planner produced **4** acceptance criteria (within 3–5 cap).

## Signal 1 — Promotion Candidates

none — pipeline halted before `approve-pr`.

## Cost Regression

| Metric | Value |
|--------|-------|
| Baseline ceiling | $1.96 (20% over $1.633) |
| This run cost | $4.75 |
| `cost-baseline diff` | **FAIL** — $2.20 avg over 4 runs since baseline (+34.53% > 20%) |

## Test Suite

| Before run | After run (post cleanup) |
|------------|--------------------------|
| 1211 passed / 6 skipped | **1226** passed / 6 skipped |

**+15** tests net (`withLimit()` describe block). Post-pipeline: reverted pipeline-generated `cost-tracker.adversarial.test.ts` (2 failing boundary cases expecting negative `remaining()`); lint + typecheck clean.

## Protocol Compliance

| Platform | Score |
|----------|-------|
| cursor | 5/5 |
| claude-code | 5/5 |

## Issues Found

1. **Pipeline halt:** `run-contract-tests` failed 3/6 — contract-tester generated assertions inconsistent with `CostTracker.remaining()` (`Math.max(0, limit - total)` never negative):
   - `returned tracker uses newLimit for exceeded and remaining` — expected `remaining() < 0`
   - `withLimit accepts zero as valid newLimit` — expected `remaining() === -10`
   - `withLimit preserves runCount` — expected copied runCount; task spec does not require it; implementation correctly leaves runCount at 0 on new instance

2. **`run-tests` failed (skipped):** Boundary adversarial file 2/15 failed — same negative-`remaining()` expectation. Reverted adversarial file to pre-run state for commit.

3. **Coder turn churn:** 54 turns / $4.61 — in-plan test-file editing, not OOB scope violation. Cost anomaly persists vs sub-$2 baseline runs.

4. **Phase 15 not exercised:** Mutation node never reached; Stryker binary-path fix unvalidated in live pipeline.

5. **`withLimit()` implementation:** Correct per task — validates finite non-negative `newLimit`, throws `CONTRACT_VIOLATION`, returns new instance with `newLimit` and copied `_total`, receiver unchanged.

## Observations vs Previous Runs

| Run | Cost | Coder turns | Nodes | Contract drop |
|-----|------|-------------|-------|---------------|
| 2026-05-18 runCount() | $0.88 | 19 | 31/31 | 3/8 (37.5%) |
| 2026-05-19 formatCost() | $1.63 | 32 | 31/31 | — |
| 2026-05-25 merge() | $4.75 | 51 | 31/31 | 7/8 (87.5%) |
| **2026-05-25 withLimit()** | **$4.75** | **54** | **16/31 halt** | **2/8 (25%)** |

**Phase 14:** Contract drop rate improved dramatically (87.5% → 25%). Claims quoting acceptance criteria now survive grounding — primary validation **passed**.

**Phase 15:** Not validated this run — pipeline stopped at contract test execution.

**Token economy:** Cost/turn profile matches merge() anomaly (in-plan test churn), not a new structural regression. Scope guard did not fire; hardening fixes from Phases 11–13 held where applicable.

## Recommended Follow-ups

1. **Re-run forward self-test** (or lower-severity `run-contract-tests` policy for validation runs) to reach `run-mutation-testing` and validate Phase 15 (`totalMutants > 0` vs `stryker_no_mutants`).

2. **Contract-tester test design:** Teach prompt or post-filter that `remaining()` is clamped to ≥ 0 — adversarial/contract tests asserting negative remaining are invalid for this API.

3. **Corpus gap (minor):** c1 dropped because claim quotes full `ctx.task` under `plan summary` source — consider normalizing task text into corpus under a distinct label or fuzzy-match planner summary vs task.

4. **Token economy:** In-plan test-file churn cap remains open (same as merge() follow-up).
