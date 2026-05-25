---
name: fix-executor-hard-exit-tool-pairing
overview: "Fix the hard-exit injection in executeAgent to include stub tool_result blocks for every tool_use in the response, preventing the Anthropic 400 'tool_use id without matching tool_result' error on long coder runs."
todos:
  - id: step-1-fix-hard-exit-injection
    content: "Synthesize stub tool_result blocks alongside the forced-completion text when injecting the hard-exit message"
    status: pending
  - id: step-2-update-test
    content: "Update executor.test.ts to assert that the injected user message contains tool_result blocks matching the preceding assistant tool_use IDs"
    status: pending
  - id: step-3-self-check
    content: "Run typecheck, lint, test — expect ≥ 1154 passed / 6 skipped"
    status: pending
isProject: false
---

# Fix: hard-exit injection creates orphaned tool_use/tool_result pair

## Root cause

In `packages/agents/src/executor.ts` (lines 268–283), when the hard-exit fires
(`turns >= hardExitTurn`, `stopReason === "tool_use"`):

```typescript
hasInjectedHardExit = true
messages.push({ role: "assistant", content: response.content })  // has tool_use blocks
messages.push({
  role: "user",
  content: `SYSTEM: You have ${agent.maxTurns - turns} turns remaining...`,  // plain string — WRONG
})
```

Anthropic's API requires that every `tool_use` block in an assistant message be answered by a
`tool_result` block (with matching `toolUseId`) in the immediately following user message. Pushing
a plain-string user message after an assistant message with `tool_use` blocks violates this
constraint and produces:

```
400: tool_use id `toolu_xxx` does not have a corresponding tool_result in the next message
```

This was triggered by the clamp() self-test at turn ~53 of the coder (run `20260525-0019-run-45addb`,
`messages[106]`).

The existing unit test (executor.test.ts:261) uses a mock provider that never hits the Anthropic
API, so the pairing violation was never caught in CI.

## Fix

When the hard-exit fires, build the user message as a **content block array** (not a plain string):
1. One `tool_result` stub per `tool_use` block in `response.content` (matching `toolUseId`)
2. One `text` block with the forced-completion instruction

This satisfies Anthropic's pairing requirement while still delivering the forced-completion signal.

---

## Exact change — `executor.ts` lines 268–283

**Before:**
```typescript
if (
  turns >= hardExitTurn &&
  response.stopReason === "tool_use" &&
  !hasEmittedCompletion &&
  !hasInjectedHardExit
) {
  hasInjectedHardExit = true
  messages.push({ role: "assistant", content: response.content })
  messages.push({
    role: "user",
    content: `SYSTEM: You have ${agent.maxTurns - turns} turns remaining. You MUST emit your completion JSON on your next response. Do not make any more tool calls. Emit the completion JSON now.`,
  })
  compactOlderTurns(messages)
  turns++
  continue
}
```

**After:**
```typescript
if (
  turns >= hardExitTurn &&
  response.stopReason === "tool_use" &&
  !hasEmittedCompletion &&
  !hasInjectedHardExit
) {
  hasInjectedHardExit = true
  messages.push({ role: "assistant", content: response.content })
  // Anthropic requires every tool_use block to be answered by a tool_result in the
  // immediately following user message. Build stub tool_results + the forced-completion
  // instruction as a single content block array.
  const stubResults: LLMContentBlock[] = response.content
    .filter((b): b is LLMContentBlock & { type: "tool_use"; toolUseId: string } =>
      b.type === "tool_use" && typeof b.toolUseId === "string",
    )
    .map((b) => ({
      type: "tool_result" as const,
      toolUseId: b.toolUseId,
      text: "[forced completion — ignoring tool result]",
    }))
  stubResults.push({
    type: "text" as const,
    text: `SYSTEM: You have ${agent.maxTurns - turns} turns remaining. You MUST emit your completion JSON on your next response. Do not make any more tool calls. Emit the completion JSON now.`,
  })
  messages.push({ role: "user", content: stubResults })
  compactOlderTurns(messages)
  turns++
  continue
}
```

**Type note:** `LLMContentBlock` must support `type: "text"` with a `text` field. Confirm this is
already in the type definition before writing — check `packages/llm/src/types.ts`. If `text` blocks
are not yet part of `LLMContentBlock`, add them. The content block type likely already has this since
responses include text blocks.

---

## Step 2 — Update executor.test.ts

**File:** `packages/agents/tests/executor.test.ts`

The existing test at line 261 verifies that the hard-exit message is injected once. Extend it (or
add a sibling test) to also assert that:

1. The user message following the hard-exit assistant message is a **content block array** (not a
   plain string)
2. It contains `tool_result` blocks whose `toolUseId` values match the `tool_use` blocks in the
   preceding assistant message
3. It contains a `text` block with the forced-completion instruction

```typescript
it("hard-exit user message contains tool_result stubs matching preceding tool_use IDs", async () => {
  const toolUseIds: string[] = []
  let callId = 0
  const provider: LLMProvider = {
    name: "record-tool-loop",
    async chat(req: LLMRequest) {
      callId++
      const id = `id-${callId}`
      toolUseIds.push(id)
      return {
        content: [{ type: "tool_use", toolName: "noop", toolInput: {}, toolUseId: id }],
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
        costUsd: 0,
      }
    },
  }
  const agent = makeAgent([noopTool], { maxTurns: 10 })

  await expect(executeAgent(agent, "go", provider, "m", makeCtx())).rejects.toMatchObject({
    code: "NODE_EXECUTION_FAILED",
  })

  // Find the hard-exit injection turn in the recorded messages
  // The injected user message should be a content block array, not a plain string
  // Look through provider call transcripts for the pattern:
  // assistant message with tool_use → user message with tool_result + text blocks
  //
  // Since we can't directly inspect the internal messages array from outside,
  // verify indirectly: the provider should NOT receive a 400 error from Anthropic
  // (i.e., this test should not throw LLM_PROVIDER_ERROR).
  // The test passing without LLM_PROVIDER_ERROR validates the fix.
  //
  // For a stronger assertion, expose the message transcript via a spy on provider.chat
  // and check req.messages after the hard-exit injection point.
})
```

The simplest strong test: record all `req.messages` arrays passed to `provider.chat`, find the
turn where the hard-exit was injected, then assert the user message immediately following the
assistant message with `tool_use` is an array (not a string) and contains a `tool_result` entry.

Read the existing test at line 261 for the recording pattern — mirror it exactly.

---

## Step 3 — Self-check

```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

Expected:
1. `typecheck` — exit 0
2. `lint` — exit 0
3. `test` — **≥ 1154 passed / 6 skipped**

Also verify `git diff --stat` touches only:
- `packages/agents/src/executor.ts`
- `packages/agents/tests/executor.test.ts`

No changes to agent prompt files, blueprint nodes, or vitest configs.

---

## When GREEN — commit and retry self-test

Commit:
```
fix: hard-exit injection includes stub tool_results to satisfy Anthropic tool_use pairing
```

Then immediately retry the clamp() self-test:

```bash
docker compose run --rm -e BOLLARD_AUTO_APPROVE=1 dev sh -c \
  'pnpm --filter @bollard/cli run start -- run implement-feature \
  --task "Add a clamp(min: number, max: number): CostTracker method to CostTracker that clamps the current accumulated total to the range [min, max] in place and returns this for chaining. min must be >= 0 and <= max; both must be finite; throw BollardError with code CONTRACT_VIOLATION if either is negative, non-finite, or min > max. Do not modify any other existing methods or tests." \
  --work-dir /app' 2>&1 | tee .bollard/self-test-clamp.log
```

This is the validation gate — a successful full-forward 31/31 run without hitting the 400 error.

---

## Out of scope

- **DO NOT** change the hard-exit prompt text itself
- **DO NOT** change `compactOlderTurns` — it is not the cause
- **DO NOT** change `COMPACT_KEEP_RECENT` or `MAX_TOOL_RESULT_CHARS`
- **DO NOT** fix the coder scope-guard issue (editing test files, scratch files) — that is a
  separate prompt concern; the 400 error is the blocking issue

---

## Baseline

| Field | Value |
|-------|-------|
| Baseline test count | 1154 passed / 6 skipped |
| Failing run | `20260525-0019-run-45addb` — `LLM_PROVIDER_ERROR: 400 tool_use id without matching tool_result in the next message (messages[106])` |
| Root cause | Hard-exit injection at `hardExitTurn` pushed plain string user message after assistant message with `tool_use` blocks |
| Fix location | `packages/agents/src/executor.ts`, lines 268–283 |
