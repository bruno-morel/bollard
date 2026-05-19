# Cursor Prompt — Phase 7 + Phase 8 Validation Self-Test

> **Purpose:** Run the `snapshotTotal(): number` implementation task through the full Bollard pipeline and measure whether Phase 7 (turn reduction) and Phase 8 (context window management) together bring cost and turn count within target. Ground-truth billing comes from the Anthropic Admin API (`ANTHROPIC_ADMIN_KEY` in `.env`).
>
> **Do not implement any code yourself.** Your only job is to run commands, capture output, and report numbers.

---

## Pre-flight checks

Run these four greps. If any line is missing or has the wrong value, stop immediately and report which constant is wrong.

```bash
grep "maxTurns" packages/agents/src/coder.ts
grep "TURN 52" packages/agents/prompts/coder.md | head -1
grep "MAX_LINES" packages/agents/src/tools/read-file.ts
grep "MAX_OUTPUT_LINES" packages/agents/src/tools/run-command.ts
grep "MAX_TOOL_RESULT_CHARS\|COMPACT_KEEP_RECENT\|COMPACTED_MAX_CHARS" packages/agents/src/executor.ts
```

Expected values:
- `maxTurns: 60`
- `TURN 52` present in coder.md
- `MAX_LINES = 200`
- `MAX_OUTPUT_LINES = 100`
- `MAX_TOOL_RESULT_CHARS = 4_000`
- `COMPACT_KEEP_RECENT = 4`
- `COMPACTED_MAX_CHARS = 800`

Also verify the task method does not already exist:

```bash
grep -r "snapshotTotal" packages/engine/src/
```

Expected: no output. If `snapshotTotal` is found, stop and report — the task is already implemented and the test is invalid.

---

## Run the pipeline

Source `.env` so both keys are available, then run via the existing harness script:

```bash
set -a && source .env && set +a
./scripts/bollard-metrics-run.sh
```

The script will:
- Pass `ANTHROPIC_API_KEY` to Docker
- Run `implement-feature` with the `snapshotTotal(): number` task against the live codebase
- Emit `BOLLARD_METRICS` lines to stderr once per coder turn
- Write the full log to `.bollard/last-metrics-run.log`
- Print a `BOLLARD_METRICS` summary at the end

Record the wall-clock start and end times from the script output — you will need them for the Admin API query.

While it runs, note:
- The coder turn count from `BOLLARD_METRICS` lines
- Whether `rollback` or `COST_LIMIT_EXCEEDED` appears in the output
- Whether the `implement` node completes with `ok` or `fail`

---

## Parse the BOLLARD_METRICS lines

After the run finishes:

```bash
grep "^BOLLARD_METRICS" .bollard/last-metrics-run.log
```

Each line has the form:
```
BOLLARD_METRICS role=coder turn=N max_turns=60 input_tokens=X output_tokens=Y turn_cost_usd=Z cumulative_cost_usd=W stop=... tools=N
```

Extract: total coder turns, input tokens per turn (for the context growth profile), and the final `cumulative_cost_usd`.

Also check the pipeline run ID and status from history:

```bash
docker compose run --rm dev sh -c "pnpm --filter @bollard/cli run start -- history 2>/dev/null | head -3"
```

---

## Fetch ground-truth billing from the Anthropic Admin API

Load `ANTHROPIC_ADMIN_KEY` from `.env` and set the time window from the run output. The window should start 1 minute before the pipeline began and end 1 minute after it finished.

```bash
# Set these from the run output — use ISO 8601 UTC format
START_TS="REPLACE_WITH_ACTUAL"   # e.g. 2026-05-15T03:29:00Z
END_TS="REPLACE_WITH_ACTUAL"     # e.g. 2026-05-15T03:55:00Z

# Token usage breakdown by model
curl -s "https://api.anthropic.com/v1/organizations/usage_report/messages" \
  -H "x-api-key: $ANTHROPIC_ADMIN_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -G \
  --data-urlencode "starting_at=$START_TS" \
  --data-urlencode "ending_at=$END_TS" \
  --data-urlencode "bucket_width=1m" \
  --data-urlencode "group_by=model" \
  | tee /tmp/phase8-usage.json

# Billed cost (ground truth)
curl -s "https://api.anthropic.com/v1/organizations/cost_report" \
  -H "x-api-key: $ANTHROPIC_ADMIN_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -G \
  --data-urlencode "starting_at=$START_TS" \
  --data-urlencode "ending_at=$END_TS" \
  | tee /tmp/phase8-cost.json
```

Parse both:

```bash
python3 << 'EOF'
import json

# Token usage
with open("/tmp/phase8-usage.json") as f:
    usage = json.load(f)

by_model = {}
for bucket in usage.get("data", []):
    for entry in bucket.get("usage", []):
        m = entry.get("model", "unknown")
        if m not in by_model:
            by_model[m] = {"requests": 0, "input": 0, "output": 0, "cache_write": 0}
        by_model[m]["requests"] += entry.get("request_count", 1)
        by_model[m]["input"]    += entry.get("input_tokens", 0) + entry.get("cache_read_input_tokens", 0)
        by_model[m]["output"]   += entry.get("output_tokens", 0)
        by_model[m]["cache_write"] += entry.get("cache_creation_input_tokens", 0)

RATES = {"sonnet": (3.00, 15.00), "haiku": (0.80, 4.00)}
total_est = 0.0
print("=== TOKEN USAGE ===")
if not by_model:
    print("No data — check Admin key or time window")
for model, c in by_model.items():
    tier = "sonnet" if "sonnet" in model else "haiku" if "haiku" in model else None
    inp_rate, out_rate = RATES.get(tier, (3.00, 15.00))
    cost = (c["input"] * inp_rate + c["output"] * out_rate) / 1_000_000
    total_est += cost
    avg = c["input"] // c["requests"] if c["requests"] else 0
    pct = c["input"] / max(1, c["input"] + c["output"]) * 100
    print(f"\n  {model}")
    print(f"    requests:      {c['requests']}")
    print(f"    input tokens:  {c['input']:,}  (avg {avg:,}/req, {pct:.1f}% of total tokens)")
    print(f"    output tokens: {c['output']:,}")
    if c["cache_write"]:
        print(f"    cache writes:  {c['cache_write']:,}")
    print(f"    est. cost:     ${cost:.4f}")
print(f"\n  TOTAL estimated from tokens: ${total_est:.4f}")

# Billed cost
print("\n=== BILLED COST (ground truth) ===")
with open("/tmp/phase8-cost.json") as f:
    cost_data = json.load(f)
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
    print("  No entries — check Admin key permissions or widen time window")
    print("  Raw:", json.dumps(cost_data, indent=2)[:500])
EOF
```

**If the Admin API returns 401/403 or no data:** print the `START_TS` and `END_TS` timestamps and say: "Please check https://console.anthropic.com/settings/usage, filter to this time window, and paste the total tokens and cost." Then continue using whatever cost Bollard's internal tracker reported.

---

## Report the results

Report ALL of the following with exact numbers — no rounding, no estimation:

### Comparison table

| Metric | Pre-Phase-8 baseline (2026-05-13) | This run | Change |
|---|---|---|---|
| Total cost (Admin API ground truth) | $5.56 | $__ | __% |
| Coder turns | 87 (60+27, 2 attempts) | __ | __ |
| Rollback count | 2 | __ | __ |
| COST_LIMIT_EXCEEDED triggered | Yes | __ | __ |
| Total Sonnet input tokens | 1,740,720 | __ | __% |
| Total Sonnet output tokens | 20,618 | __ | __ |
| Avg input tokens per Sonnet request | ~20,000 | __ | __% |
| Peak input tokens (single request) | 33,710 | __ | __ |
| Input token % of total token cost | 94% | __% | __ |
| Pipeline status | failure (COST_LIMIT_EXCEEDED) | __ | __ |
| Nodes completed | 5 of 31 | __ of 31 | __ |

### Per-turn context growth

List the `input_tokens` value from each `BOLLARD_METRICS` coder line in order:

```
Turn  1: __ input tokens
Turn  2: __ input tokens
...
Turn  N: __ input tokens
```

This shows whether Phase 8 flattened the growth curve (expected: relatively flat, ~5–10K/turn) vs the old monotonic climb to 33K.

### Assessment questions

Answer each one with the raw evidence, not just yes/no:

1. **Scope guard (Phase 7a):** Did the coder touch any file outside the `affected_files` list? Run `git diff main..HEAD --name-only` and compare.
2. **Turn budget signal (Phase 7b):** Did TURN 52 fire? Search log for `"TURN 52"` or the completion JSON marker.
3. **read_file cap (Phase 8a):** What was the highest single-turn input token count? Is it below 33,710?
4. **Compaction tightening (Phase 8c):** Did input tokens stay roughly flat after turn 5 rather than climbing? Show the turn profile.
5. **Correct implementation:** Run `grep "snapshotTotal" packages/engine/src/cost-tracker.ts` — paste the result.
6. **Tests still green:** Run `docker compose run --rm dev run test` and report the final count line.

---

## Verdict

**VALIDATED** (cost < $3.00 AND coder turns < 40 AND no rollback AND 31/31 nodes):
- Report: "VALIDATED — Phase 7 + Phase 8 working as designed."
- Merge: `git checkout main && git merge --no-ff bollard/<run-id> -m "chore: merge Phase 7+8 validation self-test (snapshotTotal)"`
- Add to CLAUDE.md under the Stage 5d Phase 8 entry: `"Bollard-on-Bollard self-test 2026-05-14 (run id <X>, snapshotTotal(): number task) completed 31/31 nodes. Total cost $X.XX. Coder turns: N/60. Input tokens avg: Xk/turn."`

**PARTIAL** (cost $3.00–$5.00 AND no rollback):
- Report metrics as-is. Do NOT merge.
- Identify which turns had the highest input token counts and what tool calls immediately preceded them.

**FAILED** (rollback fired OR cost > $5.00 OR COST_LIMIT_EXCEEDED):
- Report full turn-by-turn breakdown.
- Do NOT merge. Leave the branch on disk for inspection.

---

## Hard constraints

- Do not implement `snapshotTotal()` yourself under any circumstances. The Bollard coder agent does it.
- Do not delete or reset the run's git branch regardless of outcome.
- Do not widen the task scope — the prompt is intentionally minimal. If the planner produces a plan with more than 2 affected files, that is a scope guard regression worth reporting.
- Report raw numbers before interpretation. If the Admin API returns unexpected JSON, paste the raw response (truncated to 500 chars) before falling back.
