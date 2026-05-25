# Self-Test: CostTracker.merge() — Validation Results

**Date:** 2026-05-25
**Run ID:** 20260525-0343-run-cb1abe
**Task:** Add merge(other: CostTracker): CostTracker to CostTracker

## Overall Result

| Metric | Value |
|--------|-------|
| Status | ✓ success |
| Total cost | $4.75 |
| Duration | 451.7s |
| Nodes | 31/31 |
| Coder turns | 51 |

Pipeline completed all 31 nodes with CLI **success**. Branch: `bollard/20260525-0343-run-cb1abe`.

## Hardening Fixes — First Live Observation

| Fix | Fired? | Notes |
|-----|--------|-------|
| Scope guard (`allowedWritePaths`) | no (coder) | No `not in the plan's affected_files` errors in log. Coder stayed within `cost-tracker.ts` + `cost-tracker.test.ts`. **Gap:** `write-tests` still replaced `cost-tracker.adversarial.test.ts` (pipeline node, not coder tools). |
| Structured test output | no | No `test failure summary:` in log — coder `run_command` test invocations exited 0 or did not use the vitest paths that trigger the formatter. |
| Hard-exit injection | no | Coder ended at turn 51 with `stop=end_turn` (below turn-52 injection threshold). |
| agentBudgets cap | n/a (YAML) | `.bollard.yml` has no `agentBudgets`; coder used default **$5** per-attempt cap (`max_cost_usd / 2`). Implement node cost **$4.61** — under cap, no `COST_LIMIT_EXCEEDED`. |
| Executor pairing fix | n/a | No `400` / `tool_use id without matching tool_result` errors. |

## Token Economy

| Metric | Value | vs prior runs |
|--------|-------|---------------|
| Coder turns | 51 | prev: 19 (runCount), 32 (formatCost), 54 (clamp) — **Phase 10 regression** (> 35) |
| Total coder cost (implement) | $4.61 | — |
| Pipeline total cost | $4.75 | **+191%** vs $1.63 formatCost; **+440%** vs $0.88 runCount |
| Forced-completion injected | no | — |
| Rollback occurred | no | — |

**Turn budget drivers:** Massive in-plan rewrite of `cost-tracker.test.ts` (~1354 lines touched per diff); many `run_command` / `vitest` / `search` / `read_file` turns (turns 2–50). Planner produced **5** acceptance criteria (within 3–5 cap) but `steps[].tests` still enumerated exhaustive edge cases.

## Grounding Results

| Scope | Proposed | Grounded | Dropped | Drop rate |
|-------|----------|----------|---------|-----------|
| Boundary | 17 | 17 | 0 | 0% |
| Contract | 8 | 1 | 7 | 87.5% |
| Behavioral | skipped | — | — | — (`behavioral.enabled: false`) |

Contract drop rate exceeds the 30% watch threshold — consistent with the known corpus-scoping issue in [spec/ROADMAP.md](./ROADMAP.md) §5d (tester sees full graph, corpus is single-file).

## Signal 1 — Promotion Candidates

none — `approve-pr` auto-approved with diff only; no promotion candidate lines in log.

## Cost Regression

| Metric | Value |
|--------|-------|
| Baseline ceiling | $1.96 (20% over $1.633) |
| This run cost | $4.75 |
| `cost-baseline diff` | **FAIL** — $2.20 avg over 4 runs since baseline (+34.53% > 20%) |

This run is included in the post-baseline average and drives the regression verdict.

## Test Suite

| Before run | After run (post manual cleanup) |
|------------|----------------------------------|
| 1186 passed / 6 skipped | **1204** passed / 6 skipped |

**+18** tests net (merge `describe` block + retained suite). Post-pipeline manual fixes (documented in Issues): snapshot immutability expectation, fast-check `max: 1`, Biome `noExplicitAny` on merge invalid-input casts, `biome format`.

## Protocol Compliance

| Platform | Score |
|----------|-------|
| cursor | 5/5 |
| claude-code | 5/5 |

## Issues Found

1. **Cost regression:** $4.75 total vs $1.96 ceiling; 51 coder turns vs < 40 target. Dominant cost is implement node ($4.61, 361s).

2. **`static-checks` failed (skipped):** Lint at pipeline time — missing EOF newline on `cost-tracker.ts`, `noExplicitAny` in new merge tests, broken snapshot/property tests from coder rewrite. Fixed after run before commit.

3. **`run-tests` failed (skipped):** Boundary adversarial file had **2/17** failures (`uses receiver limit when combined total exceeds it` — wrong `remaining()` expectation). File not committed per self-test scope; left on feature branch only.

4. **Scope guard — partial:** Coder did not touch out-of-plan paths via tools, but **in-plan** `cost-tracker.test.ts` was heavily reorganized (semantic reviewer flagged plan divergence). `write-tests` overwrote `cost-tracker.adversarial.test.ts` with merge boundary tests (replaced clamp() adversarial corpus).

5. **Contract grounding 87.5% drop:** 7/8 claims dropped; 1 grounded claim survived → contract tests still written.

6. **Stryker no-op (again):** `mutation_testing_result`: `totalMutants: 0`, `score: 0` — same Docker/pnpm resolution issue as prior self-tests.

7. **Semantic review findings dropped:** `verify-review-grounding` kept 0/6 proposed findings (all dropped at grounding layer).

8. **`merge()` implementation:** Correct per task — `instanceof`, `CONTRACT_VIOLATION`, new instance with `this._limit`, combined total, no mutation of sources. Direct `_total` assignment on new instance matches existing patterns (`multiply`/`divide`).

## Observations vs Previous Runs

| Run | Cost | Coder turns | Nodes | Scope / notes |
|-----|------|-------------|-------|----------------|
| 2026-05-18 runCount() | $0.88 | 19 | 31/31 | Baseline anchor |
| 2026-05-19 formatCost() | $1.63 | 32 | 31/31 | Tier 1 patcher |
| 2026-05-25 clamp() | TBD | 54 | 31/31 | Pre scope-guard plan drift |
| **2026-05-25 merge()** | **$4.75** | **51** | **31/31** | Scope guard blocked OOB coder writes; did not stop in-plan test-file churn |

**Scope guard:** Did not fire on coder tool calls — no false positives. Did **not** prevent large edits inside allowed paths (main regression vs token-economy goals).

**Grounding:** Boundary **perfect** (17/17). Contract drop **worse** than runCount (5/8) and formatCost-era runs — structural, not merge-specific.

## Recommended Follow-ups

1. **ROADMAP:** Contract corpus expansion (`spec/prompts/fix-contract-grounding-corpus.md` per ROADMAP) — 87.5% drop on every logged forward run.

2. **Coder in-plan churn cap:** Scope guard stops OOB files but not 1300-line test rewrites; consider max edit hunks per file or “add tests only” assembler for bounded method tasks.

3. **Cost / turns:** Re-run after test-churn guard; consider retagging baseline only after a sub-$2 run.

4. **Stryker Docker smoke:** `spec/prompts/fix-stryker-docker-resolution.md` — mutation node passes with zero mutants.

5. **Restore adversarial clamp tests:** On `main`, revert `cost-tracker.adversarial.test.ts` from feature branch overwrite if merge boundary tests should live under `.bollard/tests/` only.

6. **CLAUDE.md clamp() line:** Backfill clamp() total cost from history when editing the self-test paragraph block.
