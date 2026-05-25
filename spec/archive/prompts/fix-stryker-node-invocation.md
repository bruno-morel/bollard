# Cursor Prompt — Fix: Stryker invoked via node+stryker.js instead of pnpm shell wrapper

> **Context:** This is the Phase 15b fix for Stryker producing `totalMutants: 0` inside
> Docker. The Phase 15 fix (binary path: `node_modules/.bin/stryker` instead of
> `pnpm exec stryker run`) was applied in commit `cdf2440` but the limitUsd() self-test
> (`20260525-2109-run-b8c50b`) still logged `stryker_no_mutants`. This prompt documents
> the root cause and the fix.
>
> **Root cause:** The pnpm-generated shell wrapper at `node_modules/.bin/stryker` contains
> hardcoded absolute `NODE_PATH` entries baked from the host machine at install time:
> ```
> export NODE_PATH="/Users/brunomorel/inVantage Dropbox/.../node_modules/.pnpm/..."
> ```
> Inside Docker (`/app/`), those paths don't exist. Node.js therefore cannot find
> `@stryker-mutator/vitest-runner`, which is loaded as a plugin by Stryker core at
> startup. Stryker silently starts with no test runner, finds no test files, and exits 0
> with `files: {}` — 0 mutants, always passes.
>
> **Fix:** Bypass the shell wrapper entirely. Invoke `node` directly on the Stryker JS
> entry point: `node_modules/@stryker-mutator/core/bin/stryker.js run`. Standard
> `node_modules` resolution then works correctly in both host and Docker environments.
>
> **NOTE:** This fix has already been applied directly to the source files. This prompt
> is for documentation/audit purposes only — Cursor does not need to implement it again.

---

## Files Modified

- `packages/verify/src/mutation.ts` — `StrykerProvider.run()` + `strykerSmokeTest()`
- `packages/verify/tests/mutation.test.ts` — +1 test asserting `node` invocation

---

## Changes Made

### `packages/verify/src/mutation.ts`

**`StrykerProvider.run()` — before:**
```typescript
const strykerBin = join(workDir, "node_modules", ".bin", "stryker")
await execFileAsync(strykerBin, ["run"], {
  cwd: workDir,
  maxBuffer: 10 * 1024 * 1024,
  timeout: profile.mutation?.timeoutMs ?? 300_000,
})
```

**After:**
```typescript
// Invoke Stryker via `node` directly on the JS entry point rather than the
// pnpm-generated shell wrapper. The shell wrapper sets NODE_PATH to absolute
// host paths (baked at install time), which don't exist inside Docker — causing
// the @stryker-mutator/vitest-runner plugin to silently fail to resolve and
// Stryker to exit 0 with an empty files:{} report (0 mutants). Calling node
// directly lets standard node_modules resolution work in any environment.
const strykerJs = join(workDir, "node_modules", "@stryker-mutator", "core", "bin", "stryker.js")
await execFileAsync("node", [strykerJs, "run"], {
  cwd: workDir,
  maxBuffer: 10 * 1024 * 1024,
  timeout: profile.mutation?.timeoutMs ?? 300_000,
})
```

**`strykerSmokeTest()` — before:**
```typescript
const strykerBin = join(workDir, "node_modules", ".bin", "stryker")
return existsSync(strykerBin)
```

**After:**
```typescript
const strykerJs = join(workDir, "node_modules", "@stryker-mutator", "core", "bin", "stryker.js")
return existsSync(strykerJs)
```

### `packages/verify/tests/mutation.test.ts`

Added to `describe("runMutationTesting")`:
```typescript
it("invokes node directly on stryker.js entry point (not the pnpm shell wrapper)", async () => {
  mockWriteFile.mockResolvedValue(undefined)
  mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" })
  mockReadFile.mockResolvedValue(makeSampleReport([{ status: "Killed" }]))

  await runMutationTesting("/tmp/test", makeProfile())

  expect(mockExecFileAsync).toHaveBeenCalledOnce()
  const [executable, args] = mockExecFileAsync.mock.calls[0] as [string, string[]]
  expect(executable).toBe("node")
  expect(args[0]).toContain("@stryker-mutator/core/bin/stryker.js")
  expect(args[1]).toBe("run")
})
```

---

## Commit

```bash
git add packages/verify/src/mutation.ts
git add packages/verify/tests/mutation.test.ts
git commit -m "fix: invoke Stryker via node+stryker.js directly, not pnpm shell wrapper

The pnpm-generated .bin/stryker shell script sets NODE_PATH to absolute host
paths baked at install time (e.g. /Users/brunomorel/...). Inside Docker those
paths don't exist, so @stryker-mutator/vitest-runner fails to resolve — Stryker
exits 0 with files:{} and 0 mutants, silently.

Fix: call node directly on node_modules/@stryker-mutator/core/bin/stryker.js.
Standard node_modules resolution then works in any environment (host or Docker).
strykerSmokeTest() updated to check the JS entry point instead of the shell wrapper.
+1 test asserting node+stryker.js invocation."
git push origin main
```

---

## Validation

Run any self-test that reaches `run-mutation-testing` (node 22 of 31). Expected:
- `mutation_testing_result` log event with `totalMutants > 0`
- `stryker_no_mutants` warning: **absent**
- Mutation score > 0%

If `stryker_no_mutants` still appears, check whether the `vitest.config.ts` pointed to by
the generated `stryker.config.json` is resolvable from `/app` inside the container.
