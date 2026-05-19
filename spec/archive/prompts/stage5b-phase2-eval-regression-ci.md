# Cursor Prompt — Stage 5b Phase 2: Eval Regression CI

> **Context:** Stage 5b Phase 1 is DONE — `bollard eval tag/show/diff` commands exist, all 5 agents (planner, coder, boundary-tester, contract-tester, behavioral-tester) run at 100% pass rate, baseline tagged `stage5b-quality`. What's missing: a GitHub Actions workflow that runs `bollard eval diff` automatically so prompt regressions are caught without manual intervention. This is structurally identical to `cost-regression.yml` — a scheduled + manual-dispatch workflow that makes real LLM calls and exits 1 on regression.
>
> **Read CLAUDE.md fully before writing any code.** Then read:
> - `.github/workflows/cost-regression.yml` — the exact pattern to follow for a scheduled LLM regression check
> - `.github/workflows/bollard-verify.yml` — how the existing CI handles Docker + pnpm setup
> - `packages/cli/src/eval-baseline.ts` — `diff` subcommand behavior (exits 1 when any agent's passRate drops > thresholdPct from baseline)
> - `.bollard/eval-baseline.json` — current baseline (`stage5b-quality`, 5 agents, all 100%)

---

## What to build

One new file only: `.github/workflows/eval-regression.yml`

---

### `.github/workflows/eval-regression.yml`

**Triggers:**
- `workflow_dispatch` (manual, no inputs needed)
- `schedule`: weekly, Wednesday 04:00 UTC (`cron: "0 4 * * 3"`) — offset from `cost-regression.yml` (Monday) to spread LLM costs

**Job: `eval-check`**

Steps:
1. `actions/checkout@v4`
2. Build dev image: `docker compose build dev`
3. **Run eval diff** — the key step:
   ```bash
   docker compose run --rm dev sh -c \
     'pnpm --filter @bollard/cli run start -- eval diff'
   ```
   - Requires `ANTHROPIC_API_KEY` from secrets
   - This step exits 1 if any agent's pass rate drops more than `thresholdPct` (10 pp) below baseline
4. **Upload eval baseline as artifact** (always, for debugging):
   - Path: `.bollard/eval-baseline.json`
   - Name: `eval-baseline-${{ github.run_id }}`
   - `if: always()`

**No pipeline run needed** — unlike `cost-regression.yml`, eval diff does not run the full `implement-feature` pipeline. It only calls the LLM for each eval case (~17 cases total across 5 agents, ~1 run each). Expected cost: < $0.10 per workflow run. Expected time: ~2–3 minutes.

**Do NOT** add `BOLLARD_AUTO_APPROVE` or `BOLLARD_METRICS` env vars — those are pipeline-run-only flags.

---

## CLAUDE.md update

Find the Stage 5b section (forward roadmap bullet) currently reading:
```
**Stage 5b (self-improvement):** Phase 1 DONE (prompt regression gating — `eval-baseline` store, `bollard eval tag/show/diff`). Next: Phase 2 (eval regression CI). Meta-verification, adaptive concern weights remain.
```

Replace with:
```
**Stage 5b (self-improvement):** Phase 1 DONE (prompt regression gating — `eval-baseline` store, `bollard eval tag/show/diff`). **Phase 2 DONE** (eval regression CI — `.github/workflows/eval-regression.yml`, weekly Wednesday 04:00 UTC + manual dispatch, exits 1 on passRate regression). Meta-verification, adaptive concern weights remain.
```

Also add a new `### Stage 5b Phase 2 (DONE)` section at the bottom of the Stage scope sections (after the existing `### Stage 5b Phase 1 (DONE)` section), with this text:
```
### Stage 5b Phase 2 (DONE) — Eval Regression CI:

`.github/workflows/eval-regression.yml`: `workflow_dispatch` + weekly Wednesday 04:00 UTC schedule. Builds dev image, runs `bollard eval diff` inside Docker (requires `ANTHROPIC_API_KEY` secret). Exits 1 if any agent's pass rate drops more than `thresholdPct` (10 pp) below the `stage5b-quality` baseline. Expected cost: < $0.10 per run (~17 eval cases × 1 run each). Offset from `cost-regression.yml` (Monday) to spread API costs. Uploads `.bollard/eval-baseline.json` as artifact on every run for debugging.
```

---

## Validation

After creating the workflow file:

```bash
# Typecheck and lint (no new TypeScript — just a YAML file, but run the suite anyway)
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

Expected: clean, test count unchanged.

Then trigger the workflow manually from GitHub Actions UI (or via `gh workflow run eval-regression.yml`) and confirm:
- All 5 agents pass at 100%
- Workflow exits 0
- `.bollard/eval-baseline.json` artifact is uploaded

---

## Constraints

- **One file only:** `.github/workflows/eval-regression.yml`. No changes to existing workflows, no CLI changes.
- **Do NOT re-implement `bollard eval diff`** — it already exists and works. The workflow just calls it.
- **`eval diff` makes real LLM calls** — this is expected (same as `cost-baseline diff` in `cost-regression.yml`). Document the expected cost in a workflow comment.
- The workflow does NOT retag the baseline — retagging is a manual operation after intentional prompt improvements.
- Follow the same Docker + secrets pattern as `cost-regression.yml` exactly.
