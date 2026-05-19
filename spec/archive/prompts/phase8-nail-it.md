# Cursor Prompt — Phase 8 Final: Commit, Fix, Validate, Close

> **Context:** Phase 7 (coder turn reduction) and Phase 8 (context window management) are fully implemented and showing strong results — $1.81 vs $5.56 baseline (−68%), 39 coder turns vs 87 (−55%), zero rollbacks. The last validation run failed at `write-tests` due to a false positive in the information-leak scanner: a private field name (`_total`) appeared inside a test description *string literal*, not in actual code, and the scanner matched it. The fix has already been written in this working tree (not yet committed). This prompt covers everything needed to close out Phase 8 cleanly.
>
> **Do not implement new features.** This is a commit + fix + validate sequence.

---

## Step 1 — Verify the working tree state

```bash
git status --short
```

You should see these modified/untracked files:

**Modified (Phase 7+8 infrastructure, ready to commit):**
- `packages/cli/src/spinner.ts` — `BOLLARD_METRICS` line emission
- `packages/cli/src/agent-handler.ts` — `--metrics` flag wiring
- `packages/cli/src/index.ts` — `isCliMetricsEnabled()` helper
- `packages/cli/tests/spinner.test.ts` — tests for metrics flag
- `packages/agents/tests/tools.test.ts` — loosened truncation assertion (`toMatch` regex)
- `.gitignore` — adds `.bollard/.metrics-run-task.txt`
- `package.json` + `pnpm-lock.yaml` — security override bumps
- `packages/engine/src/cost-tracker.ts` — `peek(): number` method (added by earlier pipeline run)
- `packages/engine/tests/cost-tracker.test.ts` — tests for `peek()`

**Modified (leak-scanner false-positive fix, ready to commit):**
- `packages/blueprints/src/write-tests-helpers.ts` — `stripStringLiteralsAndComments()` exported
- `packages/blueprints/src/implement-feature.ts` — leak scan now uses stripped source at all 3 sites
- `packages/blueprints/tests/write-tests-helpers.test.ts` — 7 new tests for the fix

**Untracked (need to be committed):**
- `scripts/bollard-metrics-run.sh` — harness script for validation runs
- `spec/prompts/phase8-validation-selftest.md` — validation runbook

**Untracked (delete this):**
- `test-peek.ts` — throwaway scratch file from a failed run

If the working tree does not match this picture, stop and report what differs before doing anything else.

---

## Step 2 — Verify the fix compiles and tests pass

```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run test
```

Expected:
- Typecheck: clean (no errors)
- Tests: `1025 passed | 6 skipped` or higher (the leak-scanner fix adds 7 new tests in `write-tests-helpers.test.ts`)

If typecheck fails, read the error carefully — the most likely cause is a missing import or a type mismatch in `implement-feature.ts` or `write-tests-helpers.ts`. Fix before proceeding.

If tests fail, check whether the failing test is in `write-tests-helpers.test.ts` (new tests for the fix) or elsewhere. Fix before proceeding.

---

## Step 3 — Commit in three logical groups

```bash
# Delete the scratch file first
rm -f test-peek.ts

# Commit 1: Phase 7+8 metrics harness
git add \
  packages/cli/src/spinner.ts \
  packages/cli/src/agent-handler.ts \
  packages/cli/src/index.ts \
  packages/cli/tests/spinner.test.ts \
  packages/agents/tests/tools.test.ts \
  .gitignore \
  package.json \
  pnpm-lock.yaml \
  scripts/bollard-metrics-run.sh \
  spec/prompts/phase8-validation-selftest.md

git commit -m "Stage 5d: Phase 7+8 metrics harness — BOLLARD_METRICS lines, --metrics flag, bollard-metrics-run.sh, validation runbook"

# Commit 2: peek() method (implemented by a prior pipeline run, keeping it)
git add \
  packages/engine/src/cost-tracker.ts \
  packages/engine/tests/cost-tracker.test.ts

git commit -m "Stage 5d: add peek(): number to CostTracker (read-only alias for total())"

# Commit 3: leak-scanner false-positive fix
git add \
  packages/blueprints/src/write-tests-helpers.ts \
  packages/blueprints/src/implement-feature.ts \
  packages/blueprints/tests/write-tests-helpers.test.ts

git commit -m "fix: leak scanner strips string literals and comments before private-identifier check"
```

After all three commits: `git log --oneline -5` to confirm they landed cleanly.

---

## Step 4 — Run the Phase 8 validation

```bash
set -a && source .env && set +a

./scripts/bollard-metrics-run.sh "Add a snapshotTotal(): number method to CostTracker that returns the same value as total() at the moment of the call, without modifying any state. No parameters. Do not modify any existing methods or tests."
```

Record the wall-clock start and end times printed by the script. The run should take 3–6 minutes.

Watch for:
- `BOLLARD_METRICS role=coder` lines — count them (= coder turns)
- Any `rollback` or `COST_LIMIT_EXCEEDED` in the output
- The `implement` node completing with `ok`
- `write-tests` node — must complete with `ok` (if it fails with `Information leak`, the fix in Step 2 did not take effect — stop and investigate)
- Pipeline running all 31 nodes

---

## Step 5 — Fetch ground-truth billing from the Anthropic Admin API

Set the timestamps from the Step 4 output (add 1 minute of padding on each side):

```bash
START_TS="REPLACE_WITH_ACTUAL"   # e.g. 2026-05-15T04:29:00Z
END_TS="REPLACE_WITH_ACTUAL"     # e.g. 2026-05-15T04:55:00Z

curl -s "https://api.anthropic.com/v1/organizations/usage_report/messages" \
  -H "x-api-key: $ANTHROPIC_ADMIN_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -G \
  --data-urlencode "starting_at=$START_TS" \
  --data-urlencode "ending_at=$END_TS" \
  --data-urlencode "bucket_width=1m" \
  --data-urlencode "group_by=model" \
  | tee /tmp/phase8-final-usage.json

curl -s "https://api.anthropic.com/v1/organizations/cost_report" \
  -H "x-api-key: $ANTHROPIC_ADMIN_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -G \
  --data-urlencode "starting_at=$START_TS" \
  --data-urlencode "ending_at=$END_TS" \
  | tee /tmp/phase8-final-cost.json
```

Parse:

```bash
python3 << 'EOF'
import json

with open("/tmp/phase8-final-usage.json") as f:
    usage = json.load(f)

by_model = {}
for bucket in usage.get("data", []):
    for entry in bucket.get("usage", []):
        m = entry.get("model", "unknown")
        if m not in by_model:
            by_model[m] = {"requests": 0, "input": 0, "output": 0}
        by_model[m]["requests"] += entry.get("request_count", 1)
        by_model[m]["input"]    += entry.get("input_tokens", 0) + entry.get("cache_read_input_tokens", 0)
        by_model[m]["output"]   += entry.get("output_tokens", 0)

RATES = {"sonnet": (3.00, 15.00), "haiku": (0.80, 4.00)}
total_est = 0.0
print("=== TOKEN USAGE ===")
if not by_model:
    print("No data — check ANTHROPIC_ADMIN_KEY or widen time window")
for model, c in by_model.items():
    tier = "sonnet" if "sonnet" in model else "haiku" if "haiku" in model else None
    inp_rate, out_rate = RATES.get(tier, (3.00, 15.00))
    cost = (c["input"] * inp_rate + c["output"] * out_rate) / 1_000_000
    total_est += cost
    avg = c["input"] // c["requests"] if c["requests"] else 0
    print(f"\n  {model}")
    print(f"    requests:     {c['requests']}")
    print(f"    input tokens: {c['input']:,}  (avg {avg:,}/req)")
    print(f"    output tokens:{c['output']:,}")
    print(f"    est. cost:    ${cost:.4f}")
print(f"\n  TOTAL estimated: ${total_est:.4f}")

print()
with open("/tmp/phase8-final-cost.json") as f:
    cost_data = json.load(f)
print("=== BILLED COST (ground truth) ===")
entries = cost_data.get("data", [])
total_billed = 0.0
for entry in (entries if isinstance(entries, list) else [entries]):
    for k, v in entry.items():
        if k in ("token_usage", "web_search", "code_execution") and v:
            dollars = float(v) / 100
            total_billed += dollars
            print(f"  {k}: ${dollars:.4f}")
if total_billed:
    print(f"\n  TOTAL BILLED: ${total_billed:.4f}")
else:
    print("  No entries — check Admin key or widen time window by 5 minutes")
    print("  Raw:", json.dumps(cost_data)[:300])
EOF
```

---

## Step 6 — Report results

Fill in this table with exact numbers:

| Metric | Pre-Phase-8 baseline (2026-05-13) | This run | Change |
|---|---|---|---|
| Total cost (Admin API ground truth) | $5.56 | $__ | __% |
| Coder turns | 87 | __ | __ |
| Rollback count | 2 | __ | __ |
| COST_LIMIT_EXCEEDED triggered | Yes | __ | __ |
| Total Sonnet input tokens | 1,740,720 | __ | __% |
| Avg input tokens per coder request | ~20,000 | __ | __% |
| Peak input tokens (single request) | 33,710 | __ | __ |
| Pipeline status | failure | __ | __ |
| Nodes completed | 5 of 31 | __ of 31 | __ |

Per-turn context profile (from `BOLLARD_METRICS` lines):
```
Turn  1: __ input tokens
Turn  5: __ input tokens
Turn 10: __ input tokens  (if reached)
...
Turn  N: __ input tokens  (final turn)
```

Then confirm:
- `grep "snapshotTotal" packages/engine/src/cost-tracker.ts` — paste the line
- `docker compose run --rm dev run test` — paste the final test count line

---

## Step 7 — Verdict and close

**VALIDATED** = cost < $3.00 AND coder turns < 40 AND no rollback AND 31/31 nodes completed:

1. Report: **"VALIDATED — Phase 7 + Phase 8 working as designed."**

2. Merge the validation branch:
   ```bash
   RUN_ID=$(docker compose run --rm dev sh -c "pnpm --filter @bollard/cli run start -- history 2>/dev/null | head -1" | grep -o '[0-9]\{8\}-[0-9]\{4\}-run-[a-f0-9]*' | head -1)
   git checkout main
   git merge --no-ff "bollard/$RUN_ID" -m "chore: Phase 7+8 validation self-test (snapshotTotal) — VALIDATED"
   ```

3. Update CLAUDE.md — find the `### Stage 5d Phase 8 (DONE)` entry and append on a new line:
   ```
   Bollard-on-Bollard validation 2026-05-15 (snapshotTotal(): number task, run id <RUN_ID>) completed 31/31 nodes. Total cost $X.XX (Admin API). Coder turns: N/60. Avg input tokens/turn: Xk. Peak: Xk. Baseline was $5.56 / 87 turns / 33K peak.
   ```

4. Commit the CLAUDE.md update:
   ```bash
   git add CLAUDE.md
   git commit -m "docs: record Phase 7+8 validated metrics in CLAUDE.md"
   ```

**NOT VALIDATED** (any condition failed):
- Report exact metrics and which condition failed
- Do NOT merge the run branch
- Leave branch on disk for inspection
- If `write-tests` fails with `Information leak` again: paste the exact leaked token and what context it appeared in — the fix may need adjustment

---

## Constraints

- Do not implement `snapshotTotal()` yourself. The Bollard coder agent does it.
- Do not delete the run's git branch regardless of outcome.
- Do not modify the task string passed to `bollard-metrics-run.sh` — the exact wording is intentional (avoids naming private fields).
- If the Admin API returns no data, note the timestamps and say "please check console.anthropic.com/settings/usage for this window" — then continue with Bollard's internal cost tracker as fallback.
- Report raw numbers before interpretation. Never round when exact values are available.
