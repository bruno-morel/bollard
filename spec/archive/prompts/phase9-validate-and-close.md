# Cursor Prompt — Phase 9: Commit, Validate, and Close

> **Context:** Phase 9 (runtime turn enforcement + per-attempt cost cap) has been implemented by Cursor but not yet committed. The working tree has 6 modified files and 1 untracked spec prompt. Once committed, run the canonical validation task through the full Bollard pipeline, pull ground-truth billing from the Anthropic Admin API, and produce the final Phase 7+8+9 close-out report.
>
> **Do not implement any new features.** Commit → validate → report.

---

## Step 1 — Pre-flight: verify Phase 9 is correctly wired

Run these checks. If any expected value is missing or wrong, stop and report before doing anything else.

```bash
# 9a: hard-exit injection flags exist
grep -n "hasEmittedCompletion\|hasInjectedHardExit\|hardExitTurn" packages/agents/src/executor.ts

# 9b: per-attempt cap in ExecutorOptions
grep -n "maxCostUsd" packages/agents/src/types.ts

# 9b: per-attempt cap check in executor (should appear after aggregate cap check)
grep -n "Per-attempt cost limit\|options?.maxCostUsd" packages/agents/src/executor.ts

# 9c: coder wired to half the aggregate cap
grep -n "maxCostUsd" packages/cli/src/agent-handler.ts

# 9d: aggregate cap raised
grep "max_cost_usd" .bollard.yml
```

Expected:
- `hardExitTurn`, `hasEmittedCompletion`, `hasInjectedHardExit` all present in executor.ts
- `maxCostUsd?: number` in types.ts ExecutorOptions
- `Per-attempt cost limit` error message in executor.ts
- `maxCostUsd: config.agent.max_cost_usd / 2` in agent-handler.ts
- `max_cost_usd: 10` in .bollard.yml

---

## Step 2 — Commit Phase 9

```bash
git add \
  .bollard.yml \
  CLAUDE.md \
  packages/agents/src/executor.ts \
  packages/agents/src/types.ts \
  packages/agents/tests/executor.test.ts \
  packages/cli/src/agent-handler.ts \
  spec/prompts/phase9-runtime-turn-enforcement.md \
  spec/prompts/phase9-validate-and-close.md

git commit -m "Stage 5d Phase 9: runtime turn enforcement + per-attempt cost cap"
```

Then confirm: `git log --oneline -3`

---

## Step 3 — Run the validation pipeline

Source `.env` so both `ANTHROPIC_API_KEY` and `ANTHROPIC_ADMIN_KEY` are available, then run:

```bash
set -a && source .env && set +a

./scripts/bollard-metrics-run.sh "Add a snapshotTotal(): number method to CostTracker that returns the same value as total() at the moment of the call, without modifying any state. No parameters. Do not modify any existing methods or tests."
```

**Record from the output:**
- Wall-clock start time (printed by the script at the top, UTC)
- Wall-clock end time (printed at completion)
- Whether attempt 1 completed cleanly or hit the hard-exit injection or the per-attempt cap
- Total coder turns across all attempts
- Any rollback, COST_LIMIT_EXCEEDED, or unexpected failures
- The run ID (looks like `20260515-HHMM-run-XXXXXX`)

While it runs, note the `BOLLARD_METRICS` lines — they are the per-turn token/cost trace.

---

## Step 4 — Parse the BOLLARD_METRICS lines

```bash
grep "^BOLLARD_METRICS" .bollard/last-metrics-run.log
```

From this output, extract:
- Total coder turns (count of `role=coder` lines)
- Input tokens per turn (for the context growth profile)
- Final `cumulative_cost_usd` on the last coder line (= total coder cost)
- Whether `stop=end_turn` appears before turn 52 on attempt 1 (= hard-exit not needed)
- Whether any line contains a turn where stop reason is not `tool_use` or `end_turn` (= unexpected)

Also check pipeline completion:

```bash
docker compose run --rm dev sh -c \
  "pnpm --filter @bollard/cli run start -- history 2>/dev/null | head -3"
```

---

## Step 5 — Fetch ground-truth billing from the Anthropic Admin API

Use the start/end times from Step 3. Add 1 minute of padding on each side.

```bash
# Fill these in from Step 3 output
START_TS="REPLACE_WITH_ACTUAL"   # e.g. 2026-05-15T05:29:00Z
END_TS="REPLACE_WITH_ACTUAL"     # e.g. 2026-05-15T05:45:00Z

curl -s "https://api.anthropic.com/v1/organizations/usage_report/messages" \
  -H "x-api-key: $ANTHROPIC_ADMIN_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -G \
  --data-urlencode "starting_at=$START_TS" \
  --data-urlencode "ending_at=$END_TS" \
  --data-urlencode "bucket_width=1m" \
  --data-urlencode "group_by=model" \
  | tee /tmp/phase9-usage.json

curl -s "https://api.anthropic.com/v1/organizations/cost_report" \
  -H "x-api-key: $ANTHROPIC_ADMIN_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -G \
  --data-urlencode "starting_at=$START_TS" \
  --data-urlencode "ending_at=$END_TS" \
  | tee /tmp/phase9-cost.json

python3 << 'EOF'
import json

with open("/tmp/phase9-usage.json") as f:
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
print("=== TOKEN USAGE BY MODEL ===")
if not by_model:
    print("  No data — check ANTHROPIC_ADMIN_KEY or widen time window by 5 minutes")
for model, c in sorted(by_model.items()):
    tier = "sonnet" if "sonnet" in model else "haiku" if "haiku" in model else None
    inp_rate, out_rate = RATES.get(tier, (3.00, 15.00))
    cost = (c["input"] * inp_rate + c["output"] * out_rate) / 1_000_000
    total_est += cost
    avg = c["input"] // c["requests"] if c["requests"] else 0
    pct = c["input"] / max(1, c["input"] + c["output"]) * 100
    print(f"\n  {model}")
    print(f"    requests:     {c['requests']}")
    print(f"    input tokens: {c['input']:,}  (avg {avg:,}/req, {pct:.1f}% of tokens)")
    print(f"    output tokens:{c['output']:,}")
    print(f"    est. cost:    ${cost:.4f}")
print(f"\n  TOTAL estimated (from tokens): ${total_est:.4f}")

print()
with open("/tmp/phase9-cost.json") as f:
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
    print("  No entries yet — cost report lags 12-24h; use token-derived estimate above")
    print("  Raw:", json.dumps(cost_data)[:400])
EOF
```

If `ANTHROPIC_ADMIN_KEY` is not in scope, run `set -a && source .env && set +a` first and retry.

---

## Step 6 — Compile the full report

Report ALL of the following with exact numbers. No rounding.

### Comparison table

| Metric | 2026-05-13 baseline | 2026-05-15 Phase 8 run | This run (Phase 9) | Change vs baseline |
|---|---|---|---|---|
| Total cost (Admin API / estimate) | $5.56 | $5.00 | $__ | __% |
| Coder turns (all attempts) | 87 | 89 | __ | __ |
| Coder turns — attempt 1 | 60 (failed) | 60 (failed) | __ | __ |
| Rollback count | 2 | 1 | __ | __ |
| COST_LIMIT_EXCEEDED triggered | Yes | Yes | __ | __ |
| Total Sonnet input tokens | 1,740,720 | 1,579,564 | __ | __% |
| Avg input tokens / coder request | ~20,000 | 17,748 | __ | __% |
| Peak input tokens (single request) | 33,710 | 29,247 | __ | __ |
| Pipeline status | failure | failure | __ | __ |
| Nodes completed | 5 of 31 | 13 of 31 | __ of 31 | __ |

### Per-turn context profile — attempt 1

```
Turn  1: __ input /  __ output  · cum=$__
Turn 10: __ input /  __ output  · cum=$__
Turn 20: __ input /  __ output  · cum=$__
Turn 30: __ input /  __ output  · cum=$__   (if reached)
Turn 52: __ input /  __ output  · cum=$__   (hard-exit turn — did injection fire here?)
Turn  N: __ input /  __ output  · cum=$__   (last turn of attempt 1)
```

### Phase 9 mechanism assessment

Answer each with evidence from the log:

1. **Hard-exit injection (9a):** Did `SYSTEM: You have` appear in the coder's context? Check the log for any stderr line mentioning the injection, or infer from whether attempt 1 completed before turn 60.
2. **Per-attempt cap (9b):** Did the per-attempt cap fire (`Per-attempt cost limit` in stderr)? If yes, at what turn and what cost?
3. **Aggregate cap (9d):** Did `COST_LIMIT_EXCEEDED` appear for the aggregate cap? If yes, which node triggered it?
4. **Was `snapshotTotal()` implemented correctly?**
   ```bash
   git show HEAD:packages/engine/src/cost-tracker.ts | grep -A3 "snapshotTotal"
   # (on the run branch, not main)
   RUN_ID="REPLACE_WITH_ACTUAL"
   git show "bollard/$RUN_ID:packages/engine/src/cost-tracker.ts" | grep -A3 "snapshotTotal"
   ```
5. **Tests still green:**
   ```bash
   docker compose run --rm dev run test
   ```
   Paste the final count line.

---

## Step 7 — Verdict and close

**VALIDATED** — ALL four conditions met: cost < $3.00 AND coder turns < 40 (combined) AND no rollback AND 31/31 nodes:

1. Report: **"VALIDATED — Phase 7 + Phase 8 + Phase 9 working as designed."**

2. Merge the run branch:
   ```bash
   RUN_ID="REPLACE_WITH_ACTUAL"
   git checkout main
   git merge --no-ff "bollard/$RUN_ID" -m "chore: Phase 7+8+9 validation (snapshotTotal) — VALIDATED"
   ```

3. Update CLAUDE.md — find the Phase 9 DONE entry and append:
   ```
   Bollard-on-Bollard validation 2026-05-15 (snapshotTotal(): number, run id <RUN_ID>) completed 31/31 nodes. Total cost $X.XX. Coder turns: N/60 (single attempt). Avg input tokens/coder turn: Xk. Peak: Xk. Pre-Phase-7/8/9 baseline was $5.56 / 87 turns / 33K peak.
   ```

4. Commit:
   ```bash
   git add CLAUDE.md
   git commit -m "docs: record Phase 7+8+9 VALIDATED metrics"
   ```

5. Update test count in CLAUDE.md if the merge added tests from the run branch:
   ```bash
   docker compose run --rm dev run test 2>&1 | grep "Tests "
   ```

**NOT VALIDATED** — any condition failed:

- Report which condition(s) failed and the exact numbers
- Do NOT merge the run branch
- Leave the branch on disk
- Identify which mechanism failed: was it the hard-exit injection being ignored again (→ Phase 10 needed: lower `maxTurns` to 52 so the loop itself becomes the floor)? Or the per-attempt cap still too high (→ lower to `max_cost_usd / 3`)? Or context growth resuming (→ Phase 8 caps need tightening)?

---

## Constraints

- Do not implement `snapshotTotal()` yourself. The Bollard coder agent does it.
- Do not delete or reset the run's git branch regardless of outcome.
- Do not modify the task string — the wording is intentional.
- If `ANTHROPIC_ADMIN_KEY` returns no cost data (12–24h lag is normal), use the token-derived estimate from the usage endpoint and note that the cost report will confirm later.
- Report raw numbers first. Never round or estimate when exact values are available.
- The test count in CLAUDE.md must reflect the post-merge state, not the pre-merge state.
