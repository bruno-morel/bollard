# Cursor Prompt — Self-Test: CostTracker.merge() + Full Instrumented Pipeline Run

> **Context:** This is a Bollard-on-Bollard self-test — the first full forward run with all 13
> infrastructure hardening fixes active simultaneously. You will run the `implement-feature`
> pipeline on a real task, then analyse the run in detail and produce a structured learnings
> report. The goal is twofold: (1) validate that all hardening (scope guard, structured test output,
> agentBudgets enforcement, executor hard-exit pairing, structured test failure output) holds under
> a real forward run, and (2) extract as much learning as possible — cost, turns, grounding rates,
> scope guard effectiveness, any failures.
>
> **Read CLAUDE.md fully before starting.** Then read:
> - `packages/engine/src/cost-tracker.ts` — the class you will be adding a method to
> - `packages/engine/tests/cost-tracker.test.ts` — existing test structure (1186 tests total)
> - `.bollard/cost-baseline.json` — current baseline
> - `spec/ROADMAP.md §5d` — what this self-test validates

---

## Step 1 — Run the instrumented pipeline

```bash
docker compose run --rm \
  -e ANTHROPIC_API_KEY \
  -e BOLLARD_AUTO_APPROVE=1 \
  dev sh -c \
  'git config --global --add safe.directory /app && \
   pnpm --filter @bollard/cli run start -- run implement-feature \
   --task "Add a merge(other: CostTracker): CostTracker method to CostTracker that combines the totals of two trackers into a new tracker without mutating either source. The new tracker uses the limit of the receiver (this). other must be a valid CostTracker instance; throw BollardError with code CONTRACT_VIOLATION if other is not provided or is not a CostTracker. The returned tracker reflects the combined total and inherits the receiver'\''s limit for exceeded() and remaining() calculations." \
   --work-dir /app 2>&1' | tee .bollard/self-test-merge.log
```

**Wait for the run to complete before proceeding to Step 2.**

If the run fails due to a Git lock, clear it:
```bash
rm -f .git/HEAD.lock .git/index.lock
```
and retry.

---

## Step 2 — Extract structured metrics from the log

Parse `.bollard/self-test-merge.log` and extract:

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

### 2c. Per-scope grounding results
- Boundary: claims proposed / grounded / dropped
- Contract: claims proposed / grounded / dropped
- Behavioral: claims proposed / grounded / dropped (likely skipped — merge() adds no endpoints)

### 2d. Promotion candidates (Signal 1)
- Did the `approve-pr` gate surface any promotion candidates?
- Which test files were flagged?

### 2e. Cost regression check
```bash
docker compose run --rm -e ANTHROPIC_API_KEY dev sh -c \
  'git config --global --add safe.directory /app && \
   pnpm --filter @bollard/cli run start -- cost-baseline diff'
```
Record: pass / fail, current average vs baseline ceiling.

### 2f. Test suite after the run
```bash
docker compose run --rm dev run test 2>&1 | tail -5
```
Record: total passed / skipped. Expected: ≥ 1186 passed + new merge() tests.

### 2g. `bollard audit-protocol` smoke check
```bash
docker compose run --rm dev sh -c \
  'git config --global --add safe.directory /app && \
   pnpm --filter @bollard/cli run start -- audit-protocol'
```
Record: cursor 5/5, claude-code 5/5.

---

## Step 3 — Produce the learnings report

Write a structured report to `spec/self-test-merge-results.md`:

```markdown
# Self-Test: CostTracker.merge() — Validation Results

**Date:** <today>
**Run ID:** <from log>
**Task:** Add merge(other: CostTracker): CostTracker to CostTracker

## Overall Result

| Metric | Value |
|--------|-------|
| Status | ✓ success / ✗ failure |
| Total cost | $X.XX |
| Duration | Xs |
| Nodes | XX/31 |
| Coder turns | N |

## Hardening Fixes — First Live Observation

| Fix | Fired? | Notes |
|-----|--------|-------|
| Scope guard (`allowedWritePaths`) | yes/no | paths blocked, if any |
| Structured test output | yes/no | `test failure summary:` seen in log |
| Hard-exit injection | yes/no | turn it fired at, if any |
| agentBudgets cap | yes/no | cap applied to which agents |
| Executor pairing fix | n/a | only observable on 400 errors |

## Token Economy

| Metric | Value | vs prior runs |
|--------|-------|---------------|
| Coder turns | N | prev: 19 (runCount), 32 (formatCost), 54 (clamp) |
| Total coder cost | $X.XX | — |
| Forced-completion injected | yes/no | — |
| Rollback occurred | yes/no | — |

## Grounding Results

| Scope | Proposed | Grounded | Dropped | Drop rate |
|-------|----------|----------|---------|-----------|
| Boundary | N | N | N | N% |
| Contract | N | N | N | N% |
| Behavioral | N/skipped | — | — | — |

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
| 1186 passed / 6 skipped | N passed / 6 skipped |

## Protocol Compliance

| Platform | Score |
|----------|-------|
| cursor | 5/5 |
| claude-code | 5/5 |

## Issues Found

<any unexpected failures, retries, lint errors, or pipeline anomalies — be specific>

## Observations vs Previous Runs

<compare against:
- 2026-05-18 runCount(): $0.88, 19 turns, 31/31
- 2026-05-19 formatCost(): $1.63, 32 turns, 31/31
- 2026-05-25 clamp(): 54 turns, scope guard violation (pre-fix)
Note whether scope guard prevented plan drift. Note any changes in grounding rates.>

## Recommended Follow-ups

<any issues that should become ROADMAP items or Cursor prompts>
```

---

## Step 4 — Update CLAUDE.md

Add a self-test entry to the "What Bollard Is" paragraph (after the clamp() self-test entry):

```
Self-test **2026-05-25** (run id `<runId>`, `CostTracker.merge()` — first full forward run with all 13 hardening fixes active) completed **XX/31** nodes successfully. Total cost **$X.XX**; **implement** ~**Xs**, **$X.XX** (coder **N** turns). Boundary grounding **N/N** (drop N), contract **N/N** (drop N). Scope guard: <fired/did not fire>. See [spec/self-test-merge-results.md](../spec/self-test-merge-results.md).
```

---

## Step 5 — Commit

```bash
git add packages/engine/src/cost-tracker.ts
git add packages/engine/tests/cost-tracker.test.ts
git add spec/self-test-merge-results.md
git add CLAUDE.md
git commit -m "feat: CostTracker.merge() — self-test XX/31 nodes, \$X.XX, N coder turns"
git push origin main
```

Do NOT commit `.bollard/self-test-merge.log` — it is gitignored.

---

## What to watch for (flag in the report if any occur)

- **Scope guard fires on a legitimate path** — means the plan's `affected_files` was too narrow; note which path was blocked
- **Scope guard does NOT prevent out-of-scope edits** — means the guard has a gap; note which file was touched and add to ROADMAP
- **Coder turns > 35** — planner over-specified (Phase 10 regression)
- **Cost > baseline ceiling** — cost regression; `cost-baseline diff` will catch this
- **Contract grounding drop > 30%** — structural mismatch between tester context and corpus (the known open issue in ROADMAP)
- **`static-checks` or `run-tests` fail** — note as pipeline artifact; should be `onFailure: skip`
- **`merge()` mutates `this` or `other`** — coder misread the task; note in Issues Found
- **Limit of returned tracker is wrong** — coder used `other._limit` instead of `this._limit`; note in Issues Found

---

## Constraints

- **`BOLLARD_AUTO_APPROVE=1`** — pipeline runs unattended, no human gates
- **Do not manually implement merge()** — let the pipeline do it; your job is to run, observe, and report
- **Do not edit any existing tests** — the scope guard will enforce this at the tool level
- **If the pipeline leaves lint/format errors**, apply `biome format --write .` and note it in the report
- **Log file stays in `.bollard/`** — gitignored; only commit source changes and the results doc
