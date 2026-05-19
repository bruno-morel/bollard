# Cursor Prompt — Phase 10: Validate and Close

> **Context:** Phase 10 added two constraints to `packages/agents/prompts/planner.md`: (a) cap `acceptance_criteria` at 3–5 entries, no state-permutation enumeration; (b) keep `steps[].tests` concise — name properties, not permutations. The previous Phase 9 run hit 47 coder turns because the planner produced 9 acceptance criteria for a 3-line method. Phase 10 should bring turns under 40 on bounded single-method tasks.
>
> **Do not implement any new features.** Run → validate → report.

---

## Step 1 — Verify Phase 10 is correctly wired

```bash
# Confirm both constraints are present in planner.md
grep -n "3–5 criteria\|state-permutation\|Mutation coverage\|properties to verify" packages/agents/prompts/planner.md
```

Expected: at least 3 matches — the count cap in Rule 2, the negative example, and the `tests` conciseness note in Rule 9.

---

## Step 2 — Run the validation pipeline

```bash
set -a && source .env && set +a

./scripts/bollard-metrics-run.sh "Add a snapshotTotal(): number method to CostTracker that returns the same value as total() at the moment of the call, without modifying any state. No parameters. Do not modify any existing methods or tests."
```

**Record from the output:**
- Wall-clock start and end times (UTC)
- Run ID (format: `20260515-HHMM-run-XXXXXX`)
- Number of coder turns (count of `BOLLARD_METRICS role=coder` lines)
- Whether attempt 1 completed with `stop=end_turn` or hit a limit
- Any rollback, COST_LIMIT_EXCEEDED, or unexpected failures
- Total pipeline cost from Bollard CostTracker
- Nodes completed

---

## Step 3 — Parse the BOLLARD_METRICS lines

```bash
grep "^BOLLARD_METRICS" .bollard/last-metrics-run.log
```

Extract:
- Total coder turns
- Input tokens at turns 1, 5, 10, 20, and the final turn
- Cumulative cost at the final coder turn
- Whether `stop=end_turn` appeared before turn 40
- Whether any Phase 9 mechanism fired: look for `SYSTEM: You have` in the log (hard-exit injection), `Per-attempt cost limit` (per-attempt cap), or `COST_LIMIT_EXCEEDED` (aggregate cap)

Also check the planner output to see how many acceptance criteria it produced:

```bash
grep -A 20 '"acceptance_criteria"' .bollard/last-metrics-run.log | head -25
```

---

## Step 4 — Fetch ground-truth billing from the Anthropic Admin API

Use the start/end times from Step 2. Add 1 minute of padding on each side.

```bash
START_TS="REPLACE_WITH_ACTUAL"   # e.g. 2026-05-15T06:00:00Z
END_TS="REPLACE_WITH_ACTUAL"     # e.g. 2026-05-15T06:15:00Z

curl -s "https://api.anthropic.com/v1/organizations/usage_report/messages" \
  -H "x-api-key: $ANTHROPIC_ADMIN_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -G \
  --data-urlencode "starting_at=$START_TS" \
  --data-urlencode "ending_at=$END_TS" \
  --data-urlencode "bucket_width=1m" \
  --data-urlencode "group_by=model" \
  | tee /tmp/phase10-usage.json

curl -s "https://api.anthropic.com/v1/organizations/cost_report" \
  -H "x-api-key: $ANTHROPIC_ADMIN_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -G \
  --data-urlencode "starting_at=$START_TS" \
  --data-urlencode "ending_at=$END_TS" \
  | tee /tmp/phase10-cost.json

python3 << 'EOF'
import json

with open("/tmp/phase10-usage.json") as f:
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
with open("/tmp/phase10-cost.json") as f:
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

---

## Step 5 — Compile the full report

Report ALL of the following with exact numbers.

### Planner output assessment

How many acceptance criteria did the planner produce? (target: 3–5)
Paste them verbatim.

How many lines was the `steps[0].tests` description? (target: 1–2 sentences)

### Comparison table

| Metric | 2026-05-13 baseline | Phase 9 run (2026-05-15) | This run (Phase 10) | Change vs Phase 9 |
|---|---|---|---|---|
| Total cost (Admin API / estimate) | $5.56 | $2.5592 | $__ | __% |
| Coder turns (all attempts) | 87 | 47 | __ | __ |
| Coder turns — attempt 1 | 60 (failed) | 47 (succeeded) | __ | __ |
| Rollback count | 2 | 0 | __ | __ |
| COST_LIMIT_EXCEEDED triggered | Yes | No | __ | __ |
| Total Sonnet input tokens | 1,740,720 | 780,044 | __ | __% |
| Avg input tokens / coder request | ~20,000 | 16,596 | __ | __% |
| Peak input tokens (single request) | 33,710 | 23,016 | __ | __ |
| Pipeline status | failure | success | __ | __ |
| Nodes completed | 5 of 31 | 31 of 31 | __ of 31 | __ |
| Acceptance criteria count | n/a | 9 | __ | __ |

### Per-turn context profile — attempt 1

```
Turn  1: __ input / __ output · cum=$__
Turn  5: __ input / __ output · cum=$__
Turn 10: __ input / __ output · cum=$__
Turn 20: __ input / __ output · cum=$__  (if reached)
Turn  N: __ input / __ output · cum=$__  (last turn)
```

### Phase 9 mechanism status (should all be inactive)

- Hard-exit injection (9a): fired? (look for `SYSTEM: You have` in log)
- Per-attempt cap (9b/c): fired? (look for `Per-attempt cost limit`)
- Aggregate cap (9d): fired? (look for `COST_LIMIT_EXCEEDED`)

---

## Step 6 — Verdict and close

**VALIDATED** — ALL four conditions met: cost < $3.00 AND coder turns < 40 AND no rollback AND 31/31 nodes:

1. Report: **"VALIDATED — Phase 7 + Phase 8 + Phase 9 + Phase 10 working as designed."**

2. Merge the run branch:
   ```bash
   RUN_ID="REPLACE_WITH_ACTUAL"
   git checkout main
   git merge --no-ff "bollard/$RUN_ID" -m "chore: Phase 10 validation (snapshotTotal) — VALIDATED"
   ```

3. Update CLAUDE.md — find the Phase 10 DONE entry and append:
   ```
   Bollard-on-Bollard validation 2026-05-15 (snapshotTotal(): number, run id <RUN_ID>) completed 31/31 nodes. Total cost $X.XX. Coder turns: N (single attempt). Avg input tokens/coder turn: Xk. Peak: Xk. Planner produced N acceptance criteria (target 3–5). Pre-Phase-7/8/9/10 baseline was $5.56 / 87 turns / 33K peak / 9 criteria.
   ```

4. Update test count in CLAUDE.md if the merge added tests:
   ```bash
   docker compose run --rm dev run test 2>&1 | grep "Tests "
   ```

5. Commit:
   ```bash
   git add CLAUDE.md
   git commit -m "docs: record Phase 10 VALIDATED metrics"
   git push origin main
   ```

**NOT VALIDATED** — any condition failed:

- Report which condition(s) failed with exact numbers
- Do NOT merge the run branch
- If turns still ≥ 40: paste the full `acceptance_criteria` array from the log — check whether the planner respected the 3–5 cap. If it still produced 7+ criteria, the prompt constraint may need stronger negative examples or a numeric hard cap in the JSON schema.
- If cost > $3.00: check whether attempt 1 completed naturally or hit a Phase 9 mechanism.

---

## Constraints

- Do not implement `snapshotTotal()` yourself — the Bollard coder agent does it (on a fresh branch from main where it already exists, the coder may find it and skip — that's fine, the turn count is the signal).
- Do not modify the task string.
- Do not delete the run branch regardless of outcome.
- If `ANTHROPIC_ADMIN_KEY` returns no cost data, use the token-derived estimate and note the lag.
- Report raw numbers first. Never round when exact values are available.
