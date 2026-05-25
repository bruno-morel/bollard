# Self-Test: Wire agentBudgets enforcement into agent-handler

## Task

Implement per-agent cost cap enforcement using `config.llm.agentBudgets` in `agent-handler.ts`.

## Background

`BollardConfig.llm.agentBudgets?: Record<string, number>` is already parsed from `.bollard.yml`
and stored in config (added in Stage 5d Phase 5). The comment in `context.ts` explicitly notes
"Enforcement (fallback to cheaper tier when exceeded) is Stage 6." The field is surfaced in
`config show --sources` but silently ignored at runtime — any value set there has no effect.

Currently `agent-handler.ts` only applies a cost cap to the coder:

```typescript
// packages/cli/src/agent-handler.ts ~line 557
executorOptions = {
  postCompletionHook: createVerificationHook(workDir, profile, config.localModels),
  maxVerificationRetries: 3,
  deferPostCompletionVerifyFromTurn: Math.floor(agents.coder.maxTurns * 0.8),
  maxCostUsd: config.agent.max_cost_usd / 2,   // ← hardcoded, ignores agentBudgets
}
```

All other agents (planner, boundary-tester, contract-tester, behavioral-tester, semantic-reviewer)
receive no `executorOptions` at all — they run with no per-attempt cost cap, even if the user has
set one in `.bollard.yml`.

## What to implement

In `packages/cli/src/agent-handler.ts`, resolve a per-agent `maxCostUsd` from
`config.llm.agentBudgets[agentRole]` and apply it to `ExecutorOptions` for every agent role.

### Logic

1. Look up `config.llm.agentBudgets?.[agentRole]` — this is the user-configured per-agent cap.
2. For the **coder**: use `agentBudgets.coder` if set, otherwise fall back to
   `config.agent.max_cost_usd / 2` (existing behavior — do not regress).
3. For **all other agents**: use `agentBudgets[role]` if set, otherwise apply no cap (existing
   behavior — do not regress).
4. When a cap is resolved for a non-coder agent, construct an `ExecutorOptions` with just
   `{ maxCostUsd: resolvedCap }` and pass it to `executeAgent`.

### Implementation sketch

Add this helper near the top of the agentic handler body (before the role-specific `if` blocks),
after `agentCtx` is constructed:

```typescript
// Resolve per-agent cost cap from agentBudgets config, falling back to aggregate / 2 for coder
const agentBudget: number | undefined = config.llm.agentBudgets?.[agentRole]

const resolvedMaxCostUsd: number | undefined =
  agentRole === "coder"
    ? (agentBudget ?? config.agent.max_cost_usd / 2)
    : agentBudget
```

Then in the coder block, replace the hardcoded `maxCostUsd: config.agent.max_cost_usd / 2` with
`maxCostUsd: resolvedMaxCostUsd`:

```typescript
if (agentRole === "coder" && ctx.plan) {
  // ...
  executorOptions = {
    postCompletionHook: createVerificationHook(workDir, profile, config.localModels),
    maxVerificationRetries: 3,
    deferPostCompletionVerifyFromTurn: Math.floor(agents.coder.maxTurns * 0.8),
    maxCostUsd: resolvedMaxCostUsd,   // ← was: config.agent.max_cost_usd / 2
  }
}
```

And after all role-specific `if` blocks, apply a cap to non-coder agents when one is configured:

```typescript
// Apply per-agent budget to non-coder agents when configured
if (agentRole !== "coder" && resolvedMaxCostUsd !== undefined) {
  executorOptions = { ...(executorOptions ?? {}), maxCostUsd: resolvedMaxCostUsd }
}
```

## Files to change

- `packages/cli/src/agent-handler.ts` — the only file that needs changing

## Tests to add

Add tests in `packages/cli/tests/agent-handler.test.ts` (check if it exists; if not, look for
the nearest existing agent-handler test file). The tests should verify:

1. Coder uses `agentBudgets.coder` when set in config
2. Coder falls back to `max_cost_usd / 2` when `agentBudgets.coder` is not set
3. Non-coder agent (e.g. planner) uses `agentBudgets.planner` when set
4. Non-coder agent has no `maxCostUsd` when `agentBudgets` is not configured
5. Non-coder agent has no `maxCostUsd` when `agentBudgets` is set but does not include that role

## Self-check before completing

```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

Verify:
- typecheck: zero errors
- lint: zero errors
- test: ≥ 1181 passed / 6 skipped
- `git diff --name-only` shows ONLY `packages/cli/src/agent-handler.ts` and the test file
- The existing coder behavior is unchanged when `agentBudgets` is absent from config
