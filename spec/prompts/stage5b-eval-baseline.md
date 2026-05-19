# Cursor Prompt — Stage 5b: Prompt Regression Gating

> **Context:** Bollard has eval sets for all 5 agents (`planner`, `coder`, `boundary-tester`, `contract-tester`, `behavioral-tester`) in `packages/agents/src/evals/*/cases.ts`. `runEvals` in `packages/engine/src/eval-runner.ts` already returns `passRate` and `ok` per case. The `bollard eval [agent]` CLI command already runs them. What's missing: a stored baseline file and a `bollard eval diff` command that exits 1 when any agent's pass-rate drops below its baseline. This is structurally identical to `cost-baseline` — a JSON file, two new engine functions, and three CLI subcommands (`tag`, `show`, `diff`).
>
> **Read CLAUDE.md fully before writing any code.** Then read:
> - `packages/engine/src/cost-baseline.ts` — the exact pattern to follow: `readBaseline`/`writeBaseline`/`compareToBaseline`, non-throwing, ENOENT → null
> - `packages/cli/src/cost-baseline.ts` — `tag`/`show`/`diff` subcommand routing, `--work-dir` flag handling, terminal output style (uses `BOLD`, `DIM`, `GREEN`, `RED`, `YELLOW`, `RESET` from `terminal-styles.ts`)
> - `packages/engine/src/eval-runner.ts` — `EvalRunResult` shape (`caseId`, `passRate`, `ok`), `runEvals` signature
> - `packages/agents/src/eval-loader.ts` — `loadEvalCases(agentFilter?)`, `availableAgents()`
> - `packages/cli/src/index.ts` lines 893–940 — how `eval` command is currently routed and how `cost-baseline` is added to help text

---

## What to build

Four self-contained pieces.

---

### Piece 1 — `packages/engine/src/eval-baseline.ts` (new file)

```typescript
export interface AgentEvalScore {
  agent: string           // "planner" | "coder" | "boundary-tester" | "contract-tester" | "behavioral-tester"
  caseCount: number       // number of eval cases in the set at tag time
  passRate: number        // 0.0–1.0, average passRate across all cases
  thresholdPct: number    // minimum acceptable passRate as a percentage (0–100); default 80
}

export interface EvalBaseline {
  tag: string
  timestamp: number
  model: string           // model used when this baseline was recorded
  scores: AgentEvalScore[]
  notes?: string
}

export interface EvalBaselineComparison {
  baseline: EvalBaseline
  current: AgentEvalScore[]           // scores from this run
  regressions: AgentEvalScore[]       // agents where current passRate < baseline passRate - threshold
  verdict: "pass" | "fail" | "no_baseline"
}
```

**`readEvalBaseline(baselineFile: string): Promise<EvalBaseline | null>`**
- Read + JSON.parse the file. Return `null` on ENOENT. Throw on other errors or invalid JSON.

**`writeEvalBaseline(baselineFile: string, baseline: EvalBaseline): Promise<void>`**
- `mkdir` parent dir recursively, then `writeFile` with `JSON.stringify(baseline, null, 2) + "\n"`.

**`compareToEvalBaseline(baseline: EvalBaseline, current: AgentEvalScore[]): EvalBaselineComparison`**
- Pure (synchronous). For each score in `baseline.scores`, find the matching `current` entry by `agent`. A regression is: `currentPassRate < baselinePassRate - (thresholdPct / 100)`. Return all regressions. `verdict = "fail"` if any regressions exist, else `"pass"`.
- If `current` has no entry for a baseline agent (agent was removed), that is NOT a regression — skip it.

Export all three functions and all interfaces. No classes.

---

### Piece 2 — `packages/cli/src/eval-baseline.ts` (new file)

Three subcommands: `tag`, `show`, `diff`. Follow `packages/cli/src/cost-baseline.ts` exactly for structure (arg parsing, `--work-dir` stripping, terminal output style, exit codes).

**`bollard eval tag <tag-name> [--model <model>] [--threshold <pct>] [--notes <text>] [--work-dir <path>]`**

1. Load eval cases with `loadEvalCases()` (all agents, no filter) grouped by agent using `availableAgents()`.
2. Resolve the LLM provider + model from `resolveConfig(workDir)`. The `--model` flag overrides if provided.
3. Run `runEvals(cases, provider, { model, runs: 1 })` per agent (one `runEvals` call per agent, passing only that agent's cases).
4. Compute per-agent `passRate = results.filter(r => r.ok).length / results.length`.
5. Write `EvalBaseline` to `.bollard/eval-baseline.json`.
6. Print a table: one row per agent with case count, pass rate %, threshold %.

Default `--threshold`: 80 (meaning: a run is a regression if passRate drops more than 0.80 from baseline — i.e., below `baselinePassRate - 0.80`).

Wait — re-read the comparison logic. `thresholdPct` here is the *minimum acceptable pass rate* for that agent, not a delta. Keep it simple:
- `thresholdPct` is the floor: if `currentPassRate * 100 < thresholdPct`, it's a regression regardless of baseline.
- Additionally, if `currentPassRate < baselinePassRate - 0.10` (more than 10 percentage points below baseline), it's also a regression.

Actually, keep the design simple and parallel to `cost-baseline`:
- `thresholdPct` is a **drop tolerance**: if `(baselinePassRate - currentPassRate) * 100 > thresholdPct`, it's a regression.
- Default `thresholdPct: 10` — a 10 percentage point drop triggers a regression (e.g., baseline 100% → current 89% = regression).
- This is the delta model, matching `cost-baseline.thresholdPct`.

**`bollard eval show [--work-dir <path>]`**

Read `.bollard/eval-baseline.json` and pretty-print it. Exit 1 if no file.

**`bollard eval diff [--work-dir <path>]`**

1. Read `.bollard/eval-baseline.json`. Exit 1 if no file.
2. Run evals for all agents using `resolveConfig` model (same model as stored in baseline when possible — log a warning if model differs).
3. Compare with `compareToEvalBaseline`.
4. Print a table: one row per agent — baseline %, current %, delta, PASS/FAIL.
5. **Exit 1 if `verdict === "fail"`**. Exit 0 otherwise.

Export `runEvalBaselineCommand(rest: string[], workDir: string): Promise<void>`.

---

### Piece 3 — Wire into CLI (`packages/cli/src/index.ts`)

The `eval` command currently routes directly to `runEvalCommand`. Extend it so:

```
bollard eval [agent]            ← existing behavior (run evals, print results)
bollard eval tag <name> [...]   ← new
bollard eval show               ← new
bollard eval diff               ← new
```

Detection: if `rest[0]` is `"tag"`, `"show"`, or `"diff"`, route to `runEvalBaselineCommand`. Otherwise fall through to the existing `runEvalCommand(rest)`.

Add to the help text:
```
  eval [agent]                    Run agent eval sets
  eval tag|show|diff              Eval pass-rate baseline (diff exits 1 on regression)
```

---

### Piece 4 — Initial baseline tag

After the code is written and typechecks clean, run the baseline tag to create the initial `.bollard/eval-baseline.json`. This requires a live LLM call:

```bash
docker compose run --rm dev sh -c \
  'pnpm --filter @bollard/cli run start -- eval tag stage5b-initial --notes "Stage 5b initial eval baseline"'
```

This will call the LLM for each agent's eval cases (5 agents × 1 run each). Expected cost: < $0.10. Expected time: ~1–2 minutes.

After it runs, print the output and confirm `.bollard/eval-baseline.json` exists with scores for all 5 agents.

---

## Tests to add

### `packages/engine/tests/eval-baseline.test.ts` (new file)

10 tests covering:

1. `readEvalBaseline` returns `null` for nonexistent file
2. `readEvalBaseline` parses a valid baseline JSON
3. `writeEvalBaseline` creates the file and parent dirs
4. `writeEvalBaseline` round-trips with `readEvalBaseline`
5. `compareToEvalBaseline` returns `verdict: "pass"` when all agents meet threshold
6. `compareToEvalBaseline` returns `verdict: "fail"` when one agent drops > thresholdPct
7. `compareToEvalBaseline` no regression when current passRate equals baseline exactly
8. `compareToEvalBaseline` no regression for an agent missing from `current` (removed agent)
9. `compareToEvalBaseline` regression when passRate drops by exactly `thresholdPct + 1`
10. `compareToEvalBaseline` no regression when passRate drops by exactly `thresholdPct - 1`

Use `tmp` directories via `os.tmpdir()` + `crypto.randomUUID()` for file tests. No mocking.

---

## CLAUDE.md update

Find the Stage 5b section (currently under "### 5b: Self-Improvement"). After the existing bullet:
```
- **Prompt regression gating:** `bollard eval` runs before and after prompt changes; new prompts must match or exceed baseline scores. Eval sets already exist for planner, coder, boundary-tester, contract-tester.
```
Replace with:
```
- **Prompt regression gating:** **DONE.** `EvalBaseline` store at `.bollard/eval-baseline.json` records per-agent pass rates. `bollard eval tag/show/diff` CLI commands — `diff` exits 1 when any agent's pass rate drops more than `thresholdPct` percentage points below baseline. Initial baseline tagged `stage5b-initial` from all 5 agents.
```

Also add `Stage 5b Phase 1 (DONE)` to the Stage 5 scope section:
```
### Stage 5b Phase 1 (DONE) — Prompt Regression Gating:

`EvalBaseline` interface in `@bollard/engine` with `AgentEvalScore[]` (agent, caseCount, passRate, thresholdPct), `readEvalBaseline`/`writeEvalBaseline`/`compareToEvalBaseline` (pure, synchronous comparison). `bollard eval tag <name>` — runs all 5 agent eval sets (1 run each), stores per-agent pass rates to `.bollard/eval-baseline.json`. `bollard eval show` — prints baseline table. `bollard eval diff` — re-runs evals, compares to baseline, exits 1 on regression (passRate drop > thresholdPct). Regression model: delta-based (same as cost-baseline), default 10 pp tolerance. Initial baseline `stage5b-initial` tagged after implementation.
```

---

## Constraints

- **Do NOT run the existing `bollard eval [agent]` command to re-implement it** — extend the routing only. The existing `runEvalCommand` function is untouched.
- **Do NOT change `EvalRunResult` or `runEvals`** — the new code reads from them, never modifies them.
- **The `diff` command makes real LLM calls** — it runs all eval cases to get current scores. This is expected behavior (same as `cost-baseline diff` queries the real run history). Document this in the help text: `diff` costs ~$0.10.
- **No CI workflow yet** — that's Stage 5b Phase 2. This phase just adds the command. The GitHub Actions integration comes after the command is validated locally.
- **`resolveConfig` without `requireApiKey: false`** — the eval commands need a real provider. They should call `resolveConfig` normally (with API key required). If no key is present, they will fail with the standard `CONFIG_INVALID` error, which is correct behavior.
- Follow the existing no-class, named-export, kebab-case-files conventions throughout.
- All new code in `packages/engine/` and `packages/cli/` follows `exactOptionalPropertyTypes` — no explicit `undefined` assignments.

---

## Validation

```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

Expected: clean typecheck + lint, test count increases by 10 (the new `eval-baseline.test.ts` cases). Zero failures.

Then run the smoke test (requires API key):
```bash
docker compose run --rm dev sh -c \
  'pnpm --filter @bollard/cli run start -- eval tag stage5b-initial'

docker compose run --rm dev sh -c \
  'pnpm --filter @bollard/cli run start -- eval show'

docker compose run --rm dev sh -c \
  'pnpm --filter @bollard/cli run start -- eval diff'
```

Expected for `diff`: all agents PASS, exit 0 (baseline was just set from this run — no drift possible).
