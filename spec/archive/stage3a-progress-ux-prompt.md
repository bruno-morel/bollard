# Stage 3a Follow-up — Agent Progress UX

> Make `bollard run implement-feature` feel alive. Today the CLI is silent for 30–120s at a stretch while an agent waits on an LLM call, so the terminal looks stuck. Fix: a spinner + per-turn telemetry + tool-call narration.
>
> **Scope:** Option A (see §1). No streaming refactor. No new CLI dependencies. No TUI library.

## Ground rules

- All commands run through `docker compose run --rm dev ...`.
- Strict TypeScript, no `any`, no new deps, named exports only, no semicolons.
- All existing tests must still pass. Add new tests for every new surface.
- Do not touch `@bollard/llm` provider code in this pass — streaming is explicitly out of scope (see §6 for why and what comes later).
- Do not break non-TTY output. CI logs and piped output must stay line-at-a-time and machine-readable.

## Root cause

Per-turn wait inside `executeAgent`:

```ts
const response = await provider.chat(request)   // ← 30–120s of silence
```

Between turns, `executor.ts` runs tools and loops. Neither the executor nor the CLI prints anything until a `node_complete` event fires, which can be 5+ minutes after `node_start`. The fix is to emit fine-grained events from the executor and render them in the CLI with an in-place spinner.

---

## 1. Design overview (Option A)

Add optional progress callbacks to `executeAgent` via `AgentContext.progress`. The executor fires events at three points:

| Event | When |
|-------|------|
| `turn_start` | Before each `chatWithRetry` call |
| `turn_end` | After the response is received (success path, after any retries) |
| `tool_call_start` | Just before a tool's `execute()` runs |
| `tool_call_end` | Just after the tool returns (success or error) |

The CLI's `agent-handler.ts` wires these callbacks to a lightweight `AgentSpinner` (new utility) that:
- In a TTY, redraws a single line in place: `⠋ coder · turn 7/60 · 0:43 · $0.18 · ↪ edit_file`
- In non-TTY, prints one line per event: `[coder] turn 7/60 started` / `[coder] turn 7/60 complete (43s, $0.04, edit_file×2)`

Between turns, while the LLM is computing, the spinner ticks every 80ms and updates the elapsed timer so the user can see something is happening. On every `tool_call_end` the spinner updates its "last tool" field.

**No changes to the engine runner.** The runner still emits node-level `ProgressEvent`s as it does today. Agent-level telemetry lives inside `AgentContext.progress` and is rendered by the CLI, not the engine. This keeps the kernel ignorant of agents (design principle #6 in CLAUDE.md).

---

## 2. File changes

### 2.1 `packages/agents/src/types.ts`

Add the progress event types and callback signature:

```typescript
export type AgentProgressEvent =
  | { type: "turn_start"; turn: number; maxTurns: number; role: string }
  | {
      type: "turn_end"
      turn: number
      maxTurns: number
      role: string
      durationMs: number
      costUsd: number
      inputTokens: number
      outputTokens: number
      toolCallsThisTurn: number
      stopReason: string
    }
  | { type: "tool_call_start"; turn: number; tool: string; input: Record<string, unknown> }
  | {
      type: "tool_call_end"
      turn: number
      tool: string
      durationMs: number
      ok: boolean
      error?: string
    }

export type AgentProgressCallback = (event: AgentProgressEvent) => void

export interface AgentContext {
  pipelineCtx: PipelineContext
  workDir: string
  allowedCommands?: string[]
  progress?: AgentProgressCallback   // NEW — optional, default no-op
}
```

`progress` is optional everywhere so no existing test or call site breaks.

### 2.2 `packages/agents/src/executor.ts`

Emit events at the four points listed in §1. Wrap the existing `provider.chat(...)` call with a start/end pair, and wrap each tool invocation with a start/end pair. Keep existing retry logic — progress events fire on the final (successful) attempt of a retry cycle, not on the intermediate failed attempts. Retries still print their existing warning line to stderr (don't remove that).

Rough shape:

```typescript
function emit(ctx: AgentContext, ev: AgentProgressEvent): void {
  try { ctx.progress?.(ev) } catch { /* never let a progress listener crash the executor */ }
}

// Inside the turn loop, just before chatWithRetry:
const turnStartedAt = Date.now()
emit(ctx, { type: "turn_start", turn: turnIndex, maxTurns: agent.maxTurns, role: agent.role })

const response = await chatWithRetry(provider, request, agent.role)

const turnDurationMs = Date.now() - turnStartedAt
emit(ctx, {
  type: "turn_end",
  turn: turnIndex,
  maxTurns: agent.maxTurns,
  role: agent.role,
  durationMs: turnDurationMs,
  costUsd: response.costUsd,
  inputTokens: response.usage.inputTokens,
  outputTokens: response.usage.outputTokens,
  toolCallsThisTurn: /* count tool_use blocks in response */,
  stopReason: response.stopReason,
})

// Inside the tool-execution loop:
const toolStartedAt = Date.now()
emit(ctx, { type: "tool_call_start", turn: turnIndex, tool: toolUse.toolName, input: toolUse.toolInput })
try {
  const output = await tool.execute(toolUse.toolInput, ctx)
  emit(ctx, {
    type: "tool_call_end",
    turn: turnIndex,
    tool: toolUse.toolName,
    durationMs: Date.now() - toolStartedAt,
    ok: true,
  })
  // ... existing logic to collect tool result ...
} catch (err) {
  emit(ctx, {
    type: "tool_call_end",
    turn: turnIndex,
    tool: toolUse.toolName,
    durationMs: Date.now() - toolStartedAt,
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  })
  throw err
}
```

Two invariants to preserve:
1. A `turn_end` fires for every `turn_start` that completes successfully. On an exception, no `turn_end` — the node will fail and the engine runner handles the error event.
2. Progress callbacks never throw into the executor. Wrap the `ctx.progress?.(...)` call in a try/catch that swallows listener errors silently (a badly written listener should never crash a pipeline run).

### 2.3 `packages/cli/src/spinner.ts` (NEW)

A ~100 LOC utility. No deps. Exports:

```typescript
export interface AgentSpinnerOptions {
  /** Stream to write to — default process.stderr */
  stream?: NodeJS.WritableStream
  /** Force enable/disable TTY mode. Default: auto-detect via stream.isTTY */
  tty?: boolean
  /** Frame interval in ms — default 80 */
  intervalMs?: number
}

export interface AgentSpinner {
  handleEvent(event: AgentProgressEvent): void
  /** Call between blueprint nodes or when the agent is done. Stops the ticker and clears the line. */
  finalize(): void
}

export function createAgentSpinner(opts?: AgentSpinnerOptions): AgentSpinner
```

Behavior:

- **TTY mode** (default when `stream.isTTY === true`):
  - Hold a mutable `SpinnerState { role, turn, maxTurns, startedAt, cumulativeCostUsd, lastTool, toolCallsThisTurn }`.
  - On `turn_start`, reset `startedAt`, `lastTool`, `toolCallsThisTurn`. Start a `setInterval` ticker at 80ms that calls a `redraw()` function.
  - `redraw()` writes `\r\x1b[2K` (clear line) then `⠋ ${role} · turn ${turn}/${maxTurns} · ${elapsed} · $${cost} · ${lastTool ?? "thinking..."}`. Use the standard braille spinner frames (10 frames: `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`).
  - Elapsed is formatted as `0:43` or `2:15` (mm:ss or m:ss).
  - On `tool_call_start`, update `lastTool` to `↪ ${tool}` and let the ticker pick it up on the next frame.
  - On `tool_call_end`, update `lastTool` to `✓ ${tool} ${durationMs}ms` for 500ms, then clear back to `thinking...` if no new tool has started. (Use a short `setTimeout` — clear it on any subsequent event.)
  - On `turn_end`, stop the ticker, clear the line, and print a finalized summary line: `  ✓ ${role} turn ${turn}/${maxTurns} · ${elapsed} · $${cost} · ${toolCallsThisTurn} tools` followed by `\n`.
  - Accumulate `cumulativeCostUsd` across turns.
  - `finalize()` stops any running ticker and clears the current line.

- **Non-TTY mode** (`stream.isTTY === false`, or forced via opts):
  - Print one line per `turn_start`: `[${role}] turn ${turn}/${maxTurns} starting`
  - Print one line per `turn_end`: `[${role}] turn ${turn}/${maxTurns} done in ${elapsed}s · $${cost} · ${toolCallsThisTurn} tools · stop=${stopReason}`
  - Print one line per `tool_call_end` (not `tool_call_start` to halve noise): `[${role}] turn ${turn} tool ${tool} ${ok ? "ok" : "FAILED"} ${durationMs}ms`
  - No spinner, no in-place updates, no ANSI escapes.

Reuse any existing color constants from `cli/src/index.ts` (GREEN, DIM, RESET, etc.) — don't redefine them.

Testing notes for the spinner unit tests: accept a `stream` option so tests can inject a `PassThrough` and read what was written. Accept a `tty` option to force mode. Accept an `intervalMs` option (tests set it to a large number to prevent ticker loops from racing against the test).

### 2.4 `packages/cli/src/agent-handler.ts`

In `createAgenticHandler`, create one `AgentSpinner` per node (not one per pipeline run — each agentic node gets a fresh one). Wire `ctx.progress = spinner.handleEvent` into the `AgentContext` passed to `executeAgent`. Call `spinner.finalize()` in a `finally` block so the spinner always cleans up even on agent failure.

```typescript
const spinner = createAgentSpinner()
const agentCtx: AgentContext = {
  pipelineCtx: ctx,
  workDir,
  allowedCommands: profile?.allowedCommands,
  progress: (ev) => spinner.handleEvent(ev),
}
try {
  const result = await executeAgent(agent, userMessage, provider, model, agentCtx, options)
  // ...
} finally {
  spinner.finalize()
}
```

Same treatment inside the standalone `plan` command in `cli/src/index.ts`. The one-shot planner invocation there should also get a spinner.

### 2.5 `packages/cli/src/index.ts`

One small change: when the existing `ProgressCallback` (from `@bollard/engine`) fires `node_start` for an agentic node, print the opening line **without** a trailing newline suppression — let the spinner take over the next line. And when `node_complete` fires, make sure the spinner has been finalized before the node-complete line is printed (agent-handler's `finally` block handles this; just make sure the ordering is right).

Nothing else in `index.ts` should need touching.

---

## 3. Tests

### 3.1 `packages/agents/tests/executor.progress.test.ts` (NEW)

- Progress callback receives `turn_start` and `turn_end` for each turn with correct turn numbers and maxTurns.
- Tool calls fire `tool_call_start` + `tool_call_end` in matched pairs.
- `tool_call_end` has `ok: false` and an `error` string when the tool throws.
- Retries on rate-limit produce a single `turn_start` + `turn_end` pair (no event noise from intermediate failed attempts).
- A listener that throws does not crash the executor — the agent still completes successfully, the error is swallowed.
- No `turn_end` fires if the turn is interrupted by a non-retryable error (the node will fail and the engine surfaces it).
- Backward compat: calling `executeAgent` without `ctx.progress` set still works (no crashes).

Use `MockProvider` for all these tests. No real LLM calls.

### 3.2 `packages/cli/tests/spinner.test.ts` (NEW)

- TTY mode: `handleEvent({turn_start})` starts the ticker and writes an initial frame. Advance mock timers; assert subsequent frames appear. Assert the line contains role/turn/elapsed.
- TTY mode: `tool_call_start` updates the `lastTool` field and the next redraw contains `↪ tool_name`.
- TTY mode: `turn_end` clears the line and prints a finalized summary containing `✓`, turn counter, elapsed, cost, and tool count.
- TTY mode: `finalize()` stops the ticker and clears.
- Non-TTY mode: same events produce one line per event, no ANSI escapes (assert with a regex that rejects `\x1b`).
- Cost accumulates across turns.
- Cumulative `$0.00` is displayed as `$0.00` not `$0` (two-decimal format).
- Elapsed formatting: 43s → `0:43`, 125s → `2:05`, 600s → `10:00`.

Use vitest's fake timers (`vi.useFakeTimers()`) for ticker tests. Use a `PassThrough` stream for the `stream` option. Force `tty: true` or `false` explicitly in each test.

### 3.3 Backward compat sweep

Run the full existing test suite. No existing test should need modification. If a test breaks, the change to that file is probably wrong — investigate before editing the test.

---

## 4. Design constraints and things to get right

### 4.1 No dependencies

No `ora`, no `chalk`, no `cli-progress`, no `blessed`, no `ink`. The whole spinner is ~100 lines of raw ANSI. CLAUDE.md principle #3: every dep must justify its existence; a 100-line spinner does not.

### 4.2 Non-TTY fallback is mandatory

CI runs, output piped to `tee`, output captured by Cursor's terminal emulation, and output captured by the MCP server all go through non-TTY paths. They must remain readable and greppable. The easiest way to verify: after implementing, run `bollard ... 2>&1 | cat` and confirm output is sane (no stray escape codes, no overwritten lines).

### 4.3 Preserve existing stderr writes

The rate-limit retry warning in `chatWithRetry` currently writes to stderr directly. Leave it alone. The spinner's ticker should not step on it — if a retry warning prints mid-turn, the next spinner frame will just redraw on a new line, which is fine.

### 4.4 Never let the spinner crash a pipeline

Wrap all `stream.write` calls in the spinner in a try/catch that silently swallows errors. A closed stream, an EPIPE, or a listener bug must not take down an `implement-feature` run.

### 4.5 No double-printing

When the engine's `onProgress` callback prints a `node_complete` line, the spinner for that node must already be finalized. The `finally` block in `agent-handler.ts` guarantees this because the agent returns before `node_complete` fires. Verify this ordering with a manual test.

### 4.6 Cost accumulation source of truth

The spinner's `cumulativeCostUsd` is display-only. The authoritative total still lives in `CostTracker`. Do not replace or bypass `CostTracker`. The spinner reads per-turn cost from the `turn_end` event and adds it to its own running total just for the display line.

### 4.7 Tool input rendering

Do NOT print full tool inputs in the spinner line — they can be huge (a `write_file` with 500 lines of content). Only print the tool name. If you want to be slightly informative, print the first path-like string from the input for `read_file` / `write_file` / `edit_file` / `list_dir`, truncated to 40 chars. Do not print arbitrary input fields.

---

## 5. Validation

1. `docker compose run --rm dev run typecheck` — zero errors.
2. `docker compose run --rm dev run lint` — zero errors.
3. `docker compose run --rm dev run test` — all tests pass, new count = baseline + (at least 10 new tests).
4. TTY smoke test, real LLM call:
   ```
   docker compose run --rm -e ANTHROPIC_API_KEY --filter @bollard/cli run start -- \
     plan --task "Add a debug log in cost-tracker" --work-dir /app
   ```
   Expected: spinner visible, turn counter advances, tool call narration appears, final summary line printed. No stuck periods longer than ~100ms between ticker frames.
5. Non-TTY smoke test:
   ```
   docker compose run --rm -e ANTHROPIC_API_KEY --filter @bollard/cli run start -- \
     plan --task "Add a debug log in cost-tracker" --work-dir /app 2>&1 | cat
   ```
   Expected: one line per event, no ANSI escape codes in the piped output, no overwritten lines.
6. Update the "Current Test Stats" section in `CLAUDE.md` with the new test count. Add a one-paragraph note about the spinner UX under a "Stage 3a follow-ups" subsection.

---

## 6. Future work — Option B (streaming) is on the Stage 3c roadmap

This pass explicitly does NOT add streaming responses. Reason: streaming touches all three LLM providers (Anthropic, OpenAI, Google), adds partial-response edge cases (rate limits mid-stream, tool calls arriving incrementally, malformed JSON from a truncated stream), and needs a new `LLMProvider.chat_stream` method with real test surface. That's 500–800 LOC of provider code and ~2 days of careful testing — worth doing, but not in a UX-polish pass.

Add the following entries to `CLAUDE.md` "DO NOT build yet" section so it's visible on the roadmap:

> **Streaming LLM responses (Stage 3c / 4 follow-up)** — `LLMProvider.chat_stream`, incremental delta events from `executeAgent`, CLI rendering of model reasoning in dim text as it arrives. Option B in `spec/stage3a-progress-ux-prompt.md` §1. Deferred because it requires provider-specific streaming implementations and partial-response error handling that we don't need for basic "feels alive" UX.

Also add a one-line pointer to this file in `spec/ROADMAP.md` under a "Stage 3c follow-ups" heading.

---

## 7. Stop conditions

Stop and surface a question if any of these happen:

- A new dependency seems necessary — it isn't, stop and re-read §4.1.
- Existing tests break in a way that isn't a trivial fixture/type update — investigate the behavior change before editing tests.
- The spinner causes visible tearing or flashes in the terminal — reduce the frame rate and/or use cursor save/restore instead of full line clear.
- Turn timing on a real LLM call looks wrong (elapsed counter lies) — probably a fake-timers leak from a test or a missed `clearInterval`. Fix the leak, don't mask the symptom.
- Any test has to be changed to accept a new stderr format — that's a signal the existing stderr contract was load-bearing for tests. Find out which test and decide whether to keep the old format too.
