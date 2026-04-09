# Stage 3c Workstream 2: Blueprint node + config wiring

> **Goal:** Add the `run-mutation-testing` node to the `implement-feature` blueprint, wire `MutationConfig` through `.bollard.yml` parsing and `detectToolchain`, and update all affected tests. This is the integration workstream — WS1 built the provider; WS2 plugs it into the pipeline.

## Context

Read these files before writing any code:

- `CLAUDE.md` (root) — project conventions, tech stack, Docker rules
- `spec/stage3c-plan.md` — full Stage 3c plan (this workstream is WS2)
- `packages/blueprints/src/implement-feature.ts` — the 18-node blueprint (mutation node inserts after `run-contract-tests`, before `docker-verify`)
- `packages/blueprints/tests/implement-feature.test.ts` — node order and type assertions (must update to 19 nodes)
- `packages/verify/src/mutation.ts` — `runMutationTesting`, `MutationTestResult` (created in WS1)
- `packages/detect/src/types.ts` — `MutationConfig`, `ToolchainProfile`
- `packages/engine/src/context.ts` — `PipelineContext.mutationScore`
- `packages/engine/src/errors.ts` — `MUTATION_THRESHOLD_NOT_MET`
- `packages/cli/src/config.ts` — config resolution (`resolveConfig`, `.bollard.yml` parsing)
- `packages/cli/src/adversarial-yaml.ts` — YAML adversarial config parsing pattern
- `packages/cli/src/index.ts` — CLI entry point (mutation display placeholder at line ~612)

## Step 1: Add `run-mutation-testing` node to the blueprint

**File:** `packages/blueprints/src/implement-feature.ts`

Add a new import at the top:

```typescript
import { runMutationTesting } from "@bollard/verify/src/mutation.js"
```

Insert a new node **after** `run-contract-tests` (currently node index 14, id `run-contract-tests`) and **before** `docker-verify` (currently node index 15, id `docker-verify`). The node goes at array position 15 (0-indexed), bumping `docker-verify` to 16, `generate-diff` to 17, `approve-pr` to 18.

```typescript
{
  id: "run-mutation-testing",
  name: "Mutation Testing",
  type: "deterministic",
  execute: async (ctx: PipelineContext): Promise<NodeResult> => {
    const profile = ctx.toolchainProfile
    if (!profile?.mutation?.enabled) {
      return {
        status: "ok",
        data: { skipped: true, reason: "mutation testing not enabled" },
      }
    }

    const startMs = Date.now()
    const result = await runMutationTesting(workDir, profile)
    ctx.mutationScore = result.score

    ctx.log.info("mutation_testing_result", {
      event: "mutation_testing_result",
      runId: ctx.runId,
      score: result.score,
      killed: result.killed,
      survived: result.survived,
      noCoverage: result.noCoverage,
      timeout: result.timeout,
      totalMutants: result.totalMutants,
      duration_ms: result.duration_ms,
    })

    const threshold = profile.mutation.threshold
    if (result.totalMutants > 0 && result.score < threshold) {
      return {
        status: "fail",
        data: result,
        error: {
          code: "MUTATION_THRESHOLD_NOT_MET",
          message: `Mutation score ${result.score.toFixed(1)}% is below threshold ${threshold}% (${result.survived} survived, ${result.noCoverage} no coverage)`,
        },
      }
    }

    return {
      status: "ok",
      data: result,
      cost_usd: 0,
      duration_ms: Date.now() - startMs,
    }
  },
},
```

**Key behaviors:**
- Skips cleanly when `mutation?.enabled` is falsy (opt-in for Stage 3c)
- Sets `ctx.mutationScore` on the pipeline context
- Emits a structured `mutation_testing_result` log event (same pattern as `contract_grounding_result`)
- Fails with `MUTATION_THRESHOLD_NOT_MET` only when there are actual mutants AND score < threshold (a run with 0 mutants is OK — it just means no mutable code was touched)
- Duration is tracked for the progress callback

## Step 2: Wire `MutationConfig` in CLI config resolution

**File:** `packages/cli/src/config.ts`

The `resolveConfig` function (or wherever `ToolchainProfile` is assembled from `.bollard.yml`) needs to parse the `mutation:` section from YAML and merge it into the profile.

Add parsing for the `.bollard.yml` `mutation:` block:

```yaml
# Example .bollard.yml
mutation:
  enabled: true
  tool: stryker       # default: stryker for TS/JS
  threshold: 80       # default: 80
  timeoutMs: 300000   # default: 300000
  concurrency: 2      # default: 2
```

In the config resolution logic, after the existing `toolchain` and `adversarial` parsing:

```typescript
// Parse mutation config from YAML
const yamlMutation = yamlConfig?.mutation as Record<string, unknown> | undefined
if (yamlMutation) {
  const tool = typeof yamlMutation.tool === "string" ? yamlMutation.tool : "stryker"
  profile.mutation = {
    enabled: yamlMutation.enabled !== false,  // default true when section present
    tool: tool as MutationToolId,
    threshold: typeof yamlMutation.threshold === "number" ? yamlMutation.threshold : 80,
    timeoutMs: typeof yamlMutation.timeoutMs === "number" ? yamlMutation.timeoutMs : 300_000,
    concurrency: typeof yamlMutation.concurrency === "number" ? yamlMutation.concurrency : 2,
  }
}
```

**Important:** When the `mutation:` section is absent from `.bollard.yml`, `profile.mutation` remains `undefined` and the blueprint node skips. This is the opt-in behavior for Stage 3c. (In Stage 4+ the plan is to auto-detect and default-enable, but that's not this workstream.)

Also import `MutationConfig` if needed:
```typescript
import type { MutationConfig, MutationToolId, ToolchainProfile } from "@bollard/detect/src/types.js"
```

## Step 3: Auto-detect Stryker in TypeScript detector

**File:** `packages/detect/src/languages/typescript.ts`

When detecting a TypeScript project, check if `@stryker-mutator/core` is in `devDependencies` (from `package.json`). If found, populate `mutation`:

```typescript
// Inside the detect function, after existing detection logic:
const packageJson = JSON.parse(await readFile(resolve(cwd, "package.json"), "utf-8"))
const devDeps = packageJson.devDependencies ?? {}
if (devDeps["@stryker-mutator/core"]) {
  profile.mutation = {
    enabled: true,
    tool: "stryker",
    threshold: 80,
    timeoutMs: 300_000,
    concurrency: 2,
  }
}
```

This follows principle #10: "Detection is deterministic — file exists → tool detected." If `@stryker-mutator/core` is in `devDependencies`, Stryker is detected. Same pattern as how the test framework and linter are detected.

**Note:** Only add this to the TypeScript detector. Python, Go, Rust detectors get mutation detection in their respective stages (3c-b, 3c-c). Don't add stryker detection to `javascript.ts` unless it's trivial — Stryker supports JS but the primary target is TS.

## Step 4: Update CLI output

**File:** `packages/cli/src/index.ts`

Find the placeholder line (around line 612):
```typescript
log(`  Layer 3 (mutation testing):  ${DIM}(Stage 3+)${RESET}`)
```

Replace it to show actual mutation config when detected:

```typescript
if (profile.mutation?.enabled) {
  log(`  Layer 3 (mutation testing):  ${BRIGHT}${profile.mutation.tool} (threshold: ${profile.mutation.threshold}%, concurrency: ${profile.mutation.concurrency})${RESET}`)
} else {
  log(`  Layer 3 (mutation testing):  ${DIM}not configured${RESET}`)
}
```

## Step 5: Update tests

### 5a. Blueprint test — `packages/blueprints/tests/implement-feature.test.ts`

Update the node order test:
- Change `toHaveLength(18)` → `toHaveLength(19)`
- Add `"run-mutation-testing"` after `"run-contract-tests"` in the expected array
- Add `{ id: "run-mutation-testing", type: "deterministic" }` in the types test

### 5b. Blueprint mutation node test — `packages/blueprints/tests/implement-feature.mutation.test.ts` (new file)

Create a new test file for the mutation node specifically (same pattern as `implement-feature.risk-gate.test.ts`):

```typescript
import { describe, expect, it, vi } from "vitest"
```

Mock `@bollard/verify/src/mutation.js` with `vi.hoisted` + `vi.mock`.

Test cases:

1. **Skips when mutation not enabled** — `profile.mutation` is undefined → returns `{ status: "ok", data: { skipped: true } }`, `runMutationTesting` not called.

2. **Skips when mutation.enabled is false** — `profile.mutation.enabled = false` → skipped.

3. **Sets ctx.mutationScore on success** — mock `runMutationTesting` returns `{ score: 85, killed: 17, survived: 3, ... }` → `ctx.mutationScore === 85`.

4. **Fails with MUTATION_THRESHOLD_NOT_MET when below threshold** — mock returns `{ score: 60, totalMutants: 10, ... }`, threshold is 80 → status `"fail"`, error code `"MUTATION_THRESHOLD_NOT_MET"`.

5. **Passes with zero mutants even if score is 0** — mock returns `{ score: 0, totalMutants: 0, ... }` → status `"ok"` (no mutable code is not a failure).

6. **Emits mutation_testing_result log event** — spy on `ctx.log.info`, assert it was called with `"mutation_testing_result"` and the expected fields.

Use a `makeCtx` helper that builds a minimal `PipelineContext` with the `log` spy and `toolchainProfile`:

```typescript
function makeCtx(profile: ToolchainProfile): PipelineContext {
  return {
    runId: "test-run",
    task: "test task",
    blueprintId: "test",
    config: { llm: { provider: "anthropic", model: "test" } },
    currentNode: "run-mutation-testing",
    results: {},
    changedFiles: [],
    costTracker: { /* minimal mock */ },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as PipelineContext
}
```

### 5c. Config test — `packages/cli/tests/config.test.ts`

Add test cases for mutation config parsing:

7. **Parses mutation section from .bollard.yml** — YAML with `mutation: { enabled: true, tool: stryker, threshold: 90 }` → profile has correct `MutationConfig`.

8. **Defaults threshold/concurrency when mutation section is minimal** — YAML with only `mutation: { enabled: true }` → threshold defaults to 80, concurrency to 2.

9. **No mutation config when section absent** — YAML without `mutation:` → `profile.mutation` is undefined.

### 5d. Detect test — `packages/detect/tests/detect.test.ts`

If there's an existing TS detection test, add one case:

10. **Detects Stryker from devDependencies** — fixture `package.json` with `@stryker-mutator/core` in `devDependencies` → `profile.mutation.tool === "stryker"`, `profile.mutation.enabled === true`.

## Constraints

- **No default exports.** Named exports only.
- **No `any`.** Use `unknown` and narrow.
- **No semicolons.** Biome enforces this.
- **Import paths:** Use `.js` extensions.
- **Error handling:** Use `BollardError` for threshold failures. The node returns `status: "fail"` with a `NodeResultError` — it does NOT throw.
- **Run tests via Docker:** `docker compose run --rm dev run test` after all changes.
- **Run typecheck + lint:** `docker compose run --rm dev run typecheck && docker compose run --rm dev run lint`

## Expected output

| Metric | Expected |
|--------|----------|
| New files | 1 (`implement-feature.mutation.test.ts`) |
| Changed files | ~5 (`implement-feature.ts`, `implement-feature.test.ts`, `config.ts`, `typescript.ts`, `index.ts`) |
| Test count delta | +10 (6 blueprint mutation + 3 config + 1 detect) |
| Node count | 18 → 19 |
| Typecheck | Clean |
| Lint | Clean |

## Commit

```
Stage 3c: run-mutation-testing blueprint node + config wiring + Stryker detection
```

Single commit. Include all changed and new files.
