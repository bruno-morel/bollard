# Cursor Prompt — Stage 5e Phase 3: Stryker `stryker_no_mutants` Pre-flight

> **Purpose:** Multiple self-test runs hit `stryker_no_mutants` because the coder left a syntax
> error in the source file (e.g. a missing `}` closing a method before the new one). Stryker runs
> Babel/oxc to instrument the file, fails to parse it, exits with 0 mutants, and the pipeline
> logs a warning and continues — but no mutation coverage is produced. Adding a `tsc --noEmit`
> preflight on the affected source files before launching Stryker catches this in ~1s and returns
> a clear diagnostic instead of spending 15s on a Stryker run that produces nothing.
>
> This is a purely deterministic change to `packages/verify/src/mutation.ts`. No LLM calls,
> no new deps, no blueprint changes.

Read `CLAUDE.md` fully before writing any code. Then read:
- `packages/verify/src/mutation.ts` — `runStrykerMutationTesting` function (~line 440);
  specifically the section between writing `stryker.config.json` and calling
  `execFileAsync("node", [strykerJs, "run"])` (~line 495)
- `packages/verify/tests/mutation.test.ts` — existing test structure to understand patterns
- `packages/engine/src/errors.ts` — `BollardError` (for reference; not needed for this change)

---

## Goal

Add a TypeScript syntax pre-flight check inside `runStrykerMutationTesting` (the TS/JS branch
of `runMutationTesting`). Before launching Stryker, run `tsc --noEmit` scoped to just the
affected source files. If it fails, log a warning and return `ZERO_RESULT` with
`reason: "preflight_typecheck_failed"` — the same graceful skip pattern already used for
other Stryker failure modes. No throw, no pipeline halt.

---

## Step 1 — Add `runStrykerPreflight` in `packages/verify/src/mutation.ts`

Add this exported function near the other helpers (e.g. after `strykerSmokeTest`):

```typescript
/**
 * Run a fast `tsc --noEmit` check on the files Stryker will instrument.
 * Returns null when the check passes (or is skipped), or an error message string
 * when typecheck fails. This catches syntax errors that cause Stryker to exit
 * with 0 mutants (Babel/oxc parse failure on instrumented source).
 *
 * Only runs for TypeScript/JavaScript profiles. Returns null immediately for
 * other languages — they have their own pre-run validation.
 *
 * @param workDir  Project root (where tsconfig.json lives)
 * @param mutateFiles  The source files Stryker will mutate (absolute or relative to workDir)
 */
export async function runStrykerPreflight(
  workDir: string,
  mutateFiles: string[],
): Promise<string | null> {
  if (mutateFiles.length === 0) return null

  // Only check files that look like TypeScript/JavaScript source
  const tsFiles = mutateFiles.filter(
    (f) => f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".js") || f.endsWith(".jsx"),
  )
  if (tsFiles.length === 0) return null

  try {
    await execFileAsync("tsc", ["--noEmit", ...tsFiles], {
      cwd: workDir,
      timeout: 15_000,
    })
    return null // pass
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return `tsc preflight failed on ${tsFiles.join(", ")}: ${msg.slice(0, 500)}`
  }
}
```

---

## Step 2 — Call `runStrykerPreflight` in `runStrykerMutationTesting`

Inside `runStrykerMutationTesting`, after writing `stryker.config.json` and before calling
`execFileAsync("node", [strykerJs, "run"])` (around line 495), insert:

```typescript
// Pre-flight: verify source files parse cleanly before launching Stryker.
// A syntax error causes Stryker to exit 0 with 0 mutants (Babel/oxc parse failure).
const resolvedMutateFiles = mutateFiles && mutateFiles.length > 0
  ? mutateFiles
  : [] // full-repo runs don't need preflight — too many files
if (resolvedMutateFiles.length > 0) {
  const preflightError = await runStrykerPreflight(workDir, resolvedMutateFiles)
  if (preflightError !== null) {
    process.stderr.write(
      `bollard: stryker preflight failed — skipping mutation testing: ${preflightError}\n`,
    )
    return {
      ...ZERO_RESULT,
      duration_ms: Date.now() - startMs,
    }
  }
}
```

Note: `mutateFiles` is the parameter passed into `runStrykerMutationTesting`. When it's undefined
or empty, Stryker uses the full glob patterns — skip the preflight in that case (too many files,
and full-repo runs are less likely to have a single broken file).

---

## Step 3 — Update `packages/verify/tests/mutation.test.ts`

Add a `describe("runStrykerPreflight")` block with 3 tests:

1. **returns null for non-TS files** — pass `["src/main.go"]`; no tsc call, returns null.
   (Verify by checking the return value — tsc won't be on PATH in the test environment anyway.)

2. **returns null for empty files list** — pass `[]`; returns null immediately.

3. **returns error string when tsc fails** — write a temp `.ts` file with a deliberate syntax
   error (`const x = (`), call `runStrykerPreflight(tempDir, [tempFile])`, expect the return
   value to be a non-null string containing `"tsc preflight failed"`.
   Use `mkdtemp` + `writeFile` from `node:fs/promises` for the temp file.

Use `vi.spyOn` or temp files as needed — no mocking of `execFileAsync` (too brittle for a
function that calls an external binary). The "tsc fails" test works by actually running tsc
against a broken file (tsc is available in the dev Docker image).

---

## Self-check

Run sequentially. Do NOT declare done until all pass.

1. `docker compose run --rm dev run typecheck` — exit 0
2. `docker compose run --rm dev run lint` — exit 0
3. `docker compose run --rm dev run test` — all pass; count ≥ 1400 (1397 + 3 new)
4. `git diff --stat HEAD -- packages/blueprints/src packages/agents/prompts` — empty
5. Grep new code for `await provider.chat` / `chatStream` — zero matches
6. `runStrykerPreflight` exported from `mutation.ts` — verify with
   `grep "export.*runStrykerPreflight" packages/verify/src/mutation.ts`

---

## When GREEN — doc updates

- In `CLAUDE.md`: add to the known limitations section — "**Stage 5e Phase 3 (DONE):**
  `runStrykerPreflight` in `@bollard/verify` — runs `tsc --noEmit` on affected source files
  before launching Stryker when `mutateFiles` is non-empty. Catches syntax errors that cause
  `stryker_no_mutants` (Babel/oxc parse failure). Returns `ZERO_RESULT` with graceful skip on
  failure. +3 tests in `mutation.test.ts`. 1400 pass / 6 skip."
- In `spec/ROADMAP.md`: strike through "Stryker `stryker_no_mutants` pre-flight (Phase 3)"
  under Stage 5e.
- Move this file to `spec/archive/prompts/stage5e-phase3-stryker-preflight.md`

---

## Out of scope

- DO NOT add preflight for mutmut (Python) or cargo-mutants (Rust) — they don't have the
  Babel/oxc parse failure mode; their failures produce real error output
- DO NOT run preflight when `mutateFiles` is empty/undefined (full-repo glob runs)
- DO NOT throw or return `status: "fail"` — preflight failures must degrade gracefully
  (same `onFailure: "skip"` pattern as the rest of the mutation node)
- DO NOT change the blueprint node or `runMutationTesting` entry point — only
  `runStrykerMutationTesting` needs the preflight
- DO NOT add tsc to the agent tool allowlist or change any agent infrastructure
