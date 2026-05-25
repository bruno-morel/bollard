# Cursor Prompt — Self-Test: CostTracker.withLimit() + Phase 14/15 Validation

> **Context:** This is a Bollard-on-Bollard self-test. You will run the `implement-feature`
> pipeline on a real task, then analyse the run in detail and produce a structured learnings
> report. The goal is threefold:
> (1) Validate Phase 14 fix — contract grounding corpus now includes `ctx.task` and
>     `plan.acceptance_criteria[]`. Expected: contract claim drop rate drops from 55–88%
>     (pre-fix) to near-zero on a bounded single-method task.
> (2) Validate Phase 15 fix — Stryker now uses `node_modules/.bin/stryker run` directly.
>     Expected: `totalMutants > 0` in the log (real mutation signal), OR explicit
>     `warning: "stryker_no_mutants"` flag if a deeper Docker environment issue persists.
> (3) Confirm the hardening fixes from Phases 11–13 (scope guard, structured test output,
>     agentBudgets) continue to hold, and that the cost regression from the merge() run
>     ($4.75) was an anomaly driven by in-plan test-file churn rather than a structural
>     regression.
>
> **Read CLAUDE.md fully before starting.** Then read:
> - `packages/engine/src/cost-tracker.ts` — the class you will be adding a method to
> - `packages/engine/tests/cost-tracker.test.ts` — existing test structure (1211 tests total)
> - `.bollard/cost-baseline.json` — current baseline
> - `spec/ROADMAP.md §5d` — Phases 11–15 and their validation criteria

---

## Step 1 — Run the pipeline

```bash
docker compose run --rm \
  -e ANTHROPIC_API_KEY \
  -e BOLLARD_AUTO_APPROVE=1 \
  dev sh -c \
  'git config --global --add safe.directory /app && \
   pnpm --filter @bollard/cli run start -- run implement-feature \
   --task "Add a withLimit(newLimit: number): CostTracker method to CostTracker that returns a new CostTracker with the same accumulated total as the receiver but with newLimit as its limit. The receiver must not be mutated. newLimit must be a non-negative finite number; throw BollardError with code CONTRACT_VIOLATION if newLimit is negative or non-finite. The returned tracker'\''s exceeded() and remaining() reflect newLimit, not the receiver'\''s original limit." \
   --work-dir /app 2>&1' | tee .bollard/self-test-with-limit.log
```

**Wait for the run to complete before proceeding to Step 2.**

If the run fails due to a Git lock, clear it:
```bash
rm -f .git/HEAD.lock .git/index.lock
```
and retry.

---

## Step 2 — Extract structured metrics from the log

Parse `.bollard/self-test-with-limit.log` and extract:

### 2a. Overall result
- Run ID (look for `Run ID:` or `runId` in the log)
- Status (success / failure / handed_to_human)
- Total cost ($)
- Total duration (seconds)
- Node count (e.g. `31/31`)

### 2b. Coder agent metrics
- Number of coder turns
- Did the hard-exit fire? (look for `SYSTEM: You have` or `forced-completion`)
- Did rollback occur? (look for `[rollback]`)
- Did the scope guard fire? (look for `not in the plan's affected_files` in the log)
- Did the structured test output fire? (look for `test failure summary:` in any run_command output)

### 2c. Per-scope grounding results — **PRIMARY VALIDATION FOR PHASE 14**
- Boundary: claims proposed / grounded / dropped
- Contract: claims proposed / grounded / dropped — **compare to pre-fix 55–88% drop rate**
  - Did any claims survive that would previously have been sourced from task_description or acceptance_criteria?
- Behavioral: claims proposed / grounded / dropped (likely skipped — withLimit() adds no endpoints)

### 2d. Mutation testing — **PRIMARY VALIDATION FOR PHASE 15**
Look for `mutation_testing_result` event in the log:
- `totalMutants`: if > 0 → Phase 15 fix worked (real mutation signal)
- `warning: "stryker_no_mutants"` present → binary path fix insufficient; Docker env issue persists
- `skipped: true, reason: "mutation testing not enabled"` → mutation not enabled (check `.bollard.yml`)

### 2e. Promotion candidates (Signal 1)
- Did the `approve-pr` gate surface any promotion candidates?

### 2f. Cost regression check
```bash
docker compose run --rm -e ANTHROPIC_API_KEY dev sh -c \
  'git config --global --add safe.directory /app && \
   pnpm --filter @bollard/cli run start -- cost-baseline diff'
```
Record: pass / fail, current average vs baseline ceiling.

### 2g. Test suite after the run
```bash
docker compose run --rm dev run test 2>&1 | tail -5
```
Record: total passed / skipped. Expected: ≥ 1211 passed + new withLimit() tests.

### 2h. `bollard audit-protocol` smoke check
```bash
docker compose run --rm dev sh -c \
  'git config --global --add safe.directory /app && \
   pnpm --filter @bollard/cli run start -- audit-protocol'
```
Record: cursor 5/5, claude-code 5/5.

---

## Step 3 — Produce the learnings report

Write a structured report to `spec/self-test-with-limit-results.md`:

```markdown
# Self-Test: CostTracker.withLimit() — Phase 14/15 Validation Results

**Date:** <today>
**Run ID:** <from log>
**Task:** Add withLimit(newLimit: number): CostTracker to CostTracker

## Overall Result

| Metric | Value |
|--------|-------|
| Status | ✓ success / ✗ failure |
| Total cost | $X.XX |
| Duration | Xs |
| Nodes | XX/31 |
| Coder turns | N |

## Phase 14 Validation — Contract Grounding Corpus

| Scope | Proposed | Grounded | Dropped | Drop rate | vs pre-fix |
|-------|----------|----------|---------|-----------|------------|
| Boundary | N | N | N | N% | — |
| Contract | N | N | N | N% | pre-fix: 55–88% |
| Behavioral | N/skipped | — | — | — | — |

**Verdict:** ✓ fixed (drop rate < 30%) / ✗ still broken / ⚠ partial

**Surviving claims (contract):** List which claims grounded and their sources. Note if any
grounded against task_description or acceptance_criteria text (these would have dropped pre-fix).

## Phase 15 Validation — Stryker Mutation Signal

| Metric | Value |
|--------|-------|
| `totalMutants` | N |
| `killed` | N |
| `survived` | N |
| `stryker_no_mutants` warning? | yes / no |
| Mutation score | N% |

**Verdict:** ✓ fixed (totalMutants > 0) / ✗ still no-op (stryker_no_mutants logged) / ✗ skipped

## Hardening Fixes — Continued Observation

| Fix | Fired? | Notes |
|-----|--------|-------|
| Scope guard (`allowedWritePaths`) | yes/no | paths blocked, if any |
| Structured test output | yes/no | `test failure summary:` seen in log |
| Hard-exit injection | yes/no | turn it fired at, if any |
| agentBudgets cap | yes/no | cap applied, if any |

## Token Economy

| Metric | Value | vs prior runs |
|--------|-------|---------------|
| Coder turns | N | prev: 19 (runCount), 32 (formatCost), 51 (merge) |
| Total coder cost | $X.XX | — |
| Forced-completion injected | yes/no | — |
| Rollback occurred | yes/no | — |

## Signal 1 — Promotion Candidates

<list any files surfaced at approve-pr, or "none">

## Cost Regression

| Metric | Value |
|--------|-------|
| Baseline ceiling | $X.XX |
| This run cost | $X.XX |
| `cost-baseline diff` | pass / fail |

## Test Suite

| Before run | After run |
|------------|-----------|
| 1211 passed / 6 skipped | N passed / 6 skipped |

## Protocol Compliance

| Platform | Score |
|----------|-------|
| cursor | 5/5 |
| claude-code | 5/5 |

## Issues Found

<any unexpected failures, retries, lint errors, or pipeline anomalies — be specific>

## Observations vs Previous Runs

<compare against:
- 2026-05-18 runCount(): $0.88, 19 turns, 31/31, contract 5/8 (drop 3, 37.5%)
- 2026-05-19 formatCost(): $1.63, 32 turns, 31/31
- 2026-05-25 merge(): $4.75, 51 turns, 31/31, contract 1/8 (drop 7, 87.5%)
Note whether Phase 14 improved contract grounding. Note whether Phase 15 produced real mutants.>

## Recommended Follow-ups

<any issues that should become ROADMAP items or Cursor prompts>
```

---

## Step 4 — Update CLAUDE.md

Add a self-test entry to the "What Bollard Is" paragraph (after the merge() self-test entry):

```
Self-test **2026-05-25** (run id `<runId>`, `CostTracker.withLimit()` — Phase 14/15 validation: contract grounding corpus fix + Stryker binary path fix) completed **XX/31** nodes successfully. Total cost **$X.XX**; **implement** ~**Xs**, **$X.XX** (coder **N** turns). Boundary grounding **N/N** (drop N), contract **N/N** (drop N — <vs 87.5% pre-fix>). Stryker: <totalMutants N, score N%> / <stryker_no_mutants>. See [spec/self-test-with-limit-results.md](../spec/self-test-with-limit-results.md).
```

---

## Step 5 — Commit

```bash
git add packages/engine/src/cost-tracker.ts
git add packages/engine/tests/cost-tracker.test.ts
git add spec/self-test-with-limit-results.md
git add CLAUDE.md
git commit -m "feat: CostTracker.withLimit() — Phase 14/15 validation, XX/31 nodes, \$X.XX, N coder turns"
git push origin main
```

Do NOT commit `.bollard/self-test-with-limit.log` — it is gitignored.

---

## What to watch for

### Phase 14 (contract grounding) — PRIMARY
- **Contract drop rate < 30%:** This is the pass criterion. Pre-fix drop rates were 37.5%
  (runCount), 87.5% (merge). Post-fix should be < 30% because claims quoting from `# Task`
  and `# Acceptance criteria` now pass grounding.
- **Contract drop rate still > 30%:** If this happens, inspect which claims dropped and
  what their `grounding[].source` fields say. If they're quoting from sources other than
  task/criteria/signatures (e.g. external imports not in the graph), that's a new corpus gap
  to document.
- **Contract drop rate = 0%:** Best case. Document the surviving claim sources.

### Phase 15 (Stryker) — PRIMARY
- **`totalMutants > 0` in `mutation_testing_result` log event:** Phase 15 fix worked.
  Record the score, killed/survived counts.
- **`warning: "stryker_no_mutants"` in log:** Binary path fix insufficient — Stryker runs
  but still produces nothing. A deeper Docker env issue likely. Flag for ROADMAP.
- **`mutation testing not enabled`:** Check that `.bollard.yml` doesn't explicitly disable
  mutation. Auto-detection should enable it (Bollard has `@stryker-mutator/core` in devDeps).

### Secondary signals
- **Coder turns > 35:** Test-file churn again; note whether scope guard prevented OOB edits.
- **Cost > $1.96 baseline ceiling:** `cost-baseline diff` will catch this.
- **`withLimit()` mutates `this`:** Coder misread the task — the receiver must not change.
- **`withLimit()` uses `this._limit` for returned tracker:** Should use `newLimit`, not the
  receiver's original limit.
- **`CONTRACT_VIOLATION` not thrown for `newLimit < 0` or `NaN`:** Guard missing.

---

## Constraints

- **`BOLLARD_AUTO_APPROVE=1`** — pipeline runs unattended
- **Do not manually implement withLimit()** — let the pipeline do it
- **Do not edit any existing tests** — scope guard enforces this at tool level
- **If the pipeline leaves lint/format errors**, apply `biome format --write .` and note it
- **Log file stays in `.bollard/`** — gitignored; only commit source changes and results doc
