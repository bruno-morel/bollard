# Stage 3c Plan: Per-language mutation testing

> **Focus:** Build the mutation testing layer for TypeScript/JavaScript using Stryker, validate it self-hosts on Bollard, and establish the integration pattern that mutmut (Python) and cargo-mutants (Rust) will follow in Stage 3c-b/3c-c.

## Why mutation testing

Adversarial tests (boundary + contract) verify that the code handles edge cases and respects contracts. But they don't answer: **are the existing tests actually catching bugs?** A test suite can have 100% line coverage and still miss real defects if the tests are weak (e.g. they assert on return types but not return values).

Mutation testing answers this by introducing small defects (mutations) into the code and checking whether the test suite catches them. A mutation that survives all tests is a **genuine coverage gap** — the tests don't notice when that code changes. The mutation score (killed / total * 100) is the strongest available proxy for test suite quality.

Bollard's design principle #1 says "anything that CAN be deterministic MUST be deterministic." Mutation testing is deterministic — no LLM involved. It's the mechanical proof that the verification layer (both project tests and adversarial tests) is actually meaningful.

## Architecture

### Where mutation testing fits in the pipeline

The `implement-feature` blueprint currently has 18 nodes. Mutation testing adds **one new node** after `run-contract-tests` (node 15) and before `docker-verify` (node 16):

```
15. run-contract-tests
16. NEW: run-mutation-testing    ← Stryker against project tests + adversarial tests
17. docker-verify
18. generate-diff
19. approve-pr
```

The mutation testing node:

1. Generates a Stryker config from `ToolchainProfile` (mutate targets = `sourcePatterns`, test runner = `vitest`)
2. Runs `npx stryker run --reporters json` inside the work dir
3. Parses `reports/mutation/mutation.json` (Stryker's standard output)
4. Computes the aggregate mutation score
5. Sets `ctx.mutationScore` on `PipelineContext`
6. Fails with `MUTATION_THRESHOLD_NOT_MET` if score < threshold (configurable in `.bollard.yml`)

### Stryker integration shape

Stryker is a dev dependency, not a runtime dependency. It runs via `npx stryker run` (or `pnpm exec stryker run`), same pattern as Vitest. The integration is:

1. **Config generation** — generate a `stryker.config.json` in the work dir:
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
   The `mutate` array comes from `profile.sourcePatterns`, filtered to exclude test files. The `vitest.configFile` comes from `profile.checks.test` if available.

2. **Execution** — run `pnpm exec stryker run` with a timeout (5 minutes default, configurable). Stryker is CPU-intensive; `concurrency: 2` keeps it reasonable in Docker.

3. **Result parsing** — read `reports/mutation/mutation.json`. The schema (from [mutation-testing-elements](https://github.com/stryker-mutator/mutation-testing-elements)) has:
   ```typescript
   interface MutationReport {
     schemaVersion: string
     thresholds: { high: number; low: number }
     files: Record<string, {
       language: string
       source: string
       mutants: Array<{
         id: string
         mutatorName: string
         status: "Killed" | "Survived" | "NoCoverage" | "CompileError" | "RuntimeError" | "Timeout" | "Ignored" | "Pending"
         location: { start: { line: number; column: number }; end: { line: number; column: number } }
       }>
     }>
   }
   ```
   Mutation score = `(killed + timeout) / (killed + timeout + survived + noCoverage) * 100`.

4. **Threshold gating** — configurable via `.bollard.yml`:
   ```yaml
   mutation:
     threshold: 80      # minimum mutation score (percentage)
     timeout_ms: 300000  # 5 minutes
     concurrency: 2
   ```
   Default threshold: **80%** (Stryker's conventional "high" mark). Below threshold → `MUTATION_THRESHOLD_NOT_MET`.

5. **Scope interaction** — mutation testing runs against **all test suites**: project tests + boundary adversarial tests + contract adversarial tests. A mutation that survives all three is a genuine gap. Stryker discovers all Vitest tests automatically; no special configuration needed for the adversarial tests in `.bollard/`.

### What goes where

| Package | New/Changed | Purpose |
|---------|-------------|---------|
| `@bollard/detect` | `types.ts` | Add `MutationConfig` to `ToolchainProfile` |
| `@bollard/verify` | new `mutation.ts` | `runMutationTesting(workDir, profile)` — config generation, execution, result parsing |
| `@bollard/blueprints` | `implement-feature.ts` | New `run-mutation-testing` node (node 16) |
| `@bollard/cli` | `config.ts` | Parse `mutation:` from `.bollard.yml` |
| `@bollard/engine` | `context.ts` | `mutationScore` already exists on `PipelineContext` |
| `@bollard/engine` | `errors.ts` | `MUTATION_THRESHOLD_NOT_MET` already exists |
| Root | `Dockerfile` | Install `@stryker-mutator/core` + `@stryker-mutator/vitest-runner` in `dev` |

### MutationTestingProvider interface (future-proofing)

Same pattern as `ContractGraphProvider` — define an interface now, implement Stryker first, add mutmut/cargo-mutants later:

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

## Workstream breakdown

### WS1: MutationTestingProvider interface + Stryker implementation

**Files:**
- `packages/verify/src/mutation.ts` — `MutationTestResult`, `MutationTestingProvider`, `StrykerProvider`, `runMutationTesting` router
- `packages/verify/tests/mutation.test.ts` — unit tests for config generation + result parsing (mocked `execFileAsync`)

**Scope:**
- `StrykerProvider.run()` generates `stryker.config.json`, executes `pnpm exec stryker run`, parses `reports/mutation/mutation.json`, returns `MutationTestResult`
- Config generation from `ToolchainProfile`: `mutate` from `sourcePatterns`, test runner from `checks.test`, thresholds from `mutation.threshold`
- Result parsing: read the JSON report, compute score, count statuses
- Graceful degradation: if Stryker is not installed or fails, return `{ score: 0, totalMutants: 0, ... }` with a warning (same pattern as extractor helpers)
- Tests: config generation for TS profile, result parsing from sample JSON, missing Stryker binary handling

### WS2: Blueprint integration + MutationConfig on ToolchainProfile

**Files:**
- `packages/detect/src/types.ts` — add `MutationConfig` type and `mutation?` field to `ToolchainProfile`
- `packages/blueprints/src/implement-feature.ts` — new `run-mutation-testing` node
- `packages/blueprints/tests/implement-feature.test.ts` — node count update + mutation node tests
- `packages/cli/src/config.ts` — parse `mutation:` from `.bollard.yml`

**Scope:**
- `MutationConfig { threshold: number; timeoutMs: number; concurrency: number; enabled: boolean }`
- Blueprint node 16 (`run-mutation-testing`): calls `runMutationTesting(workDir, profile)`, sets `ctx.mutationScore`, fails on `MUTATION_THRESHOLD_NOT_MET`
- Node is **skipped** when `profile.mutation?.enabled !== true` (opt-in for Stage 3c; default enabled in Stage 4+)
- `.bollard.yml` `mutation:` section parsing + `resolveConfig` integration

### WS3: Docker image + dependency installation

**Files:**
- Root `Dockerfile` — install `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` as devDependencies
- `package.json` (root) — add Stryker devDependencies
- `compose.yaml` — no changes expected (same `dev` image)

**Scope:**
- Add Stryker packages to root `package.json` devDeps
- Verify `pnpm exec stryker run --version` works inside the `dev` image
- This may need a lockfile update (`pnpm install --no-frozen-lockfile` then rebuild)

### WS4: Self-host validation (Bollard's own mutation score)

**Files:**
- `stryker.config.json` at the repo root (or generated by WS1)
- `spec/stage3c-validation-results.md`

**Scope:**
- Run Stryker against Bollard itself: `pnpm exec stryker run`
- Record the baseline mutation score for each package
- Identify surviving mutants (these are genuine test gaps in Bollard's own test suite)
- Decide the threshold for the `implement-feature` pipeline (informed by the baseline)
- Document results in `spec/stage3c-validation-results.md`
- Update CLAUDE.md with mutation testing section

### WS5 (optional): Targeted mutation testing (scope-aware)

**If WS4 reveals that full-repo Stryker runs are too slow (>5 min):**
- Add `--mutate` scoping: only mutate files in `ctx.changedFiles` (the files the coder touched)
- This is the "affected files" optimization — same concept as `affectedEdges` in the contract graph
- Stryker supports this via the `mutate` config array; the node can generate it from `ctx.changedFiles`

## Out of scope for Stage 3c

- **mutmut (Python)** — Stage 3c-b. Same `MutationTestingProvider` interface, different implementation.
- **cargo-mutants (Rust)** — Stage 3c-c. Same interface, different implementation.
- **Mutation score per concern** — open question from spec/07 §15.8. Deferred.
- **Semantic review agent** — deferred to Stage 3d. Not mutation-testing-related.
- **Streaming LLM responses** — deferred. Spinner UX is sufficient.
- **`go.work`-only detection** — small fix, can land independently anytime.

## Risks

1. **Stryker + Vitest + pnpm workspaces compatibility** — Stryker's Vitest runner works with standard Vitest configs. Bollard's workspace layout (8 packages, workspace aliases) may need a `vitest.config.ts` adjustment for Stryker. WS4 will reveal this.
2. **Execution time** — Stryker against Bollard's full test suite (523 tests) will be slow. Each mutant re-runs the relevant test subset (Stryker's `perTest` coverage analysis helps), but with ~8 packages the total could be 10+ minutes. WS5 mitigates this with scope-aware mutation.
3. **Docker image size** — `@stryker-mutator/core` + `@stryker-mutator/vitest-runner` add Node.js dependencies. Should be modest (tens of MB), not in the same league as Go/Rust toolchains.
4. **Stryker's `concurrency` default** — Stryker defaults to `os.cpus().length - 1`, which in Docker may be high. Capping at `concurrency: 2` prevents OOM in constrained containers.

## Commit plan

| WS | Commits | Description |
|----|---------|-------------|
| 1 | 1 | MutationTestingProvider + StrykerProvider + result parser + tests |
| 2 | 1 | Blueprint node + MutationConfig + CLI config + tests |
| 3 | 1 | Dockerfile + package.json deps + lockfile |
| 4 | 1 | Self-host validation results + CLAUDE.md + stryker.config.json |
| 5 | 1 | (optional) Scope-aware mutation targeting |

Sources referenced:
- [Stryker-JS GitHub](https://github.com/stryker-mutator/stryker-js)
- [Vitest Runner docs](https://stryker-mutator.io/docs/stryker-js/vitest-runner/)
- [Mutation Testing Report Schema](https://github.com/stryker-mutator/mutation-testing-elements/blob/master/packages/report-schema/src/mutation-testing-report-schema.json)
- [Stryker Configuration](https://stryker-mutator.io/docs/stryker-js/configuration/)
