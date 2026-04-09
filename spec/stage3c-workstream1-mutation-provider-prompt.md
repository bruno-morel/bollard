# Stage 3c Workstream 1: MutationTestingProvider + StrykerProvider

> **Goal:** Create `packages/verify/src/mutation.ts` with the `MutationTestingProvider` interface, `StrykerProvider` implementation, and `runMutationTesting` router. Add `MutationConfig` to `ToolchainProfile`. Write comprehensive unit tests.

## Context

Read these files before writing any code:

- `CLAUDE.md` (root) — project conventions, tech stack, Docker rules
- `spec/stage3c-plan.md` — full Stage 3c plan (this workstream is WS1)
- `packages/detect/src/types.ts` — `ToolchainProfile`, existing `mutation?` field, `MutationToolId`
- `packages/verify/src/dynamic.ts` — `runTests` pattern (execFile + result parsing + graceful degradation)
- `packages/verify/src/contract-grounding.ts` — interface + implementation pattern in a single file
- `packages/engine/src/errors.ts` — `MUTATION_THRESHOLD_NOT_MET` already exists
- `packages/engine/src/context.ts` — `mutationScore?: number` already exists on `PipelineContext`

## Step 1: Extend `ToolchainProfile` with `MutationConfig`

**File:** `packages/detect/src/types.ts`

The existing `mutation?` field on `ToolchainProfile` has the wrong shape for what we need. Replace it with a proper `MutationConfig` interface:

```typescript
export interface MutationConfig {
  enabled: boolean
  tool: MutationToolId
  threshold: number         // minimum mutation score (0–100), default 80
  timeoutMs: number         // per-run timeout, default 300_000 (5 min)
  concurrency: number       // parallel test workers, default 2
}
```

Replace the existing `mutation?` field on `ToolchainProfile` (lines 82–86):

```typescript
// Before:
mutation?: {
  tool: MutationToolId
  command: string
  changedFilesPlaceholder: string
}

// After:
mutation?: MutationConfig
```

The old `command` and `changedFilesPlaceholder` fields are unused anywhere in the codebase (mutation testing was a placeholder from Stage 1.5). Removing them is safe — verify with a grep for `changedFilesPlaceholder` and `mutation.command` to confirm.

## Step 2: Create `packages/verify/src/mutation.ts`

**New file.** Follow the pattern of `dynamic.ts` (execFile-based execution with result parsing and graceful error handling).

### Types

```typescript
export interface MutationTestResult {
  score: number          // 0–100
  killed: number
  survived: number
  noCoverage: number
  timeout: number
  totalMutants: number
  duration_ms: number
  reportPath?: string    // path to raw JSON report
}

export interface MutationTestingProvider {
  readonly language: LanguageId
  run(workDir: string, profile: ToolchainProfile): Promise<MutationTestResult>
}
```

### `StrykerProvider` implementation

The `StrykerProvider` class implements `MutationTestingProvider` with `language: "typescript"` (also handles `"javascript"`).

**`run(workDir, profile)` does three things:**

1. **Generate config** — Write `stryker.config.json` to `workDir`:
   ```json
   {
     "testRunner": "vitest",
     "vitest": {
       "configFile": "vitest.config.ts"
     },
     "mutate": ["packages/*/src/**/*.ts", "!packages/*/src/**/*.test.ts"],
     "reporters": ["json", "clear-text"],
     "jsonReporter": { "fileName": "reports/mutation/mutation.json" },
     "thresholds": { "high": 80, "low": 60, "break": null },
     "concurrency": 2,
     "timeoutMS": 60000
   }
   ```
   
   Config values come from the profile:
   - `mutate` array: `profile.sourcePatterns` filtered to exclude patterns matching test files (anything containing `.test.`, `.spec.`, or `__tests__`). If `sourcePatterns` is empty, fall back to `["src/**/*.ts", "!src/**/*.test.ts"]`.
   - `vitest.configFile`: if `profile.checks.test` has args containing a `-c` or `--config` flag, use the value after it. Otherwise default to `"vitest.config.ts"`.
   - `thresholds.high`: `profile.mutation?.threshold ?? 80`
   - `concurrency`: `profile.mutation?.concurrency ?? 2`
   - `timeoutMS`: `profile.mutation?.timeoutMs ?? 300_000` (this is per-mutant timeout, NOT the outer process timeout)

   Use `writeFile` from `node:fs/promises` to write the config. The config file is ephemeral — it's written fresh each run.

2. **Execute Stryker** — Run `pnpm exec stryker run` via `execFileAsync` (promisified `execFile` from `node:child_process`, same pattern as `dynamic.ts`):
   ```typescript
   const { stdout, stderr } = await execFileAsync("pnpm", ["exec", "stryker", "run"], {
     cwd: workDir,
     maxBuffer: 10 * 1024 * 1024,  // 10 MB — Stryker is verbose
     timeout: profile.mutation?.timeoutMs ?? 300_000,
   })
   ```

3. **Parse results** — Read `reports/mutation/mutation.json` from `workDir` and parse it.

### `parseStrykerReport(reportJson: string): MutationTestResult`

**Export this function** (it will be tested independently).

Parse the Stryker mutation-testing-elements JSON report. The schema:

```typescript
interface StrykerReport {
  schemaVersion: string
  thresholds: { high: number; low: number }
  files: Record<string, {
    language: string
    source: string
    mutants: Array<{
      id: string
      mutatorName: string
      status: "Killed" | "Survived" | "NoCoverage" | "CompileError" | "RuntimeError" | "Timeout" | "Ignored" | "Pending"
    }>
  }>
}
```

Aggregate across all files:
- `killed` = count of mutants with status `"Killed"`
- `survived` = count with status `"Survived"`
- `noCoverage` = count with status `"NoCoverage"`
- `timeout` = count with status `"Timeout"`
- `totalMutants` = killed + survived + noCoverage + timeout (exclude CompileError, RuntimeError, Ignored, Pending)
- `score` = totalMutants > 0 ? `(killed + timeout) / totalMutants * 100` : 0

Return a `MutationTestResult` with all fields populated.

### `runMutationTesting(workDir, profile): Promise<MutationTestResult>`

**Export this function** — it's the public API called by the blueprint node.

This is the router (same pattern as `buildContractContext`):

```typescript
const PROVIDERS: Record<string, MutationTestingProvider> = {
  typescript: new StrykerProvider(),
  javascript: new StrykerProvider(),
  // Future: python → MutmutProvider, rust → CargoMutantsProvider
}
```

Logic:
1. If `!profile.mutation?.enabled`, return a zero-result: `{ score: 0, killed: 0, survived: 0, noCoverage: 0, timeout: 0, totalMutants: 0, duration_ms: 0 }`
2. Look up `PROVIDERS[profile.language]`
3. If no provider, return zero-result with a warning (log to stderr: `mutation testing not available for ${profile.language}`)
4. Call `provider.run(workDir, profile)` and return the result

### Graceful degradation

If Stryker execution fails (binary not found, crashes, etc.), catch the error and return:
```typescript
{ score: 0, killed: 0, survived: 0, noCoverage: 0, timeout: 0, totalMutants: 0, duration_ms: Date.now() - startMs }
```
Log a warning with the error message. Do NOT throw — same pattern as `getExtractor` helpers that return empty results on missing tooling.

If the report JSON file doesn't exist after execution (e.g. Stryker crashed before writing it), same zero-result.

If the report JSON is malformed, same zero-result with a warning.

## Step 3: Write tests — `packages/verify/tests/mutation.test.ts`

Use Vitest. Mock `execFileAsync` (same pattern as `implement-feature.risk-gate.test.ts` — use `vi.hoisted` + `vi.mock("node:child_process")`). Also mock `node:fs/promises` for `writeFile` and `readFile`.

### Test cases for `parseStrykerReport`:

1. **Parses a complete report with mixed statuses** — provide a sample JSON with files containing Killed, Survived, NoCoverage, Timeout, CompileError mutants. Assert correct counts and score calculation.

2. **Returns zero score for empty report** — `{ schemaVersion: "1", thresholds: {}, files: {} }` → score 0, totalMutants 0.

3. **Excludes CompileError/RuntimeError/Ignored/Pending from denominator** — provide a report where all mutants are CompileError. Assert totalMutants = 0, score = 0.

4. **Handles 100% kill rate** — all mutants Killed → score 100.

5. **Counts Timeout as killed in score** — mutants with Timeout status contribute positively to score.

### Test cases for `StrykerProvider.run` (config generation):

6. **Generates config from profile sourcePatterns** — mock writeFile, call `run()`, assert the written JSON has `mutate` derived from `profile.sourcePatterns` with test files excluded.

7. **Falls back to vitest.config.ts when no test config flag** — assert `vitest.configFile` is `"vitest.config.ts"` when `profile.checks.test` has no `-c` arg.

8. **Uses threshold and concurrency from MutationConfig** — profile has `mutation: { threshold: 90, concurrency: 4 }`, assert config JSON reflects these.

### Test cases for `runMutationTesting` (router):

9. **Returns zero result when mutation is disabled** — `profile.mutation.enabled = false` → zero result, no exec called.

10. **Returns zero result for unsupported language** — `profile.language = "go"` → zero result (Go provider not yet registered).

11. **Returns zero result when Stryker binary fails** — mock execFileAsync to throw ENOENT → zero result, no throw.

12. **Returns zero result when report file is missing** — mock readFile to throw ENOENT → zero result.

13. **Returns parsed result on successful run** — mock exec + readFile with valid report JSON → correct MutationTestResult.

### Test helper: `makeProfile`

Create a `makeProfile` helper similar to the one in `implement-feature.risk-gate.test.ts` but with `mutation` field:

```typescript
function makeProfile(overrides?: Partial<MutationConfig>): ToolchainProfile {
  return {
    language: "typescript",
    packageManager: "pnpm",
    checks: {},
    sourcePatterns: ["packages/*/src/**/*.ts"],
    testPatterns: ["packages/*/tests/**/*.test.ts"],
    ignorePatterns: ["node_modules"],
    allowedCommands: ["pnpm"],
    adversarial: { /* ... standard scope configs ... */ },
    mutation: {
      enabled: true,
      tool: "stryker",
      threshold: 80,
      timeoutMs: 300_000,
      concurrency: 2,
      ...overrides,
    },
  }
}
```

## Constraints

- **No default exports.** Named exports only.
- **No `any`.** Use `unknown` and narrow.
- **No semicolons.** Biome enforces this.
- **Use `BollardError`** if you need to throw (but prefer graceful degradation in this module).
- **Imports:** Use `.js` extensions in import paths (e.g., `import type { ToolchainProfile } from "@bollard/detect/src/types.js"`).
- **File naming:** kebab-case (`mutation.ts`, `mutation.test.ts`).
- **Run tests via Docker:** `docker compose run --rm dev run test` after all changes.
- **Run typecheck + lint:** `docker compose run --rm dev run typecheck && docker compose run --rm dev run lint`

## Expected output

| Metric | Expected |
|--------|----------|
| New files | 2 (`mutation.ts`, `mutation.test.ts`) |
| Changed files | 1 (`types.ts`) |
| Test count delta | +13 (approximately, from the 13 test cases above) |
| Typecheck | Clean |
| Lint | Clean |

## Commit

```
Stage 3c: MutationTestingProvider + StrykerProvider + result parser + tests
```

Single commit. Include all three files (`types.ts` change + `mutation.ts` + `mutation.test.ts`).
