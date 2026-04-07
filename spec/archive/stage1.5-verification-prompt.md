# Stage 1.5 — Bollard-on-Bollard Adversarial Verification

> Paste this into Cursor's Composer. The CLAUDE.md file at the repo root has all the context. This prompt verifies that the Stage 1.5 implementation is correct, complete, and didn't regress existing behavior.

---

## Prompt

I've just completed Stage 1.5 of **Bollard** — language-agnostic toolchain detection. Read `CLAUDE.md` at the repo root for full context. Also read `spec/06-toolchain-profiles.md` for the design spec and `spec/stage1.5-prompt.md` for what was supposed to be built.

Stage 1.5 added `@bollard/detect` (ToolchainProfile types, per-language detectors for TypeScript/Python/Go/Rust, detection orchestrator), templatized the three agent prompts with `{{variable}}` placeholders, made `runStaticChecks` and `runTests` profile-driven, threaded `ToolchainProfile` through the CLI and implement-feature blueprint, and added `.bollard.yml` `toolchain:` override support.

**Your job: adversarially verify that the implementation matches the spec, preserves existing behavior, and has no gaps.** Think like a hostile reviewer. Complete each step fully before moving to the next.

### Step 1: Run the full verification suite

Run all existing checks. Every one must pass with zero errors:

```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
docker compose run --rm dev --filter @bollard/cli run start -- verify
```

If anything fails, fix it before continuing. Record the exact test count (should be 185+ across 18+ files).

### Step 2: Run the adversarial retro pass

Run the retro-adversarial script to confirm the adversarial testing pipeline still works after the refactoring:

```bash
docker compose run --rm --entrypoint sh dev -c "pnpm exec tsx scripts/retro-adversarial.ts"
```

The script should still extract signatures, generate blind tests, and run them. Compare results to the Pass 4 baseline documented in `docs/retro-adversarial-results.md`. If the retro script fails because import paths changed during the refactoring, fix the imports — the script references `@bollard/agents/src/executor.js`, `@bollard/verify/src/type-extractor.js`, etc.

Record:
- Total tests generated vs Pass 4 baseline
- Pass/fail counts
- Any new failure patterns (these indicate regression)

### Step 3: Cross-reference implementation against spec

Read `spec/stage1.5-prompt.md` (the build instructions) and verify every claim against the actual code. Check these specific items:

**3a: `@bollard/detect` types** — Read `packages/detect/src/types.ts` and verify against `spec/06-toolchain-profiles.md` Section 3:
- `ToolchainProfile` must have all fields: `language`, `packageManager?`, `checks`, `mutation?`, `sourcePatterns`, `testPatterns`, `ignorePatterns`, `allowedCommands`, `adversarial`
- `LanguageId` must include: typescript, javascript, python, go, rust, java, kotlin, ruby, csharp, elixir, unknown
- `VerificationCommand` must have: label, cmd, args, source

**3b: Detection orchestrator** — Read `packages/detect/src/detect.ts`:
- Must run detectors in order: TypeScript → Python → Go → Rust → fallback
- Must check gitleaks availability and add to secretScan
- Must return minimal profile with `language: "unknown"` when nothing detected

**3c: Per-language detectors** — Read each file in `packages/detect/src/languages/`:
- `typescript.ts`: detects tsconfig.json, pnpm/yarn/npm/bun, biome/eslint, vitest/jest
- `python.ts`: detects pyproject.toml/setup.py/requirements.txt, poetry/pipenv/uv/pip, mypy/pyright, ruff/flake8/pylint, pytest. Uses regex for `[tool.*]` sections — no TOML parser dependency
- `go.ts`: detects go.mod, golangci-lint, go vet/test, govulncheck
- `rust.ts`: detects Cargo.toml, cargo check/clippy/test/audit
- `fallback.ts`: returns null for detection, exports `buildManualProfile`

**3d: Prompt preservation** — This is the most critical check. Read all three prompts:
- `packages/agents/prompts/planner.md`: Project Context section must be templatized with {{language}}, {{packageManager}}, etc. Rules 1-9 must be UNCHANGED. `runtimeConstraints` must still be in the plan schema. Rule 9 must still reference `runtimeConstraints`.
- `packages/agents/prompts/coder.md`: Rule 3 must use {{testFramework}}. Verification section must use {{testFramework}}, {{typecheck}}, {{linter}}. Stage 1 limitation notice must now mention adversarial test agent ("An independent adversarial test agent will also generate blind tests from your type signatures").
- `packages/agents/prompts/tester.md`: Rule 6 must use {{testFramework}}. Rules 8-15 must be COMPLETELY UNCHANGED — these were tuned over 4 adversarial passes and are load-bearing. Verify each rule individually:
  - Rule 8: exact identifiers from types
  - Rule 9: all required arguments
  - Rule 10: fixture shapes match type
  - Rule 11: don't assume functions throw
  - Rule 12: use import path from task
  - Rule 13: follow runtime constraints
  - Rule 14: return type is only truth
  - Rule 15: valid-domain property tests

**3e: Agent creation functions** — Read `packages/agents/src/planner.ts`, `coder.ts`, `tester.ts`:
- All three must accept optional `ToolchainProfile` parameter
- When profile provided: must call `fillPromptTemplate(template, profile)`
- When profile undefined: must use raw template (backward compat)

**3f: Profile threading** — Verify end-to-end flow:
- `packages/cli/src/config.ts`: `resolveConfig` must call `detectToolchain(cwd)`, `ResolvedConfig` must include `profile: ToolchainProfile`
- `packages/cli/src/agent-handler.ts`: `createAgenticHandler` must accept `ToolchainProfile?`, pass it to all three agent creators, set `agentCtx.allowedCommands` from profile, `buildProjectTree` must use `profile.sourcePatterns`/`profile.ignorePatterns`, `createVerificationHook` must use `profile.checks`
- `packages/engine/src/context.ts`: `PipelineContext` must have `toolchainProfile?: ToolchainProfile`
- `packages/engine/src/errors.ts`: `BollardErrorCode` must include `DETECTION_FAILED` and `PROFILE_INVALID`
- `packages/blueprints/src/implement-feature.ts`: must read `ctx.toolchainProfile`, pass profile to `runStaticChecks` and `runTests`, use `sourcePatterns` for affected file filtering (not hardcoded `.ts`)
- `packages/verify/src/static.ts`: `runStaticChecks(workDir, profile?)` must use `profile.checks` when provided, fall back to hardcoded defaults when omitted
- `packages/verify/src/dynamic.ts`: `runTests(workDir, testFiles?, profile?)` must use `profile.checks.test` when provided, fall back to hardcoded Vitest when omitted

If ANY of the above is missing or wrong, fix it.

### Step 4: Behavioral equivalence test

The hardest requirement: for a TypeScript project (i.e., the Bollard repo itself), the profile-driven path must produce **identical behavior** to the old hardcoded path. Write a test that proves this:

Create `packages/detect/tests/equivalence.test.ts`:

```typescript
// Test that detectToolchain on the Bollard repo produces commands
// equivalent to the old hardcoded defaults.
// This is the behavioral equivalence proof for Stage 1.5.
```

The test should:
1. Run `detectToolchain` against the Bollard workspace root
2. Assert the profile's typecheck command matches `pnpm run typecheck`
3. Assert the profile's lint command matches `pnpm run lint`
4. Assert the profile's test command matches the expected vitest invocation
5. Assert the profile's audit command matches `pnpm audit --audit-level=high`
6. Assert `allowedCommands` includes at minimum: pnpm, npx, node, tsc, biome, git, cat, head, tail, wc, diff (the original `DEFAULT_ALLOWED_COMMANDS` from `run-command.ts`)
7. Assert `sourcePatterns` includes `**/*.ts` and excludes test patterns
8. Assert `language === "typescript"` and `packageManager === "pnpm"`

This test is the mechanical proof that the abstraction didn't change observable behavior.

### Step 5: Non-TypeScript detection smoke test

Create `packages/detect/tests/cross-language.test.ts` if it doesn't exist:

Test that each fixture directory produces a sane profile:
- `ts-project/` → language: "typescript", packageManager: "pnpm", has typecheck + lint + test
- `py-project/` → language: "python", packageManager: "poetry", has typecheck (mypy) + lint (ruff) + test (pytest)
- `go-project/` → language: "go", has typecheck (go vet) + lint (golangci-lint) + test (go test)
- `rust-project/` → language: "rust", has typecheck (cargo check) + lint (cargo clippy) + test (cargo test)
- `empty-project/` → language: "unknown", empty checks

Also test that running `detectToolchain` on a Python fixture doesn't accidentally include TypeScript-specific commands in `allowedCommands`.

If these tests already exist in `detect.test.ts`, verify they cover all the above assertions. Add any missing ones.

### Step 6: Edge case and adversarial tests for detection

Write `packages/detect/tests/detect.adversarial.test.ts`:

1. **Multi-language project**: Create a temp fixture with BOTH `tsconfig.json` and `pyproject.toml`. Verify TypeScript wins (it runs first). Document this priority behavior.
2. **Missing lock files**: Create a fixture with `tsconfig.json` but no lock file. Verify package manager defaults to npm (not undefined, not crash).
3. **Broken pyproject.toml**: Create a fixture with `pyproject.toml` containing invalid TOML. Verify Python detector returns a profile (not crash) — the regex-based section detection should be resilient.
4. **Path traversal in detection**: Verify that `detectToolchain` with a path containing `../` doesn't escape the intended directory.
5. **Empty checks profile**: Create a profile with `language: "typescript"` but all checks undefined. Pass it to `runStaticChecks`. Verify it returns `{ results: [], allPassed: true }` (no checks = vacuously passing) — NOT a crash.
6. **fillPromptTemplate with missing placeholders**: Call `fillPromptTemplate` on a template string with no `{{}}` placeholders. Verify the output equals the input (no corruption).
7. **fillPromptTemplate with unknown placeholders**: Template has `{{unknownVar}}`. Verify it's left as-is (not replaced with undefined, not crash).

### Step 7: CLAUDE.md update verification

Read `CLAUDE.md` and check:
- Stage 1.5 is listed as DONE (not TODO) in the Scope Control section
- "DO NOT build yet" section does NOT include Stage 1.5 items
- Test stats are updated (should be 18+ files, 185+ tests, 8 packages)
- Project structure shows the `@bollard/detect` package
- Known limitations are updated (non-TS adversarial = blackbox only, no in-language until Stage 2)
- Key Types section includes `ToolchainProfile`, `VerificationCommand`, `LanguageId`

Fix any discrepancies.

### Step 8: Final verification pass

Run the full suite one more time after all fixes:

```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

Record final test counts. Print the total source LOC and test LOC across all packages:

```bash
docker compose run --rm --entrypoint sh dev -c "find packages/*/src -name '*.ts' | xargs wc -l | tail -1"
docker compose run --rm --entrypoint sh dev -c "find packages/*/tests -name '*.ts' | xargs wc -l | tail -1"
```

Expected targets: ~3500 source LOC, ~2500 test LOC across 8 packages.

---

### Important reminders

- **Read CLAUDE.md and spec/06-toolchain-profiles.md before starting.** They are the source of truth.
- **This is a verification pass, not a feature build.** Your job is to find gaps and fix them, not add new functionality.
- **If the retro-adversarial script breaks, fix the imports — don't skip it.** It's the regression test for the adversarial pipeline.
- **Tester Rules 8-15 are sacrosanct.** If any were altered during Stage 1.5, revert them to the pre-1.5 versions. They were tuned over 4 adversarial passes.
- **Every fix must preserve backward compatibility.** Functions that previously worked without a profile must still work without one.
- **Commit after each step** with message format: `Stage 1.5-verify: <what>`.
- **Run everything through Docker Compose.** Never bare `pnpm` on the host.
