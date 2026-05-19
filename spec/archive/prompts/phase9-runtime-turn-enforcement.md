# Cursor Prompt — Phase 9: Runtime Turn Enforcement + Per-Attempt Cost Cap

> **Context:** Phase 7 (prompt-level turn signals) and Phase 8 (context caps) are shipped. The 2026-05-15 validation run showed the remaining problem clearly:
>
> - On attempt 1 the coder ignored the TURN 52 and TURN 58 hard-exit signals in the prompt and ran all 60 turns, spending $3.66.
> - On attempt 2 the coder completed cleanly in 29 turns, spending $1.28.
> - Combined ($4.94) hit the `agent.max_cost_usd: 5` aggregate cap before any contract/behavioral agents could run.
>
> The root cause: prompt-level signals are advisory — under pressure ("almost done") the LLM ignores them. The fix is runtime enforcement in the executor: hard-stop the coder at a configurable turn number if no completion JSON has been emitted, and enforce a per-attempt cost ceiling so a single failed attempt cannot consume the whole pipeline budget.
>
> **Read CLAUDE.md fully before writing any code.** Then read:
> - `packages/agents/src/executor.ts` — the turn loop, `MAX_TOOL_RESULT_CHARS`, `COMPACT_KEEP_RECENT`, the cost cap guard at the top of each turn
> - `packages/agents/src/coder.ts` — `maxTurns: 60`, `deferPostCompletionVerifyFromTurn`
> - `packages/engine/src/context.ts` — `BollardConfig`, `agent.max_cost_usd`
> - `packages/engine/src/runner.ts` — the retry loop and how `costTracker.add(lastResult.cost_usd)` accumulates across attempts
> - `packages/agents/prompts/coder.md` — the TURN 52 and TURN 58 signals (already there from Phase 7)

---

## Root cause analysis (do not skip)

Before writing any code, verify the chain of evidence:

```bash
# Confirm maxRetries on the implement node
grep -A3 '"implement"' packages/blueprints/src/implement-feature.ts | grep -E "maxRetries|onFailure"

# Confirm the executor's cost cap only fires at turn START (not mid-attempt)
grep -n "liveCostUsd\|capUsd\|COST_LIMIT" packages/agents/src/executor.ts

# Confirm how per-attempt cost flows into the aggregate tracker
grep -n "cost_usd\|costTracker\|add(" packages/engine/src/runner.ts | head -20
```

Expected findings:
- `implement` node has `maxRetries: 1` — so one retry is permitted after a 60-turn exhaustion
- Executor checks `liveCostUsd > capUsd` at the **start of each turn** using `ctx.pipelineCtx.costTracker.total() + totalCostUsd` — this correctly stops a single-agent run if the aggregate is over cap, but it cannot prevent a single attempt from burning $3.66 before the cap triggers
- Runner adds `lastResult.cost_usd` to `costTracker` **after each attempt** — so attempt 1's $3.66 is only committed to the aggregate tracker once attempt 1 finishes. During attempt 1, `costTracker.total()` reflects costs from prior nodes only, not the current attempt

The gap: a coder attempt has no ceiling of its own. It can spend arbitrarily until `maxTurns` is hit.

---

## What to change

### 9a — `packages/agents/src/executor.ts`: enforce a hard turn floor for completion

Add a runtime check at turn `N-8` (where N = `maxTurns`): if the agent has not yet emitted a stop reason of `end_turn` (i.e. no completion), inject a forced-completion message into the conversation.

```typescript
// After turn_end event, before processing tool results:
const hardExitTurn = agent.maxTurns - 8  // 8 turns before budget runs out

if (
  turns >= hardExitTurn &&
  response.stopReason === "tool_use" &&
  !hasEmittedCompletion
) {
  // Inject a hard exit message as a user turn — forces the LLM to wrap up
  messages.push({ role: "assistant", content: assistantBlocks })
  messages.push({
    role: "user",
    content: `SYSTEM: You have ${agent.maxTurns - turns} turns remaining. You MUST emit your completion JSON on your next response. Do not make any more tool calls. Emit the completion JSON now.`,
  })
  compactOlderTurns(messages)
  turns++
  continue
}
```

Track `hasEmittedCompletion` as a boolean that flips to `true` when `stopReason === "end_turn"` on any turn. The injected message is only sent once (add a `hasInjectedHardExit` guard).

Key design decisions:
- **`maxTurns - 8`**: leaves 8 turns of runway after the injection. The coder needs at most 2–3 turns to wrap up after receiving the signal. 8 is conservative.
- **Only fires when `stopReason === "tool_use"`**: if the agent already stopped naturally, no injection needed.
- **Only fires once**: `hasInjectedHardExit` flag prevents repeated injections that would waste turns.
- **The injected message is a `user` turn, not a system prompt change**: this is the most reliable way to interrupt mid-conversation — the LLM sees it as a new instruction in context.

### 9b — `packages/agents/src/executor.ts` + `packages/agents/src/types.ts`: add per-attempt cost cap

Add `maxCostUsd?: number` to `ExecutorOptions`. When set, throw `COST_LIMIT_EXCEEDED` if `totalCostUsd` (the current attempt's cost, not the aggregate) exceeds it:

```typescript
// In ExecutorOptions (types.ts):
maxCostUsd?: number  // per-attempt cost ceiling; independent of aggregate pipeline cap

// In executeAgent, at the top of the turn loop (after the aggregate cap check):
if (options?.maxCostUsd !== undefined && totalCostUsd > options.maxCostUsd) {
  throw new BollardError({
    code: "COST_LIMIT_EXCEEDED",
    message: `Per-attempt cost limit of $${options.maxCostUsd} exceeded in agent "${agent.role}" at turn ${turns + 1}`,
    context: {
      agentRole: agent.role,
      turn: turns + 1,
      attemptCostUsd: totalCostUsd,
      limitUsd: options.maxCostUsd,
    },
  })
}
```

### 9c — `packages/cli/src/agent-handler.ts`: wire per-attempt cap to the coder

The coder's per-attempt cap should be derived from the pipeline's aggregate cap: `maxCostUsd = config.agent.max_cost_usd / 2`. This reserves half the budget for the retry attempt and subsequent agents.

With `agent.max_cost_usd: 5`, this gives the coder `$2.50` per attempt — enough for a clean run (attempt 2 cost $1.28) and a hard stop before a runaway attempt can consume the whole pipeline budget.

```typescript
// In createAgenticHandler, when constructing options for the coder agent:
const coderMaxCostPerAttempt = config.agent.max_cost_usd / 2

// Pass to executeAgent:
options: {
  maxCostUsd: agentRole === "coder" ? coderMaxCostPerAttempt : undefined,
  // ... existing options
}
```

### 9d — `.bollard.yml`: raise aggregate cap to $10

The $5 cap was set before the retry-tax problem was understood. With Phase 8 context caps, a successful attempt costs ~$1.28. A failed attempt (now capped at $2.50 by 9b) + successful retry ($1.28) + all other agents (~$0.50 for planner/testers) = ~$4.28 worst case. The $5 cap is genuinely too tight for a two-attempt run. Raise it to $10 to give the full pipeline headroom while still catching runaway scenarios:

```yaml
agent:
  max_cost_usd: 10
```

This does NOT mean runs will cost $10. The per-attempt cap (9b) at $2.50 is the binding constraint on the coder. The $10 aggregate cap catches truly pathological scenarios.

---

## Tests to add

### `packages/agents/tests/executor.test.ts`

1. **Hard exit injection fires at `maxTurns - 8`**: create a mock provider that always returns `stopReason: "tool_use"` (never completes). Verify that at turn `maxTurns - 8`, a user message containing "SYSTEM: You have" is appended to messages. Verify it only fires once.

2. **Per-attempt cost cap**: use `BurnPerTurnProvider` pattern (each turn costs a fixed amount). Set `options.maxCostUsd: 0.03` with a `$0.01/turn` provider. Verify `COST_LIMIT_EXCEEDED` throws at turn 4 (after 3 turns totaling `$0.03`), not at `maxTurns`.

3. **Per-attempt cap is independent of aggregate cap**: set `options.maxCostUsd: 0.05` and `ctx.pipelineCtx.config.agent.max_cost_usd: 1.00`. Verify the per-attempt cap triggers first at the lower threshold.

4. **No injection when completion already emitted**: verify `hasInjectedHardExit` flag prevents a second injection if somehow the turn count reaches `maxTurns - 8` again (shouldn't happen in practice, but the guard should hold).

---

## CLAUDE.md update

Find the `Stage 5d Phase 7 (DONE)` entry. After it, add:

```
### Stage 5d Phase 9 (DONE) — Runtime Turn Enforcement + Per-Attempt Cost Cap:

Phase 7's prompt-level exit signals (TURN 52, TURN 58) were advisory — the 2026-05-15 validation showed the coder ignoring them under pressure, burning $3.66 on a failed 60-turn attempt. Phase 9 adds runtime enforcement: (9a) executor injects a forced-completion user message at `maxTurns - 8` if no `end_turn` stop has been seen yet; (9b) `ExecutorOptions.maxCostUsd` per-attempt cost ceiling — throws `COST_LIMIT_EXCEEDED` if a single attempt exceeds it; (9c) coder per-attempt cap wired to `config.agent.max_cost_usd / 2` ($2.50 at current settings); (9d) aggregate cap raised from $5 to $10 (per-attempt cap at $2.50 is the binding constraint; $10 catches pathological scenarios). Target: coder attempt cost < $2.50, total run cost < $4.00.
```

---

## Validation

```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test

# Verify constants and wiring:
grep "maxCostUsd\|per-attempt\|hardExitTurn" packages/agents/src/executor.ts
grep "max_cost_usd / 2\|coderMaxCost" packages/cli/src/agent-handler.ts
grep "max_cost_usd" .bollard.yml
# Expected: 10
```

Then run the Phase 8 validation self-test again using `scripts/bollard-metrics-run.sh`:

```bash
set -a && source .env && set +a
./scripts/bollard-metrics-run.sh "Add a snapshotTotal(): number method to CostTracker that returns the same value as total() at the moment of the call, without modifying any state. No parameters. Do not modify any existing methods or tests."
```

**VALIDATED criteria** (same as Phase 8 runbook):
- Cost < $3.00 (Admin API ground truth)
- Coder turns < 40 (across all attempts combined)
- No rollback
- 31/31 nodes completed

With Phase 9 in place, the worst case is: attempt 1 hits per-attempt cap at $2.50 (hard stop, rollback), attempt 2 completes in ~29 turns at ~$1.28. Total coder: ~$3.78. That's still above the $3 threshold if both the per-attempt cap and a retry fire. If the hard exit injection (9a) works as designed, attempt 1 should complete in <52 turns at <$1.60, and the total run lands well under $3.

If the validation still shows attempt 1 hitting the per-attempt cap: check what tool calls are driving the turn-over-turn context growth in the first 30 turns (the profile showed ~9K → ~30K over 60 turns; after Phase 8, attempt 2 plateaued at ~17K). That growth pattern on a single-method task suggests the coder is re-reading already-seen files or running tests repeatedly. That's a prompt/strategy issue to address in Phase 10.

---

## Constraints

- Do not change `COMPACT_KEEP_RECENT`, `MAX_TOOL_RESULT_CHARS`, or `MAX_LINES` — Phase 8 constants are validated and correct.
- Do not remove the TURN 52 / TURN 58 prompt signals from `coder.md` — they serve as soft guidance before the runtime gate fires. The runtime gate is the floor, the prompt signals are the ceiling.
- Do not set the per-attempt cap below `$2.00` — attempt 2 in the last run cost $1.28, and we need headroom for harder tasks.
- The injected hard-exit message must be a `user` role message, not a system prompt modification. System prompt changes mid-conversation are not supported by the API.
- `maxCostUsd` in `ExecutorOptions` is optional and defaults to `undefined` (no per-attempt cap) for all non-coder agents. Do not apply it to planner, boundary-tester, or other agents — their runs are already cheap.
