# Cursor Prompt — Stage 5d Phase 6: Cost Regression CI

> **Context:** Phases 7, 8, 9, and 10 are shipped and validated. The 2026-05-15 validation run (`20260515-0350-run-75c385`) gives us a concrete baseline: $2.5592, 47 coder turns, avg 16,596 input tokens/turn, 31/31 nodes. Phase 6 locks this baseline and adds a CI gate that fails when a future change causes >15% cost regression.
>
> **Read CLAUDE.md fully before writing any code.** Then read:
> - `packages/engine/src/run-history.ts` — `RunRecord`, `RunSummary`, `FileRunHistoryStore`, `computeCostTrend`
> - `packages/engine/src/run-history-db.ts` — `SqliteIndex`, `createSqliteIndex`
> - `packages/cli/src/index.ts` — how CLI commands are registered
> - `packages/cli/src/history.ts` — how `history summary` is implemented (follow the same pattern)
> - `.bollard/runs/history.jsonl` — the actual run records on disk

---

## What to build

Three things, each independently shippable:

### 6a — `CostBaseline` store (`packages/engine/src/cost-baseline.ts`)

A simple JSONL store at `.bollard/cost-baseline.json` (a single JSON object, not JSONL) with this shape:

```typescript
export interface CostBaseline {
  tag: string               // e.g. "phase9-validated"
  runId: string             // the run that set this baseline
  timestamp: number         // ms since epoch
  blueprintId: string       // "implement-feature"
  totalCostUsd: number      // $2.5592
  coderTurns?: number       // 47 — stored but not yet in RunRecord (see note below)
  avgInputTokensPerTurn?: number  // 16,596 — same note
  thresholdPct: number      // default 15 — fail CI if cost regresses > this %
  notes?: string
}

export interface CostBaselineComparison {
  baseline: CostBaseline
  current: { avgCostUsd: number; runCount: number; since: number }
  regressionPct: number     // positive = regression (cost went up), negative = improvement
  passed: boolean           // true if regressionPct <= baseline.thresholdPct
  verdict: "pass" | "fail" | "insufficient_data"  // insufficient_data when < 3 runs since baseline
}
```

Functions to export:
- `readBaseline(baselineFile: string): Promise<CostBaseline | null>`
- `writeBaseline(baselineFile: string, baseline: CostBaseline): Promise<void>`
- `compareToBaseline(baseline: CostBaseline, store: FileRunHistoryStore): Promise<CostBaselineComparison>`

`compareToBaseline` queries `store.query({ blueprintId: baseline.blueprintId, since: baseline.timestamp })`, computes the average `totalCostUsd` across those runs, and returns the comparison. If fewer than 3 runs exist since the baseline timestamp, verdict is `"insufficient_data"` (never fail CI on a single run).

The baseline file path should default to `.bollard/cost-baseline.json`. Do NOT store it in the JSONL run history or SQLite — it's a separate artifact that maintainers commit to the repo.

### 6b — `bollard cost-baseline` CLI command (`packages/cli/src/cost-baseline.ts`)

Three subcommands:

```
bollard cost-baseline tag <tag-name> [--run-id <id>] [--threshold <pct>] [--notes "..."]
bollard cost-baseline show
bollard cost-baseline diff
```

**`tag`** — sets a new baseline. If `--run-id` is given, reads that `RunRecord` from history and uses its `totalCostUsd`. If omitted, uses the most recent successful `implement-feature` run. Writes `.bollard/cost-baseline.json`. Prints a summary table.

**`show`** — reads and prints the current baseline as a table.

**`diff`** — calls `compareToBaseline` and prints:
- baseline tag, run id, date
- current average cost (N runs since baseline)
- regression %
- verdict: PASS / FAIL / INSUFFICIENT DATA
- exits with code 1 if verdict is FAIL

Wire it into `packages/cli/src/index.ts` under the `cost-baseline` command (same pattern as `history`).

### 6c — GitHub Actions workflow (`.github/workflows/cost-regression.yml`)

A manually-triggered workflow (`workflow_dispatch`) — not on every push, because it runs the full Bollard pipeline and costs real money. It can also be triggered on a schedule (weekly, off-peak).

```yaml
name: Cost Regression Check
on:
  workflow_dispatch:
    inputs:
      task:
        description: "Implementation task for the pipeline run"
        required: false
        default: "Add a runCount(): number method to CostTracker that returns the number of times add() has been called since construction. No parameters. Do not modify any existing methods or tests."
  schedule:
    - cron: "0 4 * * 1"   # Mondays at 04:00 UTC

jobs:
  cost-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build dev image
        run: docker compose build dev
      - name: Run pipeline
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          BOLLARD_AUTO_APPROVE: "1"
          BOLLARD_METRICS: "1"
        run: ./scripts/bollard-metrics-run.sh "${{ github.event.inputs.task || 'Add a runCount(): number method to CostTracker that returns the number of times add() has been called since construction. No parameters. Do not modify any existing methods or tests.' }}"
      - name: Check cost regression
        run: |
          docker compose run --rm dev sh -c \
            'pnpm --filter @bollard/cli run start -- cost-baseline diff'
      - name: Upload run log
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: bollard-metrics-${{ github.run_id }}
          path: .bollard/last-metrics-run.log
```

Key design decisions:
- **`workflow_dispatch` only** (plus weekly schedule) — never on push. Running the full pipeline on every PR would cost ~$2.50 per push.
- **Default task uses `runCount()`** — a fresh method that doesn't yet exist on main, giving the pipeline real work to do. This avoids the degenerate "already on main" scenario from the Phase 10 validation run.
- **`bollard cost-baseline diff` exits 1 on regression** — CI step fails and surfaces the regression.

---

## Note on `coderTurns` in `RunRecord`

The `RunRecord` interface does not currently store coder turn count — it stores `totalCostUsd` and `nodes[]` (with per-node `costUsd`). The `implement` node's `costUsd` equals the coder's total cost. Turn count is only available from `BOLLARD_METRICS` stderr lines, not from the run record.

For Phase 6, **do not add `coderTurns` to `RunRecord`** — that's a schema change with migration implications. The cost regression check uses only `totalCostUsd`, which is sufficient. Turn count is tracked manually via `BOLLARD_METRICS` lines and the baseline's optional `coderTurns` field (informational only, not used in the regression calculation).

If turn count regression detection becomes important later, the right approach is a separate Phase 6b that adds `coderTurns` to `NodeSummary` for agentic nodes and rebuilds the SQLite index.

---

## Tests to add

### `packages/engine/tests/cost-baseline.test.ts`

1. **`readBaseline` returns null when file missing**
2. **`writeBaseline` / `readBaseline` round-trips** — write a baseline, read it back, verify all fields preserved
3. **`compareToBaseline` with no runs since baseline** — verdict `"insufficient_data"`
4. **`compareToBaseline` with 2 runs since baseline** — verdict `"insufficient_data"` (< 3)
5. **`compareToBaseline` with 3 runs, within threshold** — verdict `"pass"`, correct `regressionPct`
6. **`compareToBaseline` with 3 runs, over threshold** — verdict `"fail"`, `passed: false`
7. **`compareToBaseline` improvement (cost went down)** — `regressionPct` negative, verdict `"pass"`

Use `MockProvider` / in-memory `FileRunHistoryStore` — no real disk I/O except in the round-trip test (use `os.tmpdir()`).

### `packages/cli/tests/cost-baseline.test.ts`

1. **`tag` writes baseline from most recent run** — mock `FileRunHistoryStore`, verify file written
2. **`tag --run-id` writes baseline from specific run**
3. **`show` prints baseline table**
4. **`diff` prints pass verdict and exits 0**
5. **`diff` prints fail verdict and exits 1**
6. **`diff` prints insufficient_data when < 3 runs**

---

## CLAUDE.md update

Find the `### Stage 5d Phase 10 (DONE)` entry. After it, add:

```
### Stage 5d Phase 6 (DONE) — Cost Regression CI:

Closes the token-economy loop. `CostBaseline` store at `.bollard/cost-baseline.json` records a tagged snapshot (run id, cost, threshold). `bollard cost-baseline tag/show/diff` CLI commands. `compareToBaseline` queries `FileRunHistoryStore` for runs since the baseline timestamp, computes average cost, returns `pass/fail/insufficient_data` (never fail on < 3 runs). `.github/workflows/cost-regression.yml`: `workflow_dispatch` + weekly Monday 04:00 UTC schedule; runs `bollard-metrics-run.sh` with a `runCount()` task (always fresh on main), then `bollard cost-baseline diff` (exits 1 on regression). Baseline tag `phase9-validated` set from run `20260515-0350-run-75c385` ($2.5592, threshold 15%).
```

---

## Validation

```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

Expected: clean typecheck + lint, test count increases by 13 (7 engine + 6 CLI).

Then set the baseline from the Phase 9 validation run:

```bash
docker compose run --rm -e BOLLARD_AUTO_APPROVE=1 dev sh -c \
  'pnpm --filter @bollard/cli run start -- cost-baseline tag phase9-validated \
    --run-id 20260515-0350-run-75c385 \
    --threshold 15 \
    --notes "Phase 7+8+9+10 validated baseline — $2.5592, 47 turns, 31/31 nodes"'
```

Then verify the diff command works with insufficient data (only 1 run since baseline):

```bash
docker compose run --rm dev sh -c \
  'pnpm --filter @bollard/cli run start -- cost-baseline diff'
```

Expected output:
```
Baseline:  phase9-validated  (20260515-0350-run-75c385, 2026-05-15)
Cost:      $2.5592
Threshold: 15%
Current:   insufficient data (0 implement-feature runs since baseline)
Verdict:   INSUFFICIENT DATA — need ≥ 3 runs to evaluate
```

---

## Constraints

- Do NOT add `coderTurns` to `RunRecord` — schema migration is out of scope for Phase 6.
- Do NOT run the cost regression check on push/PR — only `workflow_dispatch` + weekly schedule.
- The baseline file `.bollard/cost-baseline.json` should be committed to the repo (it's intentional configuration, not a generated artifact). Add it to git, not to `.gitignore`.
- `compareToBaseline` must never throw — if the history store errors, return `verdict: "insufficient_data"` with a warning log.
- Use the existing `FileRunHistoryStore` and `RunHistoryStore` interface — do not reach into SQLite directly.
- The default task in the workflow (`runCount()`) must not already exist on main at time of shipping. Verify with `grep -r "runCount" packages/engine/src/cost-tracker.ts` before finalising — if it exists, pick a different method name.
