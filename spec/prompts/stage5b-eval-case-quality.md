# Cursor Prompt — Stage 5b: Eval Case Quality Fixes

> **Context:** `bollard eval tag` shows boundary-tester at 75%, contract-tester at 50%, behavioral-tester at 67% after two separate baseline tags. These are NOT prompt quality issues — the agents produce reasonable output. The assertions are too brittle or wrong. We need to diagnose exactly which assertions fail, then fix only those assertions.
>
> **Read CLAUDE.md fully before writing any code.** Then read:
> - `packages/agents/src/evals/boundary-tester/cases.ts`
> - `packages/agents/src/evals/contract-tester/cases.ts`
> - `packages/agents/src/evals/behavioral-tester/cases.ts`
> - `packages/engine/src/eval-runner.ts` — `EvalRunResult.details[].assertions[]` has `passed`, `actual`, `message` per assertion
> - `packages/cli/src/eval-baseline.ts` — `tag` subcommand
> - `packages/cli/src/index.ts` — `eval [agent]` routing (runs evals and prints per-case results)

---

## Step 1 — Diagnose which assertions are failing

Run each failing agent individually to see per-case pass/fail output:

```bash
docker compose run --rm dev sh -c \
  'pnpm --filter @bollard/cli run start -- eval boundary-tester'

docker compose run --rm dev sh -c \
  'pnpm --filter @bollard/cli run start -- eval contract-tester'

docker compose run --rm dev sh -c \
  'pnpm --filter @bollard/cli run start -- eval behavioral-tester'
```

If the CLI output doesn't show individual assertion results (only case pass/fail), add temporary debug output by reading `EvalRunResult.details[0].assertions` — or look at the `runEvals` return value in `packages/cli/src/eval-baseline.ts` where it calls `runEvals` per agent. The `details[].assertions[]` array has `{ passed, actual, message }` for each assertion.

**Goal of Step 1:** Identify the exact `caseId` and `assertion.description` that is failing in each run.

---

## Step 2 — Understand why each assertion fails

For each failing assertion, look at the `actual` field (first 200 chars of the LLM response) and the `message` field. Common root causes:

- **`contains: "X"`** — model uses synonym or different casing (`"resilience"` vs `"resiliency"`, `"reject"` vs `"throw"`, `"quote"` vs `"verbatim"`)
- **`matches_regex: "X"`** — regex is too narrow or has escaping issues
- **`not_contains: "X"`** — model happens to include that string for a legitimate reason

The three agents that currently fail at 50–75%:

- **boundary-tester (75% = 1/4 failing):** Likely `boundary-tester-includes-negative-tests` or `boundary-tester-includes-property-based`. The assertions check for `"negative"`, `"reject"`, `"fc."`, and a regex for `fast-check|fc\.property|fc\.assert`. Models may say "throws" not "reject", or use `fc.property` but in a way the regex misses.
- **contract-tester (50% = 1/2 failing):** One of the two cases always fails. Check `"grounding"`, `"quote"`, `"parseInput"`, `"ValidationError"` — models may produce valid JSON but with different field names or structure. Also check whether the model wraps output in a fence at all.
- **behavioral-tester (67% = 1/3 failing):** Likely `behavioral-tester-resilience-concern`. The assertion checks `contains: "resilience"` — model may say `"resiliency"`, `"fault-tolerance"`, or put the concept in the claim text without using that exact word.

---

## Step 3 — Fix only the failing assertions

**Rules for fixing:**
1. Do NOT change what the assertion is testing — only make it more robust about how it tests.
2. Prefer `matches_regex` with synonym alternatives over exact `contains` when the LLM may use different phrasing.
3. Do NOT weaken assertions to the point they pass on garbage output (e.g., don't replace `contains: "ValidationError"` with `contains: "Error"` — that's too broad).
4. If the model genuinely never produces a required field (e.g., always omits `"quote"` but includes `"verbatim"`), update the assertion to accept either.
5. If a case is testing the wrong thing (e.g., testing exact string that's not in the system prompt), rewrite the case instruction to make the expected output deterministic.

**After fixing assertions**, run the evals again to confirm they pass:

```bash
docker compose run --rm dev sh -c \
  'pnpm --filter @bollard/cli run start -- eval boundary-tester'
docker compose run --rm dev sh -c \
  'pnpm --filter @bollard/cli run start -- eval contract-tester'
docker compose run --rm dev sh -c \
  'pnpm --filter @bollard/cli run start -- eval behavioral-tester'
```

Target: **100% on all three agents** (or at minimum: the previously-failing cases now pass consistently across 2–3 consecutive runs).

---

## Step 4 — Retag the baseline

Once all three agents reach 100%:

```bash
docker compose run --rm dev sh -c \
  'pnpm --filter @bollard/cli run start -- eval tag stage5b-quality --notes "All 5 agents at 100% after hardening brittle assertions"'

docker compose run --rm dev sh -c \
  'pnpm --filter @bollard/cli run start -- eval show'

docker compose run --rm dev sh -c \
  'pnpm --filter @bollard/cli run start -- eval diff'
```

Expected for `diff`: all agents PASS, exit 0.

---

## Step 5 — Run full validation

```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

Expected: clean typecheck + lint, same test count (eval cases are not unit-tested directly — only `eval-baseline.test.ts` which tests the engine logic, not the case content).

---

## Constraints

- **Do NOT change the system prompts** (`CONTRACT_SYSTEM`, `BEHAVIORAL_SYSTEM`, `BOUNDARY_TESTER_SYSTEM`) — the agents are working correctly, the assertions are wrong.
- **Do NOT change `eval-runner.ts`** — the runner is fine.
- **Do NOT add new eval cases** — fix the existing ones.
- **Do NOT lower thresholds** in the baseline — the fix must be in the assertion logic.
- The goal is assertions that are robust to legitimate LLM output variation (synonyms, formatting) while still detecting genuine failures (wrong structure, missing required fields, invented private symbols).

---

## CLAUDE.md update

After the retag succeeds with all 5 agents at 100%, update the Stage 5b Phase 1 section in CLAUDE.md:

Find:
```
**Baseline scores (2026-05-19, claude-sonnet-4-20250514):** planner 100%, coder 100%, boundary-tester 75%, contract-tester 50%, behavioral-tester 67%. The contract-tester and behavioral-tester scores are low due to brittle eval assertions (exact symbol name matching, exact concern-string matching) — these are eval case quality issues, not prompt quality issues. **Before tightening eval cases for these two agents, re-tag the baseline immediately after** so the floor rises with the improvement. See `packages/agents/src/evals/contract-tester/cases.ts` (`contract-tester-references-context-symbols` — checks exact `parseInput`/`ValidationError` strings) and `packages/agents/src/evals/behavioral-tester/cases.ts` (`behavioral-tester-resilience-concern` — checks exact `"resilience"` string).
```

Replace with:
```
**Baseline scores (stage5b-quality tag, 2026-05-19, claude-sonnet-4-20250514):** planner 100%, coder 100%, boundary-tester 100%, contract-tester 100%, behavioral-tester 100%. Prior brittle assertions (exact `"resilience"` string, exact `"parseInput"`/`"ValidationError"` strings) replaced with `matches_regex` synonym sets. Baseline retagged `stage5b-quality` after all 5 agents reached 100%.
```
