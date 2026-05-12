# Cursor Prompt — Stage 5d Phase 2: Verification-Feedback Patcher

> **Purpose:** The verification hook in `createVerificationHook` (`packages/cli/src/agent-handler.ts`) currently sends every failed check back to the frontier coder agent as a new turn. This means typecheck errors that Biome could auto-fix in one deterministic pass, or a missing semicolon that a 1.5B local model can patch, each consume an expensive frontier API call. Phase 2 inserts a two-stage pipeline between the check results and the frontier: (1) deterministic autofix (Biome `--write --unsafe`, structured `tsc` diagnostics), then (2) local model patcher (if `dev-local` is in use), and only escalates to the frontier coder if neither stage resolved all failures. This directly operationalizes ADR-0004's three-tier rule.

Read CLAUDE.md fully before writing any code. Then read:
- `spec/stage5d-token-economy.md` — Phase 2 design intent and three-tier rule
- `spec/adr/0004-determinism-local-frontier-tiers.md` — the rule that governs what goes deterministic vs. local vs. frontier
- `packages/cli/src/agent-handler.ts` — `createVerificationHook` (lines ~164–248) and how it's wired to `executeAgent`
- `packages/agents/src/types.ts` — `ExecutorOptions` interface: `postCompletionHook`, `maxVerificationRetries`
- `packages/agents/src/executor.ts` — how the hook is invoked, when retries are counted
- `packages/engine/src/errors.ts` — existing `BollardErrorCode` union
- `packages/llm/src/providers/local.ts` — `LocalProvider`, `isBinaryAvailable()`, `serializePrompt()`
- `packages/llm/src/client.ts` — `LLMClient.resolveProvider("local")`
- `packages/engine/src/context.ts` — `BollardConfig`, `LocalModelsConfig`

---

## What to change

### 1 — `packages/engine/src/errors.ts`: add two new error codes

Add to the `BollardErrorCode` union:

```typescript
| "PATCHER_PATCH_INVALID"   // local model returned something that isn't a parseable unified diff
| "PATCHER_NO_PROGRESS"     // patcher applied a patch but the same check still fails afterward
```

These are non-retryable (do not add them to `RETRYABLE_CODES`). They signal that the patcher tier failed silently and the hook should escalate to the frontier.

---

### 2 — `packages/verify/src/feedback-patcher.ts`: new file

Create `packages/verify/src/feedback-patcher.ts` with three exported functions:

#### 2a — `runDeterministicAutofix`

```typescript
export type AutofixResult =
  | { kind: "fixed"; fixedChecks: string[] }   // one or more checks now pass
  | { kind: "noop" }                            // nothing changed

export async function runDeterministicAutofix(
  workDir: string,
  failures: string[],       // the raw failure strings from the verification hook
  profile?: ToolchainProfile,
): Promise<AutofixResult>
```

Logic:

1. If `failures` includes a string containing `"lint"` or `"FAILED"` that originates from Biome/ESLint, run:
   ```bash
   biome check --write --unsafe .
   ```
   (via `execFile`). Capture stdout/stderr. This is a best-effort fire-and-forget — if it exits non-zero, that's fine, partial fixes still happen.

2. If `failures` includes a string from `"typecheck"`, run:
   ```bash
   tsc --noEmit --pretty false 2>&1
   ```
   Parse the structured diagnostic output. If there are zero errors after running `biome check --write --unsafe .` above, count that as fixed. **Do not** try to interpret tsc errors programmatically beyond detecting zero-error output — that's the local patcher's job.

3. Return `{ kind: "fixed", fixedChecks: [...] }` if any autofix tool ran without crashing and reduced the failure count, otherwise `{ kind: "noop" }`.

**Important:** `runDeterministicAutofix` never throws. It silently degrades — if `biome` isn't on PATH, skip Biome autofix. If `tsc` isn't on PATH, skip tsc re-check. Use `try/catch` around every `execFile` call.

#### 2b — `runLocalPatcher`

```typescript
export type PatcherResult =
  | { kind: "patched"; appliedChecks: string[] }  // patch applied successfully
  | { kind: "skipped"; reason: string }            // local tier not available or RAM below floor
  | { kind: "failed"; error: BollardError }        // patch was invalid or caused no progress

export async function runLocalPatcher(
  workDir: string,
  failures: string[],
  localModelsConfig: LocalModelsConfig | undefined,
): Promise<PatcherResult>
```

Logic:

1. Check `isBinaryAvailable()` from `@bollard/llm/src/providers/local.js`. If false, return `{ kind: "skipped", reason: "llama-cli binary not found" }`.

2. Check `checkRamFloor(localModelsConfig?.minFreeRamGb ?? 3)`. If false, return `{ kind: "skipped", reason: "insufficient free RAM" }`.

3. Build a tight prompt. The system prompt should be:
   ```
   You are a code repair assistant. Given failing check output, produce a minimal unified diff (--- a/path +++ b/path @@ ... @@) that fixes all reported errors. Output ONLY the diff, no explanation, no markdown fences.
   ```

   The user message should be:
   ```
   Fix these verification failures in the codebase at <workDir>:

   <failure output, truncated to 2000 chars per failure, max 3 failures>

   Output a unified diff only. If you cannot fix all failures in one diff, fix as many as you can.
   ```

4. Call `LocalProvider.chat(request)` with `model: localModelsConfig?.patcherModel ?? DEFAULT_MODEL_ID` and no tools. Use a short `maxTokens: 512` — patch diffs are small.

5. Extract the text response. Validate it contains `---` and `+++` and at least one `@@` hunk header. If not, return `{ kind: "failed", error: new BollardError({ code: "PATCHER_PATCH_INVALID", message: "local patcher did not return a valid unified diff" }) }`.

6. Apply the diff via:
   ```bash
   patch --strip=1 --forward --batch
   ```
   piping the diff string to stdin. If `patch` exits non-zero, treat as `PATCHER_PATCH_INVALID`.

7. Re-run only the failed checks to see if the patch helped. If the same check still fails, return `{ kind: "failed", error: new BollardError({ code: "PATCHER_NO_PROGRESS", message: "patch applied but check still fails" }) }`.

8. If at least one check now passes, return `{ kind: "patched", appliedChecks: [...] }`.

**LocalProvider instantiation:** Import `LocalProvider` from `@bollard/llm/src/providers/local.js` and construct it directly: `new LocalProvider(localModelsConfig)`. Do not go through `LLMClient` — the patcher is not a pipeline node and doesn't have a `BollardConfig` at this callsite.

**Error handling:** `runLocalPatcher` never throws. Any unexpected error becomes `{ kind: "failed", error: new BollardError({ code: "PATCHER_PATCH_INVALID", message: String(err) }) }`.

#### 2c — `buildPatcherFeedback`

```typescript
export function buildPatcherFeedback(
  remainingFailures: string[],
  autofixResult: AutofixResult,
  patcherResult: PatcherResult,
): string
```

Builds the failure message that the hook returns to the frontier coder when the patcher tiers couldn't fully resolve everything. The message should tell the coder:
- Which checks were auto-fixed (so it doesn't re-do that work)
- Which checks were patched by the local model (same)
- Which checks still need its attention

Example output:
```
The system ran verification checks automatically. Fix the following remaining issues:

## typecheck FAILED
<tsc output>

Note: biome lint was auto-fixed automatically (you do not need to address it).
Note: 1 issue was partially patched by the local model but still fails.
```

---

### 3 — `packages/cli/src/agent-handler.ts`: refactor `createVerificationHook`

Import `runDeterministicAutofix`, `runLocalPatcher`, `buildPatcherFeedback` from `@bollard/verify/src/feedback-patcher.js`.

The function signature gains a new optional parameter:

```typescript
function createVerificationHook(
  workDir: string,
  profile?: ToolchainProfile,
  localModelsConfig?: LocalModelsConfig,
): (text: string) => Promise<string | null>
```

The returned async function now does:

1. Run checks (same as today — collect `failures: string[]`).
2. If `failures.length === 0`, return `null` (pass — unchanged).
3. Run `runDeterministicAutofix(workDir, failures, profile)`.
4. Re-run only the checks that previously failed to see if autofix resolved any. Update `failures` to remove resolved checks.
5. If `failures.length === 0` after autofix, return `null`.
6. If `localModelsConfig` is defined, run `runLocalPatcher(workDir, failures, localModelsConfig)`. Update `failures` to remove patched checks. Log the patcher result to `process.stderr` (dim text).
7. If `failures.length === 0` after patching, return `null`.
8. Return `buildPatcherFeedback(failures, autofixResult, patcherResult)`.

The call site where `createVerificationHook` is invoked must now pass `config.localModels`:

```typescript
postCompletionHook: createVerificationHook(workDir, profile, config.localModels),
```

Find the existing call site in `agent-handler.ts` (where `ExecutorOptions` is assembled with `postCompletionHook`) and add the third argument.

---

### 4 — `packages/engine/src/context.ts`: add `patcherModel` field to `LocalModelsConfig`

The `LocalModelsConfig` interface needs one new optional field:

```typescript
patcherModel?: string  // defaults to DEFAULT_MODEL_ID ("qwen2.5-coder-1.5b-instruct-q4_k_m")
```

Add it to the interface and the Zod schema in `packages/cli/src/config.ts` (`localModelsYamlSchema`).

---

### 5 — `packages/cli/src/config.ts`: update `localModelsYamlSchema`

Add `patcherModel: z.string().optional()` to `localModelsYamlSchema`. This allows users to override which local model is used for patching (e.g. a larger quantization like `qwen2.5-coder-7b-instruct-q4_k_m` if they have more RAM).

---

### 6 — Tests: `packages/verify/tests/feedback-patcher.test.ts`

Create a test file with at least:

1. **`runDeterministicAutofix`:** 
   - Returns `{ kind: "noop" }` when `failures` is empty
   - Returns `{ kind: "noop" }` when `biome` is not on PATH (mock `execFile` to throw `ENOENT`)
   - Returns `{ kind: "fixed", fixedChecks: ["lint"] }` when biome exits 0 and re-run shows no lint failure

2. **`runLocalPatcher`:**
   - Returns `{ kind: "skipped", reason: "llama-cli binary not found" }` when `isBinaryAvailable()` returns false (mock it)
   - Returns `{ kind: "skipped", reason: "insufficient free RAM" }` when `checkRamFloor` returns false (mock `os.freemem` to return 0)
   - Returns `{ kind: "failed", error: ... }` with `PATCHER_PATCH_INVALID` when the model returns plain text with no diff markers
   - Does NOT throw under any circumstances (wraps all errors)

3. **`buildPatcherFeedback`:**
   - Includes "auto-fixed" note when autofix fixed some checks
   - Includes "patched by the local model" note when patcher helped
   - Lists only remaining failures in the "Fix the following" section

Use `vi.mock` for `isBinaryAvailable` and `checkRamFloor` — never call the real filesystem or spawn processes in unit tests.

---

### 7 — `CLAUDE.md`: update Stage 5d Phase 2 section

In the "Stage 5d Phase 2 (IN PROGRESS)" section within "Stage 5d (token economy)", update the description to mention the three-stage pipeline: deterministic autofix → local patcher → frontier escalation. Replace the placeholder "verification-feedback patcher" description with:

> **Phase 2 — Verification-Feedback Patcher (Tier 1→2→3 pipeline):** Intercepts coder hook failures before they reach the frontier. Three stages: (1) `runDeterministicAutofix` runs `biome check --write --unsafe` and re-checks — pure deterministic, zero tokens; (2) `runLocalPatcher` sends remaining failures to Qwen2.5-Coder-1.5B via `LocalProvider` with a tight patch prompt and applies the resulting unified diff via `patch --strip=1`; (3) only if failures remain does the frontier coder consume a retry turn. `maxVerificationRetries: 3` continues to count only frontier escalations. New error codes: `PATCHER_PATCH_INVALID`, `PATCHER_NO_PROGRESS`. Activated automatically when `dev-local` is in use and RAM floor is met; degrades gracefully to direct frontier escalation when local tier is absent.

---

## Validation

```bash
# Unit tests must pass:
docker compose run --rm dev run test

# Typecheck must be clean:
docker compose run --rm dev run typecheck

# Lint must be clean:
docker compose run --rm dev run lint

# Verify new test file exists:
docker compose run --rm dev sh -c 'test -f packages/verify/tests/feedback-patcher.test.ts && echo OK'

# Verify error codes are present:
docker compose run --rm dev sh -c 'grep -q PATCHER_PATCH_INVALID packages/engine/src/errors.ts && echo OK'
docker compose run --rm dev sh -c 'grep -q PATCHER_NO_PROGRESS packages/engine/src/errors.ts && echo OK'

# Verify new file exists:
docker compose run --rm dev sh -c 'test -f packages/verify/src/feedback-patcher.ts && echo OK'
```

No Bollard-on-Bollard self-test for this change — it is infrastructure-only (the patcher tier only activates inside coder verification hooks, which are exercised during live pipeline runs with `ANTHROPIC_API_KEY`).

---

## Constraints

- **`runDeterministicAutofix` and `runLocalPatcher` never throw.** Both must catch all errors internally and degrade gracefully. The frontier coder turn is the fallback of last resort — patcher errors must never break the pipeline.
- **`LocalProvider` is instantiated directly** in `runLocalPatcher` — do not use `LLMClient` here. The patcher is a utility function, not a pipeline node.
- **`maxVerificationRetries: 3` semantics are unchanged** — the counter is owned by the executor and counts hook return-non-null events. The patcher tiers that return `null` (resolved) never increment the counter.
- **No new package dependencies.** `patch` (GNU patch) is already present in the `dev` image (part of `build-essential` or available via `apt`). `biome` is already a dev dependency. No new installs.
- **`patcherModel` defaults to `DEFAULT_MODEL_ID`** exported from `local.ts`. Do not hardcode the string — import the constant.
- **Tests mock the binary and RAM checks.** Unit tests for `runLocalPatcher` must mock `isBinaryAvailable` and `checkRamFloor` so they pass on `dev` (where llama-cli is absent). Use `vi.mock('@bollard/llm/src/providers/local.js', ...)`.
- **Keep `feedback-patcher.ts` in `@bollard/verify`**, not in `@bollard/cli`. The patcher is a verification utility — it should be testable without CLI infrastructure.
