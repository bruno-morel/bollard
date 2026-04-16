# Stage 3c Workstream 5: Scope-aware mutation targeting

> **Goal:** Make the `run-mutation-testing` node only mutate files the coder actually changed, cutting mutation runs from 16+ minutes (full repo) to seconds (a few files). This is the difference between mutation testing being a pipeline curiosity and being usable in real runs.

## Context

Read these files before writing any code:

- `CLAUDE.md` (root) — project conventions
- `packages/verify/src/mutation.ts` — `MutationTestingProvider`, `StrykerProvider`, `runMutationTesting`, `deriveMutatePatterns`
- `packages/verify/tests/mutation.test.ts` — existing 13 tests
- `packages/blueprints/src/implement-feature.ts` — `run-mutation-testing` node + `getAffectedSourceFiles`
- `packages/blueprints/tests/implement-feature.mutation.test.ts` — existing 6 tests

## The problem

Currently `StrykerProvider.run()` generates a `mutate` array from `profile.sourcePatterns`, which covers the entire repo (e.g., `packages/*/src/**/*.ts`). Stryker then generates thousands of mutants across all source files, taking 16+ minutes on Bollard's codebase. In a pipeline run, we only care about mutations in the files the coder just changed — if a pre-existing mutant survived before, that's not a regression from this change.

## Step 1: Add optional `mutateFiles` to the provider interface

**File:** `packages/verify/src/mutation.ts`

Change the `MutationTestingProvider` interface:

```typescript
export interface MutationTestingProvider {
  readonly language: LanguageId
  run(workDir: string, profile: ToolchainProfile, mutateFiles?: string[]): Promise<MutationTestResult>
}
```

And update `runMutationTesting` to accept and thread through the parameter:

```typescript
export async function runMutationTesting(
  workDir: string,
  profile: ToolchainProfile,
  mutateFiles?: string[],
): Promise<MutationTestResult> {
  // ... existing checks ...
  return provider.run(workDir, profile, mutateFiles)
}
```

## Step 2: Use `mutateFiles` in `StrykerProvider` config generation

**File:** `packages/verify/src/mutation.ts`

In `StrykerProvider.run()`, when `mutateFiles` is provided and non-empty, use those files directly as the `mutate` array instead of calling `deriveMutatePatterns`:

```typescript
async run(workDir: string, profile: ToolchainProfile, mutateFiles?: string[]): Promise<MutationTestResult> {
  const startMs = Date.now()
  const reportPath = join(workDir, "reports", "mutation", "mutation.json")

  // Scope-aware: if specific files given, mutate only those
  const mutatePatterns = mutateFiles && mutateFiles.length > 0
    ? mutateFiles
    : deriveMutatePatterns(profile)

  const config = {
    testRunner: "vitest",
    vitest: {
      configFile: deriveVitestConfigFile(profile),
    },
    mutate: mutatePatterns,
    // ... rest unchanged
  }
  // ...
}
```

When `mutateFiles` is provided, we pass the exact relative file paths (e.g., `["packages/engine/src/cost-tracker.ts"]`). Stryker accepts both glob patterns and exact paths in the `mutate` array.

**Important:** Do NOT add test-file exclusion patterns when using exact file paths — `getAffectedSourceFiles` already filters out test files. Adding `!**/*.test.ts` negation patterns alongside exact paths would cause Stryker to interpret them incorrectly.

## Step 3: Wire affected files into the blueprint node

**File:** `packages/blueprints/src/implement-feature.ts`

In the `run-mutation-testing` node, get the affected source files and pass them to `runMutationTesting`:

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

    // Scope mutation to only the files the coder changed
    const affectedFiles = getAffectedSourceFiles(ctx)

    const startMs = Date.now()
    const result = await runMutationTesting(
      workDir,
      profile,
      affectedFiles.length > 0 ? affectedFiles : undefined,
    )

    // ... rest unchanged (ctx.mutationScore, log event, threshold check)
  },
},
```

When `affectedFiles` is empty (e.g., no plan, or plan has no affected_files), we pass `undefined` and fall back to the full-repo `sourcePatterns` — same behavior as before WS5.

Also add `affectedFiles` and `scopedToFiles` to the log event so we can see whether scoping kicked in:

```typescript
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
  scopedToFiles: affectedFiles.length > 0,
  affectedFileCount: affectedFiles.length,
})
```

## Step 4: Update tests

### 4a. Provider tests — `packages/verify/tests/mutation.test.ts`

Add/update these test cases:

1. **Uses mutateFiles when provided** — call `StrykerProvider.run(workDir, profile, ["src/foo.ts"])`. Assert the written `stryker.config.json` has `mutate: ["src/foo.ts"]` (NOT the full sourcePatterns).

2. **Falls back to sourcePatterns when mutateFiles is empty** — call with `mutateFiles: []`. Assert the written config uses `deriveMutatePatterns(profile)`.

3. **Falls back to sourcePatterns when mutateFiles is undefined** — call with `mutateFiles: undefined`. Same as above.

4. **runMutationTesting threads mutateFiles to provider** — mock the provider, call `runMutationTesting(workDir, profile, ["a.ts"])`, assert the provider received `["a.ts"]`.

### 4b. Blueprint tests — `packages/blueprints/tests/implement-feature.mutation.test.ts`

Add:

5. **Passes affected files to runMutationTesting** — set up a `PipelineContext` with a plan that has `affected_files: { modify: ["packages/engine/src/cost-tracker.ts"] }`. Assert `runMutationTesting` was called with `["packages/engine/src/cost-tracker.ts"]`.

6. **Passes undefined when no affected files** — context with no plan → `runMutationTesting` called with `undefined` as third arg.

7. **Log event includes scopedToFiles flag** — assert `ctx.log.info` was called with `scopedToFiles: true` when files are scoped.

## Constraints

- **No default exports.** Named exports only.
- **No `any`.** Use `unknown` and narrow.
- **No semicolons.** Biome enforces this.
- **Import paths:** Use `.js` extensions.
- **Backward compatible:** The `mutateFiles` parameter is optional. All existing callers (tests, future manual runs) continue to work without it.
- **Run tests via Docker:** `docker compose run --rm dev run test` after all changes.
- **Run typecheck + lint:** `docker compose run --rm dev run typecheck && docker compose run --rm dev run lint`

## Expected output

| Metric | Expected |
|--------|----------|
| New files | 0 |
| Changed files | 4 (`mutation.ts`, `mutation.test.ts`, `implement-feature.ts`, `implement-feature.mutation.test.ts`) |
| Test count delta | +7 (4 provider + 3 blueprint) |
| Typecheck | Clean |
| Lint | Clean |

## Commit

```
Stage 3c: scope-aware mutation targeting — only mutate coder-changed files
```

Single commit with all changed files.
