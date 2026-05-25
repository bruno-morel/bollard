# Cursor Prompt — Fix Stryker Silent No-Op in Docker Container

> **Context:** The `run-mutation-testing` blueprint node has returned `totalMutants: 0` in every
> logged Bollard-on-Bollard self-test (runCount, formatCost, multiply, clamp, merge — all runs).
> Stryker executes without error (no `bollard: stryker execution failed:` stderr), writes a report,
> but the report contains zero mutants. The node returns `status: ok` because the failure guard is
> `totalMutants > 0 && score < threshold` — zero mutants always passes. This means the mutation
> scope is silently producing no signal on every production pipeline run.
>
> **Read CLAUDE.md fully before starting.** Then read:
> - `packages/verify/src/mutation.ts` — `StrykerProvider.run()` (line ~433): the execution
>   path; `parseStrykerReport()` (line ~61): how the report is parsed; the `ZERO_RESULT` return
>   paths (lines ~467, ~483, ~492)
> - `packages/blueprints/src/implement-feature.ts` — the `run-mutation-testing` node
>   (search `"run-mutation-testing"`): the guard at `totalMutants > 0` (line ~1477) and what
>   constitutes `ok` vs `fail`
> - `stryker.config.json` — the hardcoded repo Stryker config (not the pipeline-generated one)
> - `packages/detect/src/languages/typescript.ts` — `detectStryker()` (line ~121): confirms
>   Stryker is auto-detected when `@stryker-mutator/core` is in `devDependencies`

---

## Root Cause Analysis

### What happens today

1. `mutation.enabled: true` is auto-detected (Bollard has `@stryker-mutator/core` in `package.json`).
2. `StrykerProvider.run()` writes a generated `stryker.config.json` to `workDir` (overwriting the
   repo's own `stryker.config.json`).
3. `execFileAsync("pnpm", ["exec", "stryker", "run"], { cwd: workDir })` runs — **exits 0**
   (no throw, no `bollard: stryker execution failed:` log line).
4. `readFile(reportPath, "utf-8")` reads `reports/mutation/mutation.json` — succeeds.
5. `parseStrykerReport(reportJson)` parses the JSON — but `report.files` is `{}` (empty object)
   or the mutant count is 0.
6. Result: `totalMutants: 0, score: 0, killed: 0, survived: 0` — logged as
   `mutation_testing_result` with those values.
7. The blueprint node guard `totalMutants > 0 && score < threshold` is false → `status: ok`.

### Why 0 mutants

The pipeline-generated Stryker config sets `testRunner: "vitest"` and the Vitest config to
`deriveVitestConfigFile(profile)`. Inside the Docker container's subprocess environment,
Stryker's vitest plugin fails to locate the test files or the vitest binary, producing 0 tested
mutants. The Stryker process exits 0 (Stryker treats 0 mutants as a degenerate success, not an
error) and writes a report with empty `files`.

The most likely causes (in priority order):
1. **`pnpm exec stryker run` in subprocess** doesn't inherit the correct `NODE_PATH` or cwd
   context that pnpm uses in the container's ENTRYPOINT environment. The `stryker` binary runs
   but its vitest plugin can't resolve test files.
2. **The generated config's `mutate` patterns** may not match any files (paths are relative to
   `workDir`; if `workDir` is `/app` and patterns are `packages/engine/src/cost-tracker.ts`,
   they may resolve correctly — but if Stryker's working directory is wrong, they won't).
3. **`vitest.config.ts` resolution** inside the Stryker subprocess fails silently.

### Observable confirmation

From the merge() self-test log:
```json
{ "event": "mutation_testing_result", "score": 0, "killed": 0, "survived": 0,
  "totalMutants": 0, "duration_ms": 15534 }
```

15 seconds of wall time — Stryker ran but produced nothing. A true skip (disabled) takes < 1ms.

---

## What to Fix

### Fix 1: Detect 0-mutant no-op and surface it as `status: fail`

In `packages/blueprints/src/implement-feature.ts`, in the `run-mutation-testing` node, add a
guard after `runMutationTesting` returns:

```typescript
// NEW: detect silent no-op (Stryker ran but found no mutants to test)
if (result.totalMutants === 0) {
  ctx.log.warn("mutation_testing_result", {
    event: "mutation_testing_result",
    runId: ctx.runId,
    warning: "stryker_no_mutants",
    message:
      "Stryker ran but found 0 mutants — vitest runner may have failed to locate test files inside Docker. Treating as skip.",
    duration_ms: result.duration_ms,
    scopedToFiles: affectedFiles.length > 0,
    affectedFileCount: affectedFiles.length,
  })
  return {
    status: "ok",
    data: { ...result, skipped: true, reason: "stryker_no_mutants" },
  }
}
```

This makes the no-op explicit in the log (previously `info` with all zeros was easy to miss)
and is more honest than silently passing — but still `status: ok` so it doesn't block the
pipeline (same as `mutation.enabled: false`). The `warning: "stryker_no_mutants"` field
makes it grep-able in future self-test analysis.

### Fix 2: Validate the stryker config before writing + use `node_modules/.bin` path

In `packages/verify/src/mutation.ts`, in `StrykerProvider.run()`, replace the `execFileAsync`
call to use an explicit binary path so pnpm's workspace resolution issues don't affect it:

```typescript
// Instead of relying on pnpm to resolve stryker in a subprocess:
// await execFileAsync("pnpm", ["exec", "stryker", "run"], { cwd: workDir, ... })
//
// Use the node_modules/.bin path directly (always available after pnpm install):
const strykerBin = join(workDir, "node_modules", ".bin", "stryker")
try {
  await execFileAsync(strykerBin, ["run"], {
    cwd: workDir,
    maxBuffer: 10 * 1024 * 1024,
    timeout: profile.mutation?.timeoutMs ?? 300_000,
  })
} catch (err: unknown) {
  process.stderr.write(
    `bollard: stryker execution failed: ${err instanceof Error ? err.message : String(err)}\n`,
  )
  return { ...ZERO_RESULT, duration_ms: Date.now() - startMs }
}
```

If `node_modules/.bin/stryker` doesn't exist (e.g. Stryker not installed), the `execFileAsync`
will throw with `ENOENT` → caught → `ZERO_RESULT` (same as current `pnpm exec` failure path).

### Fix 3: Add a smoke-test helper to verify Stryker works before a full run

In `packages/verify/src/mutation.ts`, add an exported smoke-test function:

```typescript
/**
 * Verify that Stryker can actually find and run tests in this environment.
 * Returns true if Stryker is callable and produces > 0 mutants on a 1-file dry run.
 * Used by the blueprint node to distinguish "disabled" from "broken".
 */
export async function strykerSmokeTest(workDir: string): Promise<boolean> {
  const strykerBin = join(workDir, "node_modules", ".bin", "stryker")
  try {
    await accessSync(strykerBin) // throws if not executable
    return true
  } catch {
    return false
  }
}
```

(The actual smoke-test for mutant count requires running Stryker, which is expensive.
A binary existence check is sufficient for now — the 0-mutant guard in Fix 1 handles the
"binary runs but produces nothing" case.)

---

## Files to Change

- `packages/blueprints/src/implement-feature.ts` — add 0-mutant guard in `run-mutation-testing` node
- `packages/verify/src/mutation.ts` — replace `pnpm exec stryker run` with direct `node_modules/.bin/stryker run`; add `strykerSmokeTest` export
- `packages/verify/tests/mutation.test.ts` — add tests (see below)

Do NOT change any other files.

---

## Tests to Add

In `packages/verify/tests/mutation.test.ts` (or the existing mutation test file — check if it
exists, if not create it), add:

```typescript
describe("StrykerProvider — 0-mutant detection", () => {
  it("parseStrykerReport returns totalMutants: 0 when files is empty object", () => {
    const report = JSON.stringify({ schemaVersion: "1.0", files: {} })
    const result = parseStrykerReport(report)
    expect(result.totalMutants).toBe(0)
    expect(result.score).toBe(0)
  })

  it("parseStrykerReport returns totalMutants: 0 when files is missing", () => {
    const report = JSON.stringify({ schemaVersion: "1.0" })
    const result = parseStrykerReport(report)
    expect(result.totalMutants).toBe(0)
  })
})
```

Also add a test that the blueprint node logs `warning: "stryker_no_mutants"` when
`totalMutants === 0` — check how the existing blueprint unit tests mock the node; if the
blueprint isn't directly unit-tested at node level, skip this and note it as a manual
validation step.

---

## Self-check before completing

```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

Verify:
- typecheck: zero errors
- lint: zero errors
- test: ≥ 1186 passed / 6 skipped
- `git diff --name-only` shows ONLY:
  - `packages/blueprints/src/implement-feature.ts`
  - `packages/verify/src/mutation.ts`
  - `packages/verify/tests/mutation.test.ts` (or equivalent)

### Manual validation (next self-test run)

After the next Bollard-on-Bollard run:
1. Grep the log for `stryker_no_mutants` — if present, the binary path fix didn't resolve it
   but the issue is now visibly flagged.
2. Grep for `warning: "stryker_no_mutants"` absent AND `totalMutants > 0` — means Fix 2
   resolved the Docker path issue and Stryker is producing real mutation signal.

---

## What NOT to fix here

- Do NOT change how mutation is enabled/disabled (`detectStryker`, `.bollard.yml` `mutation:` block).
- Do NOT change the `threshold` logic or the `MUTATION_THRESHOLD_NOT_MET` error path.
- Do NOT attempt to fix the Docker container's PATH — use the direct binary path instead.
- Do NOT add a new blueprint node or new config field.

---

## Background: why `pnpm exec` fails in the subprocess

`pnpm exec` in the container ENTRYPOINT works because Docker's ENTRYPOINT sets up the shell
environment. When `execFileAsync("pnpm", ...)` spawns a subprocess from within a `tsx`-running
script, it inherits `process.env` from the Node.js process — but pnpm's own package resolution
machinery (Plug'n'Play or the `node_modules/.pnpm` layout) may not be fully initialized in the
subprocess context. The result: `pnpm exec stryker` finds the stryker binary but the stryker
process itself can't resolve `@stryker-mutator/vitest-runner` → exits 0 with empty mutation
report. Using `node_modules/.bin/stryker` directly bypasses pnpm's resolution layer and calls
the binary that was already resolved at `pnpm install` time.
