# Cursor Prompt — Self-Test: CostTracker.limitUsd() + Phase 15 Validation

> **Context:** This is a Bollard-on-Bollard self-test. You will run the `implement-feature`
> pipeline on a real task, then analyse the run in detail and produce a structured learnings
> report. The goal is twofold:
> (1) **Validate Phase 15 fix** — Stryker now uses `node_modules/.bin/stryker run` directly
>     instead of `pnpm exec stryker run`. Expected: `totalMutants > 0` in the
>     `mutation_testing_result` log event (real mutation signal), OR explicit
>     `warning: "stryker_no_mutants"` if a deeper Docker environment issue persists.
> (2) **Confirm Phase 14 holds** — contract claim drop rate should remain < 30% (was 25%
>     on withLimit(), 87.5% pre-fix).
>
> **Why `limitUsd()` instead of `withLimit()`:** The previous withLimit() self-test halted at
> node 17 (`run-contract-tests`) because the contract-tester generated assertions expecting
> negative `remaining()` values. `limitUsd()` is a pure query returning a number that is
> always ≥ 0 (enforced at construction), so the contract-tester cannot generate impossible
> assertions. The JSDoc fix for `remaining()` and `exceeded()` has already been committed
> (commit "docs: add JSDoc to remaining() and exceeded() — always ≥ 0 / always boolean") so
> that future tests on those methods are also protected.
>
> **Read CLAUDE.md fully before starting.** Then read:
> - `packages/engine/src/cost-tracker.ts` — the class you will be adding a method to
> - `packages/engine/tests/cost-tracker.test.ts` — existing test structure (1226 tests total)
> - `.bollard/cost-baseline.json` — current baseline
> - `spec/ROADMAP.md §5d` — Phase 15 validation criteria

---

## Step 1 — Run the pipeline

```bash
docker compose run --rm \
  -e ANTHROPIC_API_KEY \
  -e BOLLARD_AUTO_APPROVE=1 \
  dev sh -c \
  'git config --global --add safe.directory /app && \
   pnpm --filter @bollard/cli run start -- run implement-feature \
   --task "Add a limitUsd(): number method to CostTracker that returns the limit that was set at construction. The method must not modify any state. The returned value is always a non-negative finite number (enforced by the constructor invariant). It should reflect the limit as originally passed to the constructor, not the current total or any derived value." \
   --work-dir /app 2>&1' | tee .bollard/self-test-limit-accessor.log
```

**Wait for the run to complete before proceeding to Step 2.**

If the run fails due to a Git lock, clear it:
```bash
rm -f .git/HEAD.lock .git/index.lock
```
and retry.

---

## Step 2 — Extract structured metrics from the log

Parse `.bollard/self-test-limit-accessor.log` and extract:

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

### 2c. Per-scope grounding results — contract grounding (Phase 14 check)
- Contract: claims proposed / grounded / dropped — compare to 25% drop from withLimit()
- Did any claims drop? If so, inspect `grounding[].source` for each dropped claim.

### 2d. Mutation testing — **PRIMARY VALIDATION FOR PHASE 15**
Look for `mutation_testing_result` event in the log:
- `totalMutants`: if > 0 → Phase 15 fix worked (real mutation signal)
- `warning: "stryker_no_mutants"` present → binary path fix insufficient; Docker env issue persists
- `skipped: true, reason: "mutation testing not enabled"` → mutation not enabled (check `.bollard.yml`)

### 2e. Signal 1 promotion candidates
- Did the `approve-pr` gate surface any promotion candidates?

### 2f. Cost regression check
```bash
docker compose run --rm -e ANTHROPIC_API_KEY dev sh -c \
  'git config --global --add safe.directory /app && \
   pnpm --filter @bollard/cli run start -- cost-baseline diff'
```
Record: pass / fail, current average vs baseline ceiling ($1.96).

### 2g. Test suite after the run
```bash
docker compose run --rm dev run test 2>&1 | tail -5
```
Record: total passed / skipped. Expected: ≥ 1226 passed + new limitUsd() tests.

### 2h. `bollard audit-protocol` smoke check
```bash
docker compose run --rm dev sh -c \
  'git config --global --add safe.directory /app && \
   pnpm --filter @bollard/cli run start -- audit-protocol'
```
Record: cursor 5/5, claude-code 5/5.

---

## Step 3 — Produce the learnings report

Write a structured report to `spec/self-test-limit-accessor-results.md`:

```markdown
# Self-Test: CostTracker.limitUsd() — Phase 15 Validation Results

**Date:** <today>
**Run ID:** <from log>
**Task:** Add limitUsd(): number to CostTracker

## Overall Result

| Metric | Value |
|--------|-------|
| Status | ✓ success / ✗ failure |
| Total cost | $X.XX |
| Duration | Xs |
| Nodes | XX/31 |
| Coder turns | N |

## Phase 15 Validation — Stryker Mutation Signal

| Metric | Value |
|--------|-------|
| `totalMutants` | N |
| `killed` | N |
| `survived` | N |
| `stryker_no_mutants` warning? | yes / no |
| Mutation score | N% |

**Verdict:** ✓ fixed (totalMutants > 0) / ✗ still no-op (stryker_no_mutants logged) / ✗ skipped

## Phase 14 Validation — Contract Grounding (continued observation)

| Scope | Proposed | Grounded | Dropped | Drop rate | vs pre-fix |
|-------|----------|----------|---------|-----------|------------|
| Boundary | N | N | N | N% | — |
| Contract | N | N | N | N% | pre-fix: 55–88%, withLimit(): 25% |

**Verdict:** ✓ held (drop rate < 30%) / ✗ regression

## Hardening Fixes — Continued Observation

| Fix | Fired? | Notes |
|-----|--------|-------|
| Scope guard (`allowedWritePaths`) | yes/no | paths blocked, if any |
| Structured test output | yes/no | `test failure summary:` seen in log |
| Hard-exit injection | yes/no | turn it fired at, if any |
| JSDoc fix (remaining/exceeded) | n/a | JSDoc applied pre-run |

## Token Economy

| Metric | Value | vs prior runs |
|--------|-------|---------------|
| Coder turns | N | prev: 19 (runCount), 32 (formatCost), 54 (withLimit) |
| Total coder cost | $X.XX | — |
| Forced-completion injected | yes/no | — |
| Rollback occurred | yes/no | — |

## Signal 1 — Promotion Candidates

<list any files surfaced at approve-pr, or "none">

## Cost Regression

| Metric | Value |
|--------|-------|
| Baseline ceiling | $1.96 |
| This run cost | $X.XX |
| `cost-baseline diff` | pass / fail |

## Test Suite

| Before run | After run |
|------------|-----------|
| 1226 passed / 6 skipped | N passed / 6 skipped |

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
- 2026-05-25 withLimit(): $4.75, 54 turns, 16/31 halt (contract-tester negative-remaining bug)
Note whether Phase 15 is validated or still deferred.>

## Recommended Follow-ups

<any issues that should become ROADMAP items or Cursor prompts>
```

---

## Step 4 — Update CLAUDE.md

Add a self-test entry to the "What Bollard Is" paragraph (after the withLimit() self-test entry):

```
Self-test **2026-05-XX** (run id `<runId>`, `CostTracker.limitUsd()` — Phase 15 validation: Stryker direct binary path + continued Phase 14 observation) completed **XX/31** nodes successfully. Total cost **$X.XX**; **implement** ~**Xs**, **$X.XX** (coder **N** turns). Boundary grounding **N/N** (drop N), contract **N/N** (drop N). Stryker: <totalMutants N, score N%> / <stryker_no_mutants>. See [spec/self-test-limit-accessor-results.md](../spec/self-test-limit-accessor-results.md).
```

---

## Step 5 — Commit

```bash
git add packages/engine/src/cost-tracker.ts
git add packages/engine/tests/cost-tracker.test.ts
git add spec/self-test-limit-accessor-results.md
git add CLAUDE.md
git commit -m "feat: CostTracker.limitUsd() — Phase 15 validation, XX/31 nodes, \$X.XX, N coder turns"
git push origin main
```

Do NOT commit `.bollard/self-test-limit-accessor.log` — it is gitignored.

---

## What to watch for

### Phase 15 (Stryker) — PRIMARY
- **`totalMutants > 0` in `mutation_testing_result` log event:** Phase 15 fix worked.
  Record: score, killed/survived counts. This is the primary validation criterion.
- **`warning: "stryker_no_mutants"` in log:** Binary path fix insufficient — Stryker runs
  but still produces nothing. A deeper Docker env issue likely. Flag for ROADMAP.
- **`mutation testing not enabled`:** Check that `.bollard.yml` doesn't disable mutation.

### Phase 14 (contract grounding) — secondary observation
- **Drop rate < 30%:** Consistent with withLimit() (25%). Good.
- **Drop rate = 0%:** Even better — `limitUsd()` is a simple getter with clear semantics.
- **Any claim drops:** Inspect `grounding[].source`. If quoting from context that is now in
  the corpus (task + acceptance_criteria), that's a new gap to investigate.

### Secondary signals
- **Coder turns > 25:** Simple getter should be 5–10 turns max. If > 25, inspect what the
  coder spent turns on — likely unnecessary test-file editing.
- **`limitUsd()` modifies `_total` or `_runCount`:** Coder misread the task.
- **`limitUsd()` returns `_total` instead of `_limit`:** Wrong field returned.
- **Negative-remaining assertions in contract tests:** JSDoc fix was not applied, or
  TsCompilerExtractor doesn't surface JSDoc. If this happens, investigate whether
  `ExtractionResult.signatures[]` includes JSDoc text.

---

## Constraints

- **`BOLLARD_AUTO_APPROVE=1`** — pipeline runs unattended
- **Do not manually implement limitUsd()** — let the pipeline do it
- **Do not edit any existing tests** — scope guard enforces this at tool level
- **JSDoc fix already committed** — `remaining()` and `exceeded()` have their bounds-documenting JSDoc; no pre-run action needed
- **Log file stays in `.bollard/`** — gitignored; only commit source changes and results doc
