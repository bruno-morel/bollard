# Cursor Prompt — Stage 5a Full-Pipeline Validation Run: `runCount()` Method

> **Context:** Stage 5a Phases 1–5 are complete and committed to `main`. All token-economy phases (5d P2–P10) are live. The last real pipeline run was `75c385` ($2.56, baseline). The last attempt (`7c9604`) was degenerate — `snapshotTotal()` already existed on `main` so the coder had nothing to do, and `write-tests` failed with "No affected files." This prompt triggers a fresh, non-degenerate validation run on a method that is **confirmed absent** from `CostTracker`, collects the BOLLARD_METRICS telemetry, and produces a structured validation report that becomes the Stage 5a baseline record.
>
> **Read CLAUDE.md fully before doing anything.** This prompt is a validation run + analysis task — no new features.

---

## Task

### Step 1 — Confirm the target method is absent

Before running anything, verify that `runCount(): number` does **not** exist in `packages/engine/src/cost-tracker.ts`:

```bash
grep -n "runCount" packages/engine/src/cost-tracker.ts
```

Expected: no output. If it exists, stop and tell me — I'll pick a different method.

---

### Step 2 — Run the full pipeline

```bash
./scripts/bollard-metrics-run.sh \
  "Add a runCount(): number method to CostTracker that returns the number of times add() has been called since construction or the last reset(). You must add a private counter field and increment it inside add() and clear it inside reset() — those internal modifications are required and expected. Do not change the public signatures or observable behavior of any existing method, and do not modify existing test files."
```

This writes the full combined output (stdout + stderr) to `.bollard/last-metrics-run.log` and appends a `RunRecord` to `.bollard/runs/history.jsonl`.

Wait for it to complete. It takes 5–15 minutes and costs roughly $2–4. Do NOT interrupt it.

---

### Step 3 — Extract BOLLARD_METRICS telemetry

After the run completes, parse the log:

```bash
grep "^BOLLARD_METRICS" .bollard/last-metrics-run.log
```

For each agent (`planner`, `coder`, `boundary-tester`, `contract-tester`, `semantic-reviewer`), extract:
- Number of turns used / max turns
- Total input tokens (sum across all turns for that agent)
- Total output tokens (sum across all turns for that agent)
- Final `cumulative_cost_usd` for that agent (the last BOLLARD_METRICS line per role)
- Whether `stop=end_turn` was reached (vs. max turns exceeded or hard-exit injection)

Check for this pattern in the coder turns — it indicates the Phase 9 forced-completion injection fired:
```
[FORCED COMPLETION — turn X of 60]
```
or look for a `user` message injected between turns 52–54 in the log output.

---

### Step 4 — Extract pipeline node results

```bash
tail -1 .bollard/runs/history.jsonl | python3 -c "
import sys, json
r = json.loads(sys.stdin.read())
print('runId:', r.get('runId'))
print('status:', r.get('status'))
print('cost:', r.get('totalCostUsd'))
print('duration:', round(r.get('totalDurationMs', 0) / 1000), 'seconds')
print()
print('=== nodes ===')
for n in r.get('nodes', []):
    status = n.get('status', '?')
    marker = '✓' if status == 'ok' else '✗' if status == 'fail' else '⊘'
    cost = n.get('costUsd', 0) or 0
    cost_str = f'  \${cost:.4f}' if cost else ''
    print(f'  {marker} {n[\"nodeId\"]}{cost_str}')
print()
print('=== scopes ===')
for s in r.get('scopes', []):
    print(json.dumps(s, indent=2))
"
```

---

### Step 5 — Check planner acceptance criteria count (Phase 10 validation)

Find the plan JSON in the log output:

```bash
grep -A 40 '"acceptance_criteria"' .bollard/last-metrics-run.log | head -50
```

Count the acceptance criteria. Phase 10 goal: ≤ 5 entries, no per-mutation-interaction enumeration (e.g., NOT "returns correct value after add(), after subtract(), after reset()..." — those are implementation details, not criteria).

---

### Step 6 — Check cost regression

```bash
docker compose run --rm dev sh -c \
  'pnpm --filter @bollard/cli run start -- cost-baseline diff'
```

Expected: `pass` (current average ≤ $2.94, which is $2.56 baseline × 1.15 threshold). If `fail`, the run cost significantly more than the Phase 9 baseline — report the exact numbers.

---

### Step 7 — Run the full test suite to confirm no regressions

```bash
docker compose run --rm dev run test 2>&1 | tail -5
```

Expected: `1076 passed, 6 skipped` (or higher if runCount() tests were generated and committed). Zero failures.

---

### Step 8 — Compile and report the validation table

Produce a structured report in this exact format:

```
## Stage 5a Full-Pipeline Validation — runCount() method
Run: <runId>
Date: <YYYY-MM-DD>
Status: <SUCCESS | FAILURE>
Total cost: $<X.XX>
Total duration: <N>s
Baseline: $2.56 (run 75c385, Phase 9 baseline)
Regression check: <pass | fail | insufficient_data>

### Token Economy (Phase 7–10 mechanisms)
| Agent             | Turns | Max | Input tok | Output tok | Cost    | Exit mode        |
|-------------------|-------|-----|-----------|------------|---------|------------------|
| planner           |       | 25  |           |            | $       |                  |
| coder             |       | 60  |           |            | $       |                  |
| boundary-tester   |       | 5   |           |            | $       |                  |
| contract-tester   |       | 10  |           |            | $       |                  |
| semantic-reviewer |       | 10  |           |            | $       |                  |

Phase 7 (scope guard / hard exit signal):   FIRED / not fired  (coder turn count < 40 ✓ / > 40 ✗)
Phase 8 (context caps):                     read_file ≤ 200 lines: YES/NO; run_command ≤ 100 lines: YES/NO
Phase 9 (forced completion injection):      FIRED at turn N / not triggered
Phase 10 (planner plan compression):        N acceptance criteria (≤5 ✓ / >5 ✗); per-mutation enumeration: YES/NO

### Adversarial Scope Results
| Scope    | Enabled | Claims proposed | Claims grounded | Drop rate | Tests passed | Tests failed |
|----------|---------|-----------------|-----------------|-----------|--------------|--------------|
| boundary |         |                 |                 |           |              |              |
| contract |         |                 |                 |           |              |              |
| behavioral|        | N/A             | N/A             | N/A       |              |              |

### Node Status (31 nodes)
List only non-ok nodes (if any) with their error messages.
If all 31 passed: "All 31 nodes: ✓"

### Test Suite
Before run: 1076 passed / 6 skipped
After run:  <N> passed / <N> skipped
Delta:      +<N> (runCount() tests added by pipeline)

### Key observations
<3–5 bullet points on what was most notable about this run:
- coder behavior (did it find the method trivial? did it over-scaffold tests?)
- any scope surprises (grounding rates, dropped claims)  
- token efficiency vs baseline
- anything that worked better or worse than expected>
```

---

### Step 9 — CLAUDE.md update

After the run completes successfully (status = SUCCESS, all 31 nodes ok or expected-skips), update `CLAUDE.md`:

Find the paragraph that starts:
```
Bollard-on-Bollard self-test **2026-05-11** (run id `20260511-0314-run-fef3d9`...
```

After the last self-test entry (currently the 2026-05-13 entry ending with `...restored **1000 passed / 6 skipped`.`), add a new self-test line:

```
Self-test **<DATE>** (run id `<runId>`, Stage 5a validation — `runCount()` method) completed **<N>/31** nodes successfully. Total cost **$<X.XX>** (~**<DELTA>%** vs $2.56 baseline); **implement** ~**<N>s**, **$<N>** (coder **<N>** turns). Boundary grounding **<N>/<N>**, contract **<N>/<N>** (drop 0).
```

Fill in all values from the run. If any non-skippable node failed, note it. If the run failed entirely, do NOT add the CLAUDE.md line — just report the failure.

---

## Constraints

- Do NOT add `runCount()` to `CostTracker` yourself. The pipeline coder agent must implement it.
- Do NOT approve the plan gate or the PR gate interactively — `BOLLARD_AUTO_APPROVE=1` is set by `bollard-metrics-run.sh` when `--auto-approve` is passed, but the default script does NOT pass it. Check whether the script needs `BOLLARD_AUTO_APPROVE=1` exported before running — if the pipeline pauses at a human gate, export it and re-run.

  Verify: `grep "BOLLARD_AUTO_APPROVE\|auto.approve" scripts/bollard-metrics-run.sh | head -5`

  If `BOLLARD_AUTO_APPROVE` is already read by the script and defaults to 1 for non-interactive use, no action needed. Otherwise: `BOLLARD_AUTO_APPROVE=1 ./scripts/bollard-metrics-run.sh "..."`.

- Do NOT commit the pipeline-generated test files unless they are clean (typecheck + lint pass). The pipeline auto-formats with biome, so they should be clean — but if `pnpm run typecheck` or `pnpm run lint` fails after the run, fix it before committing.
- Do NOT run `pnpm run test` inside Docker manually — the pipeline already ran tests at nodes 9, 15, 20. Just grab the final count from the log.
- The `cost-baseline diff` in Step 6 needs ≥ 3 runs since the baseline timestamp. If it returns `insufficient_data`, that is expected (only 1 new run) — report it as such and note it's not a regression.

---

## What "maximum learning" means

The primary goal of this run is not just to validate that Bollard works — it's to produce concrete numbers that answer:

1. **Are the Phase 7–10 token-economy mechanisms actually reducing cost?** The $2.56 baseline was the first fully-instrumented run. Does `runCount()` (a similarly simple 3–5 line addition) come in under $2.56, at $2.56, or over?

2. **Is the coder staying under 40 turns?** Phase 7 set this as the success metric for bounded single-method tasks. The 75c385 run used 47 turns before Phase 10's planner compression. Did Phase 10 actually move the needle?

3. **Is boundary grounding producing non-empty results?** The last three successful runs show `testsPassed: 0` for boundary scope — the tests ran but 0 passed. This needs investigation: are the boundary tests being written correctly? Is the test file empty? Is vitest skipping them?

4. **Is behavioral scope ever going to be enabled?** `.bollard.yml` has `behavioral.enabled: false`. This is intentional (CostTracker has no HTTP endpoints to probe). Note this in the report.

5. **What does a Phase 5a "healthy run" look like?** The report becomes the reference validation artifact — equivalent to `spec/stage4b-validation-results.md` for Stage 4b.

---

## If the run fails

If the pipeline exits non-zero or any non-skip-designated node fails:

1. Extract the failure node and error message from the log and from `.bollard/runs/history.jsonl`
2. Check whether the failure is pre-existing infrastructure (e.g., docker-verify degradation, mutation testing not configured) vs. a real regression
3. Report which Stage 5a Phase is implicated (if any)
4. Do NOT fix the failure in this prompt — document it and I'll open a follow-up
