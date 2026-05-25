# Cursor Prompt — Self-Test: CostTracker.multiply() + Full Instrumented Pipeline Run

> **Context:** This is a Bollard-on-Bollard self-test. You will run the `implement-feature` pipeline on a real task, then analyse the run in detail and produce a structured learnings report. The goal is twofold: (1) validate that all Stage 5a + 5b + housekeeping changes work correctly end-to-end, and (2) extract as much learning as possible from the run — cost, turns, token counts, grounding rates, promotion candidates, any failures.
>
> **Read CLAUDE.md fully before starting.** Then read:
> - `packages/engine/src/cost-tracker.ts` — the class you will be adding a method to
> - `packages/engine/tests/cost-tracker.test.ts` — existing test structure
> - `scripts/bollard-metrics-run.sh` — the instrumented run script
> - `.bollard/cost-baseline.json` — current baseline ($1.633, 20% threshold, $1.96 ceiling)
> - `spec/ROADMAP.md §5a` — what this self-test validates

---

## Step 1 — Run the instrumented pipeline

Use the metrics run script so every agent turn emits `BOLLARD_METRICS` lines with input/output token counts:

```bash
./scripts/bollard-metrics-run.sh \
  "Add a multiply(factor: number): CostTracker method to CostTracker that multiplies the current accumulated total by factor in place and returns this for chaining. factor must be a positive finite number; throw BollardError with code CONTRACT_VIOLATION if factor <= 0 or non-finite. Do not modify any other existing methods or tests." \
  .bollard/self-test-multiply.log
```

This runs `docker compose run --rm dev ... implement-feature --metrics` and tees all output (including `BOLLARD_METRICS` token lines) to `.bollard/self-test-multiply.log`.

**Wait for the run to complete before proceeding to Step 2.**

If the run fails due to a Git lock (stale `.git/HEAD.lock`), clear it with:
```bash
rm -f .git/HEAD.lock .git/index.lock
```
and retry.

---

## Step 2 — Extract structured metrics from the log

After the run completes, parse `.bollard/self-test-multiply.log` and extract:

### 2a. Overall result
- Run ID (look for `Run ID:` line)
- Status (success / failure / handed_to_human)
- Total cost ($)
- Total duration (seconds)
- Node count (e.g. `31/31`)

### 2b. Coder agent metrics
- Number of coder turns (look for `BOLLARD_METRICS` lines with `agent: coder`)
- Total coder input tokens (sum of all coder turn inputTokens)
- Total coder output tokens
- Average input tokens per coder turn
- Did the forced-completion injection fire? (look for `[forced-completion]` or turn 52 signal)
- Did rollback occur? (look for `git reset` or `rollback`)

### 2c. Per-scope grounding results
- Boundary: claims proposed / grounded / dropped
- Contract: claims proposed / grounded / dropped
- Behavioral: claims proposed / grounded / dropped (may be skipped for a pure method addition)

### 2d. Promotion candidates (Signal 1)
- Did the `approve-pr` gate surface any promotion candidates?
- Which test files were flagged?

### 2e. Cost regression check
```bash
docker compose run --rm -e ANTHROPIC_API_KEY dev sh -c \
  'git config --global --add safe.directory /app && \
   pnpm --filter @bollard/cli run start -- cost-baseline diff'
```
Record: pass / fail, current average vs baseline ceiling ($1.96).

### 2f. Test suite after the run
```bash
docker compose run --rm dev run test 2>&1 | tail -5
```
Record: total passed / skipped. Expected: ≥ 1126 passed (the new method + tests add to this).

### 2g. `bollard audit-protocol` smoke check
```bash
docker compose run --rm dev sh -c \
  'git config --global --add safe.directory /app && \
   pnpm --filter @bollard/cli run start -- audit-protocol'
```
Record: cursor 5/5, claude-code 5/5 (should be clean — generators weren't touched).

---

## Step 3 — Produce the learnings report

Write a structured report to `spec/self-test-multiply-results.md` with the following sections. Be precise — use exact numbers from the log, not estimates.

```markdown
# Self-Test: CostTracker.multiply() — Validation Results

**Date:** <today>
**Run ID:** <from log>
**Task:** Add multiply(factor: number): CostTracker to CostTracker

## Overall Result

| Metric | Value |
|--------|-------|
| Status | ✓ success / ✗ failure |
| Total cost | $X.XX |
| Duration | Xs |
| Nodes | XX/31 |
| Coder turns | N |

## Token Economy

| Metric | Value | vs baseline |
|--------|-------|-------------|
| Total coder input tokens | N | — |
| Total coder output tokens | N | — |
| Avg input tokens/turn | N | prev: ~16,596 |
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
| Baseline ceiling | $1.96 |
| This run cost | $X.XX |
| `cost-baseline diff` | pass / fail |

## Test Suite

| Before run | After run |
|------------|-----------|
| 1126 passed / 6 skipped | N passed / 6 skipped |

## Protocol Compliance

| Platform | Score |
|----------|-------|
| cursor | 5/5 |
| claude-code | 5/5 |

## Issues Found

<any unexpected failures, retries, lint errors, or pipeline anomalies — be specific>

## Observations vs Previous Runs

<compare against the two most recent self-tests documented in CLAUDE.md:
- 2026-05-18 runCount(): $0.88, 19 turns, 31/31
- 2026-05-19 formatCost(): $1.63, 32 turns, 31/31
Note any regressions or improvements in cost, turns, grounding rates, token counts.>

## Recommended Follow-ups

<any issues that should become ROADMAP items or Cursor prompts>
```

---

## Step 4 — Update CLAUDE.md

Add a self-test entry to the What Bollard Is paragraph (after the formatCost self-test entry):

```
Self-test **2026-05-XX** (run id `<runId>`, Stage 5a complete validation — `CostTracker.multiply()`) completed **31/31** nodes successfully. Total cost **$X.XX**; **implement** ~**Xs**, **$X.XX** (coder **N** turns). Boundary grounding **N/N** (drop 0), contract **N/N** (drop N).
```

---

## Step 5 — Commit

```bash
git add packages/engine/src/cost-tracker.ts
git add packages/engine/tests/
git add spec/self-test-multiply-results.md
git add CLAUDE.md
git add .bollard/self-test-multiply.log
git commit -m "Stage 5a self-test: add CostTracker.multiply() — pipeline validated, N/31 nodes, \$X.XX"
git push origin main
```

---

## What to watch for (flag in the report if any of these occur)

- **Coder turns > 35** — planner over-specified acceptance criteria (Phase 10 regression)
- **Cost > $1.96** — cost regression vs baseline
- **Any grounding drop rate > 30%** — adversarial test quality regression
- **`bollard audit-protocol` score < 5/5** — protocol compliance regression (would be a significant find)
- **`static-checks` or `run-tests` status: fail** — pipeline node failures (should be `onFailure: skip` but worth noting)
- **Signal 1 candidates NOT surfaced** — Phase 4b fingerprinting regression (the multiply boundary test should appear)
- **Test count doesn't increase** — coder didn't write tests (scope guard failure)

---

## Constraints

- **`BOLLARD_AUTO_APPROVE=1`** — pipeline runs unattended, no human gates
- **Do not manually write the multiply() implementation** — let the pipeline do it
- **Do not edit any existing tests** — the task constraint says so, and the coder prompt enforces it
- **If the pipeline produces a lint/format error** post-run, apply `biome format --write .` and note it in the report as a known pipeline artifact (the Tier 1 patcher should have caught it — if it didn't, that's a finding)
- **Log file stays in `.bollard/`** — it's gitignored via `.bollard/.gitignore`; only commit `spec/self-test-multiply-results.md` and the changed source files
