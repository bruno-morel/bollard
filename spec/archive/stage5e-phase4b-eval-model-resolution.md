---
name: stage5e-phase4b-eval-model-resolution
overview: "Stage 5e Phase 4b: per-agent model resolution in the eval runner (evals must test the models production actually uses), registry-clean test fixtures, live validation of the model-per-node observability, and eval baseline retag."
todos:
  - id: step-0-precondition
    content: "Verify Phase 4 is committed and green: clean tree, lint clean, 1507/6 tests"
    status: pending
  - id: step-1-stream-test-model
    content: "Point anthropic-stream.test.ts at a registry model so the test suite runs warning-clean"
    status: pending
  - id: step-2-eval-per-agent
    content: "runAllAgentScores resolves provider+model per agent via forAgent(agent); record model per AgentEvalScore"
    status: pending
  - id: step-3-diff-warnings
    content: "eval diff warns per-agent on model mismatch; eval show renders per-agent models"
    status: pending
  - id: step-4-tests
    content: "Unit tests for per-agent resolution, override-all semantics, baseline backward compat"
    status: pending
  - id: step-5-validate
    content: "typecheck/lint/test, demo run + history show model suffix, eval diff investigation, retag stage5b-sonnet-4-6"
    status: pending
  - id: step-6-docs
    content: "When GREEN: CLAUDE.md + ROADMAP.md updates, archive prompt"
    status: pending
isProject: false
---

# Stage 5e Phase 4b — Eval Runner Per-Agent Model Resolution + Observability Validation

## Goal

Close the three follow-ups from Phase 4 (model registry, shipped 2026-06-05):

1. **The eval runner tests the wrong models.** `runAllAgentScores` in [`packages/cli/src/eval-baseline.ts`](packages/cli/src/eval-baseline.ts) (~line 113) resolves ONE model via `llmClient.forAgent("default")` and runs **all five agents on it**. Production resolves per-agent: testers/planner/reviewer run Haiku, coder runs Sonnet 4.6. This is why `eval diff` failed after the Phase 4 migration with tester "regressions" (boundary 75%, contract 50%, behavioral 67%) — the testers were evaluated on Sonnet 4.6, a model they never use in production. The eval CI is supposed to gate prompt changes against production behavior; right now it gates against a configuration that doesn't exist.
2. **Warning noise:** `anthropic-stream.test.ts` uses `claude-haiku-3-5-20241022` (not in the registry), so every test run emits the unknown-model warning — training people to ignore the one warning that matters.
3. **Unvalidated observability:** the `model`-per-node wiring (NodeResult.model → NodeSummary.model → `history show` suffix) has only been exercised by mock tests; one cheap live run confirms it end to end.

## Step 0 — Precondition check

1. `git status` — clean tree; Phase 4 commits (registry + model swap + observability) are on `main`.
2. `docker compose run --rm dev run lint` — exit 0 (the ANSI-regex fix in `history-show.test.ts` is in).
3. `docker compose run --rm dev run test` — **1507 passed / 6 skipped**, 0 failures. This is the floor.

If any of these fail, STOP — finish Phase 4 first.

## Step 1 — Registry-clean stream test

[`packages/llm/tests/anthropic-stream.test.ts`](packages/llm/tests/anthropic-stream.test.ts): replace every occurrence of `claude-haiku-3-5-20241022` with `claude-haiku-4-5-20251001` (both the mocked `finalMessage.model` field and any request model in the test body). The test's assertions are about stream-event mapping, not the model id — behavior is unchanged, but `estimateCostForModel` now finds a registry entry and stays silent.

Gate for this step: `docker compose run --rm dev run test 2>&1 | grep "unknown model"` — empty.

## Step 2 — Per-agent model resolution in the eval runner

In [`packages/cli/src/eval-baseline.ts`](packages/cli/src/eval-baseline.ts), `runAllAgentScores` (~lines 113–143):

Current shape (resolve once, outside the loop):

```ts
const { provider, model: defaultModel } = llmClient.forAgent("default")
const model = modelOverride ?? defaultModel
const evalProvider = { chat: provider.chat.bind(provider) }
```

New shape — resolve inside the `for (const agent of EVAL_AGENTS)` loop:

- `const { provider, model: agentModel } = llmClient.forAgent(agent)` — eval agent ids (`planner`, `coder`, `boundary-tester`, `contract-tester`, `behavioral-tester`) match `forAgent` role names exactly; verify this against `EVAL_AGENTS` and `config.llm.agents` keys before assuming.
- `const model = modelOverride ?? agentModel` — **an explicit `--model` flag still forces ALL agents onto one model.** This is deliberate: it is the A/B mechanism for the Phase 6 semantic-reviewer experiment. Document this in the usage string.
- Bind `evalProvider` per agent (`provider.chat.bind(provider)`) — providers can differ per agent too.

Type change in [`packages/engine/src/eval-baseline.ts`](packages/engine/src/eval-baseline.ts):

```ts
export interface AgentEvalScore {
  agent: string
  caseCount: number
  passRate: number
  thresholdPct: number
  /** Model that produced this score. Absent on baselines tagged before Phase 4b. */
  model?: string
}
```

- Additive, optional — old `.bollard/eval-baseline.json` files parse unchanged (`readEvalBaseline` casts; no schema validation to update, but confirm).
- Keep `EvalBaseline.model: string` as-is — it now records `llm.default`'s model (the fallback), for backward compat and display. Do NOT remove or rename it.
- `runAllAgentScores` populates `model` on every score and still returns the top-level default model.

`compareToEvalBaseline` (pure function) compares pass rates only — no change to its logic.

## Step 3 — Diff warnings + show rendering

In the `diff` path (~line 216–220): keep the existing top-level model-mismatch warning, and add a per-agent one — when both `baseline.scores[i].model` and the current score's `model` are present and differ, print a yellow per-agent line:

```
Warning: boundary-tester model changed (claude-sonnet-4-20250514 → claude-haiku-4-5-20251001)
```

When the baseline score has no `model` (pre-Phase 4b baseline), print nothing per-agent — the top-level warning covers it.

In `eval show` (~line 162): render each agent's model as a dim suffix on its score row when present.

## Step 4 — Tests

In the existing eval-baseline test files (engine + cli):

- `AgentEvalScore` with and without `model` round-trips through write/read (backward compat: a baseline JSON without per-score `model` parses and compares cleanly).
- `runAllAgentScores` resolution: with a config assigning different models per agent (use the mock provider pattern from `client.test.ts`), each returned score carries its agent's model, not `llm.default`'s.
- `--model` override: all scores carry the override model.
- `compareToEvalBaseline`: pass-rate comparison unaffected by model fields.

Expected: +4–6 tests.

## Step 5 — Validation gate (sequential; STOP on failure)

1. `docker compose run --rm dev run typecheck` — exit 0
2. `docker compose run --rm dev run lint` — exit 0
3. `docker compose run --rm dev run test` — ≥ 1511 passed / 6 skipped, 0 failures; no `unknown model` warnings in output
4. **Live observability check** (cheap, requires `ANTHROPIC_API_KEY`, ~$0.01):
   ```bash
   docker compose run --rm dev sh -c \
     'pnpm --filter @bollard/cli run start -- run demo --task "Say hello" --work-dir /app'
   docker compose run --rm dev sh -c \
     'pnpm --filter @bollard/cli run start -- history show <run-id-from-above>'
   ```
   Gate: stderr shows `agent_model_resolved` with a real model id; `history show` renders the dim model suffix on the agentic node. This is the first non-mock validation of the Phase 4 observability wiring.
5. **Eval re-run — investigate before retagging** (~$0.10, ~8 min):
   ```bash
   docker compose run --rm dev sh -c \
     'pnpm --filter @bollard/cli run start -- eval diff --work-dir /app'
   ```
   - Expected: planner/coder hold at 100%; testers now run on Haiku (their production model).
   - If testers score 100% → proceed to retag.
   - If any tester drops: **inspect the failing cases before concluding anything.** Precedent: the original `stage5b-quality` failures were brittle assertions (exact-string matches not accepting valid grounding forms), fixed with `matches_regex` synonym sets — NOT model problems. Read the failing case assertions in `packages/agents/src/evals/<agent>/cases.ts`; if the agent output is semantically correct but the assertion is format-brittle, fix the assertion; only if output is genuinely wrong report it and STOP (that would mean production Haiku testers have an undetected quality gap — a finding, not a fix-in-this-prompt).
6. **Retag** (only after step 5 passes clean):
   ```bash
   docker compose run --rm dev sh -c \
     'pnpm --filter @bollard/cli run start -- eval tag stage5b-sonnet-4-6 --notes "per-agent model resolution; coder sonnet-4-6, others haiku-4-5" --work-dir /app'
   ```
   Then `eval diff` once more — must exit 0 against the new baseline.

## Step 6 — When GREEN: docs + cleanup

1. **CLAUDE.md**: note the eval runner now resolves models per agent via `forAgent(role)`; new baseline tag `stage5b-sonnet-4-6`; updated test count; remove/amend the "eval diff uses `llm.default` for all agents" caveat in the Phase 4 entry.
2. **spec/ROADMAP.md**: mark the eval-retag follow-up done.
3. Move this file to `spec/archive/`.
4. Two commits: `Stage 5e Phase 4b: per-agent model resolution in eval runner + registry-clean fixtures` then `docs: Stage 5e Phase 4b + eval baseline retag`.

## Out of scope — DO NOT

- DO NOT change eval case content or agent prompts to chase scores — assertion-brittleness fixes only (regex synonym sets), and only for cases that fail in step 5.5 with semantically-correct output.
- DO NOT build `role-requirements.ts` / `resolveModelForRole` — that is Phase 5.
- DO NOT touch the semantic-reviewer model — the Haiku vs Sonnet A/B is Phase 6, and the `--model` override-all semantics you are preserving is its mechanism.
- DO NOT remove `EvalBaseline.model` or bump any schema version — all changes are additive.
- DO NOT modify `.github/workflows/eval-regression.yml` — it calls `eval diff` and inherits the fix.
- DO NOT touch `MODEL_REGISTRY` entries (the haiku-3-5 fix is in the test fixture, not the registry).
