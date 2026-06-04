# Cursor Prompt — Stage 5e Phase 2: Coder Turn Reduction

> **Purpose:** The remaining() self-test run (`20260602-0246-run-73c18b`) spent 54 turns / $2.98 on a
> simple single-method task. The implementation was done by turn 5. Turns 34–53 were pure diagnostic
> churn: the coder called `npm test` (blocked), switched to `pnpm test` (ran), ran `tsc --noEmit`
> twice, then looped on test variants 6 more times trying to diagnose failures — hitting
> `MAX_TEST_INVOCATIONS = 5` only late. Two root causes:
>
> 1. **`MAX_TEST_INVOCATIONS = 5` is too high.** 5 test runs × multi-turn diagnosis = 10–15 wasted
>    turns before the hard stop fires. Lowering to 3 cuts the diagnostic loop early.
>
> 2. **The `DEFAULT_ALLOWED_COMMANDS` list is hardcoded to `pnpm`.** Projects using npm, yarn, or
>    bun get the wrong package manager blocked, the right one missing. The coder in the self-test
>    tried `npm` first, got a tool error, then switched to `pnpm` — wasting a turn. The allowlist
>    should be derived from `profile.packageManager` so it's correct by detection.

Read `CLAUDE.md` fully before writing any code. Then read:
- `packages/agents/src/tools/run-command.ts` — `MAX_TEST_INVOCATIONS`, `DEFAULT_ALLOWED_COMMANDS`,
  `isTestCommand`, `execute` function
- `packages/agents/src/types.ts` — `AgentContext`, `allowedCommands?: string[]`
- `packages/cli/src/agent-handler.ts` — where `agentCtx` is built (~line 658), specifically the
  `allowedCommands` assignment from `profile.allowedCommands`
- `packages/detect/src/types.ts` — `ToolchainProfile`, `PackageManagerId`, `allowedCommands: string[]`
- `packages/agents/tests/tools.test.ts` — existing `MAX_TEST_INVOCATIONS` tests to understand
  what to update

---

## Goal

Three changes, all in existing files. No new files needed.

1. **Lower `MAX_TEST_INVOCATIONS` from 5 to 3** in `run-command.ts`
2. **Make `DEFAULT_ALLOWED_COMMANDS` profile-driven** — derive from `profile.packageManager` when
   available; fall back to the current hardcoded list for backward compatibility
3. **Add `ls` to `DEFAULT_ALLOWED_COMMANDS`** — it was added post-run as a known gap (CLAUDE.md:
   "`ls` added to `DEFAULT_ALLOWED_COMMANDS` post-run")

No changes to: blueprint nodes, executor, planner prompt, agent prompts (coder.md already has the
`{{packageManager}}` rule added separately).

---

## Step 1 — `packages/agents/src/tools/run-command.ts`

### 1a — Lower `MAX_TEST_INVOCATIONS`

Change line 11:
```typescript
const MAX_TEST_INVOCATIONS = 5
```
to:
```typescript
const MAX_TEST_INVOCATIONS = 3
```

### 1b — Add `ls` to `DEFAULT_ALLOWED_COMMANDS`

Add `"ls"` to the `DEFAULT_ALLOWED_COMMANDS` array (line ~130). Keep alphabetical order:
```typescript
const DEFAULT_ALLOWED_COMMANDS = [
  "biome",
  "cat",
  "diff",
  "git",
  "head",
  "ls",
  "node",
  "npx",
  "pnpm",
  "rm",
  "tail",
  "tsc",
  "wc",
]
```

### 1c — Make `isTestCommand` profile-aware

`isTestCommand` currently only checks for `pnpm`/`vitest`/`npx`. Extend it to also check for
`npm`, `yarn`, and `bun` as test runners — so the invocation counter fires correctly for non-pnpm
projects too:

```typescript
export function isTestCommand(parts: string[]): boolean {
  const cmd = parts[0]
  // pnpm
  if (cmd === "pnpm") {
    if (parts[1] === "test") return true
    if (parts[1] === "run" && parts[2] === "test") return true
    if (parts[1] === "exec" && parts[2] === "vitest") return true
  }
  // npm / yarn / bun — same test subcommand pattern
  if ((cmd === "npm" || cmd === "yarn" || cmd === "bun") && parts[1] === "test") return true
  if ((cmd === "npm" || cmd === "yarn" || cmd === "bun") && parts[1] === "run" && parts[2] === "test") return true
  // bare runners
  if (cmd === "vitest") return true
  if (cmd === "npx" && parts[1] === "vitest") return true
  if (cmd === "pytest") return true
  if (cmd === "cargo" && parts[1] === "test") return true
  if (cmd === "go" && parts[1] === "test") return true
  return false
}
```

### 1d — Profile-driven allowlist in `execute`

Replace the static `DEFAULT_ALLOWED_COMMANDS` reference with a function that builds the allowlist
from context. Add this helper above `runCommandTool`:

```typescript
/**
 * Build the allowed command list for a coder session.
 * Uses ctx.allowedCommands when set by the caller (profile-driven path).
 * Falls back to DEFAULT_ALLOWED_COMMANDS + the project's package manager
 * derived from ctx.pipelineCtx.toolchainProfile when available.
 */
function resolveAllowedCommands(ctx: AgentContext): string[] {
  if (ctx.allowedCommands !== undefined) return ctx.allowedCommands
  const pm = ctx.pipelineCtx.toolchainProfile?.packageManager
  if (pm === undefined) return DEFAULT_ALLOWED_COMMANDS
  // Add the detected package manager if not already in the default list
  const base = DEFAULT_ALLOWED_COMMANDS.includes(pm)
    ? DEFAULT_ALLOWED_COMMANDS
    : [...DEFAULT_ALLOWED_COMMANDS, pm]
  return base
}
```

Then replace the single usage (line ~202):
```typescript
const allowed = ctx.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS
```
with:
```typescript
const allowed = resolveAllowedCommands(ctx)
```

---

## Step 2 — `packages/cli/src/agent-handler.ts`

The `agentCtx` builder already has:
```typescript
...(profile?.allowedCommands ? { allowedCommands: profile.allowedCommands } : {}),
```

This passes `profile.allowedCommands` (the full list from detect) when present. That's correct —
`ToolchainProfile.allowedCommands` is already populated by `detectToolchain` per language. No
change needed here.

**Verify** (read, don't change): confirm `profile.allowedCommands` for a TypeScript project includes
`pnpm` and the standard list. If it doesn't include the package manager, update the allowedCommands
derivation in `agent-handler.ts` instead:

```typescript
// If profile.allowedCommands is empty or undefined, derive from packageManager
const profileCommands = profile?.allowedCommands?.length
  ? profile.allowedCommands
  : profile?.packageManager
    ? [...DEFAULT_ALLOWED_COMMANDS_FROM_RUN_COMMAND, profile.packageManager]
    : undefined
```

Only make this change if reading the code confirms `profile.allowedCommands` does NOT already
include the package manager. Do NOT import `DEFAULT_ALLOWED_COMMANDS` from `run-command.ts` into
`agent-handler.ts` — keep them decoupled. If the profile path already works, skip Step 2 entirely.

---

## Step 3 — Update tests

**File:** `packages/agents/tests/tools.test.ts`

Find the existing tests for `MAX_TEST_INVOCATIONS` (currently testing limit of 5) and update them
to the new limit of 3. The test names will change from "5 times" to "3 times". Search for
`testInvocationCount` or `MAX_TEST_INVOCATIONS` in the test file to find them.

Also add 2 new tests for `isTestCommand`:
1. `npm test` returns `true`
2. `cargo test` returns `true`

And 1 new test for `resolveAllowedCommands` behavior:
- When `ctx.pipelineCtx.toolchainProfile.packageManager === "yarn"` and `ctx.allowedCommands` is
  undefined, `yarn` appears in the resolved allowlist

---

## Self-check

Run sequentially. Do NOT declare done until all pass.

1. `docker compose run --rm dev run typecheck` — exit 0
2. `docker compose run --rm dev run lint` — exit 0
3. `docker compose run --rm dev run test` — all pass; count ≥ 1397 (1394 + ≥ 3 new)
4. Grep `MAX_TEST_INVOCATIONS` in `run-command.ts` — must equal `3`
5. Grep `"ls"` in `DEFAULT_ALLOWED_COMMANDS` in `run-command.ts` — must be present
6. `git diff --stat HEAD -- packages/agents/prompts packages/blueprints/src` — empty

---

## When GREEN — doc updates

- In `CLAUDE.md`: update the `ls` note ("added post-run") to reference this phase. Add note:
  "`MAX_TEST_INVOCATIONS` lowered 5→3 (Stage 5e Phase 2); `isTestCommand` extended to npm/yarn/bun/
  pytest/cargo/go; `resolveAllowedCommands` derives from `ctx.pipelineCtx.toolchainProfile.packageManager`
  when `ctx.allowedCommands` is not set."
- In `spec/ROADMAP.md`: strike through "Coder turn reduction on multi-step tasks (Phase 2)" under
  Stage 5e, noting profile-driven allowlist and `MAX_TEST_INVOCATIONS` lowered to 3.
- Move this file to `spec/archive/prompts/stage5e-phase2-coder-turn-reduction.md`

---

## Out of scope

- DO NOT change `maxTurns` (already 60, enforced by runtime hard-exit at turn 52)
- DO NOT add a "verification failed short-circuit" — the existing `createVerificationHook` already
  returns structured feedback via `buildPatcherFeedback`; the problem was the coder ignoring it and
  running more tests instead. Lowering `MAX_TEST_INVOCATIONS` to 3 is the right lever.
- DO NOT touch `coder.md` — the `{{packageManager}}` rule was already added
- DO NOT change `AgentContext` type — `allowedCommands` is already optional there
- DO NOT add any LLM calls
