# Stage 3c Validation Results

Run context: 2026-04-09, Docker `bollard-dev` image (Node 22.22.2, pnpm 10.33.0), workspace mounted at `/app`.

## Status: GREEN

## Baseline


| Metric          | Value                                                                            |
| --------------- | -------------------------------------------------------------------------------- |
| Docker build    | `docker compose build dev` — clean (procps added for Stryker process management) |
| Typecheck       | `pnpm run typecheck` — clean                                                     |
| Lint            | `pnpm run lint` — clean (`.stryker-tmp` added to `biome.json` ignore)            |
| Stryker version | `@stryker-mutator/core` 9.6.0, `@stryker-mutator/vitest-runner` 9.6.0            |


## Check 1 — Stryker installation

**Pass.**

- `@stryker-mutator/core@9.6.0` and `@stryker-mutator/vitest-runner@9.6.0` installed as root devDependencies.
- `pnpm exec stryker run --help` works inside Docker container.
- Required `procps` package added to Dockerfile `dev` stage — Stryker uses `ps` for worker process cleanup, which `node:22-slim` does not include.
- Explicit `"plugins": ["@stryker-mutator/vitest-runner"]` required in `stryker.config.json` — pnpm's strict hoisting prevents Stryker's default glob-based plugin discovery (`@stryker-mutator/*`) from resolving the runner in child processes.

## Check 2 — Single-package mutation score (engine)

**Pass.**

Target: `packages/engine/src/**/*.ts` (7 files, ~824 LOC).


| Metric                   | Value      |
| ------------------------ | ---------- |
| Total mutants            | 417        |
| Killed                   | 294        |
| Timeout                  | 1          |
| Survived                 | 78         |
| No coverage              | 44         |
| Errors                   | 0          |
| **Score (total)**        | **70.74%** |
| **Score (covered only)** | **79.09%** |
| Tests in dry run         | 115        |
| Tests per mutant (avg)   | 3.42       |
| Execution time           | 46s        |


Per-file breakdown:


| File              | Score (total) | Score (covered) | Killed | Survived | No cov |
| ----------------- | ------------- | --------------- | ------ | -------- | ------ |
| `errors.ts`       | 100.00%       | 100.00%         | 16     | 0        | 0      |
| `cost-tracker.ts` | 88.06%        | 88.06%          | 59     | 8        | 0      |
| `context.ts`      | 81.36%        | 82.76%          | 48     | 10       | 1      |
| `eval-runner.ts`  | 63.93%        | 70.91%          | 78     | 32       | 12     |
| `runner.ts`       | 61.44%        | 77.05%          | 93     | 28       | 31     |


Notes:

- `errors.ts` achieves 100% mutation score — all 16 mutants killed.
- `runner.ts` has 31 no-coverage mutants, mostly in the `onFailure: "hand_to_human"` and error-path branches that require integration-level pipeline context.
- `eval-runner.ts` survivors are concentrated in threshold logic and multi-case orchestration paths.

## Check 3 — Multi-package mutation score

**Pass.**

Target: engine + detect + verify + blueprints (35 files).

Excluded packages (I/O-heavy, misleadingly low scores):

- `@bollard/agents` — filesystem I/O tools, mock-heavy
- `@bollard/cli` — CLI entry point, integration-level
- `@bollard/mcp` — MCP server wiring
- `@bollard/llm` — provider implementations, API keys required


| Metric                   | Value      |
| ------------------------ | ---------- |
| Total mutants            | 5351       |
| Killed                   | 2421       |
| Timeout                  | 4          |
| Survived                 | 1423       |
| No coverage              | 1503       |
| Errors                   | 0          |
| **Score (total)**        | **45.32%** |
| **Score (covered only)** | **63.02%** |
| Tests in dry run         | 373        |
| Tests per mutant (avg)   | 4.40       |
| Execution time           | 16m 19s    |


Per-package breakdown:


| Package    | Score (total) | Score (covered) | Killed  | Survived | No cov |
| ---------- | ------------- | --------------- | ------- | -------- | ------ |
| engine     | 70.74%        | 79.09%          | 294+1t  | 78       | 44     |
| detect     | 47.61%        | 62.62%          | 459     | 274      | 231    |
| blueprints | 37.78%        | 73.76%          | 357     | 127      | 461    |
| verify     | 43.44%        | 58.19%          | 1311+3t | 944      | 767    |


Notes:

- `verify/src/dynamic.ts` (0%) and `verify/src/static.ts` (0%) show 0% because their integration tests are excluded from the Stryker Vitest config (they run subprocess lint/typecheck that breaks on Stryker-instrumented code). 375 mutants in these two files are entirely uncovered.
- `blueprints/src/implement-feature.ts` (33.66%) has 442 no-coverage mutants — most blueprint node `execute` functions require full pipeline context (LLM mocks, Docker, filesystem) that unit tests don't exercise.
- Stryker warned about 317 static mutants (6% of total) estimated to consume 46% of runtime. Enabling `ignoreStatic` in future runs will speed up CI.
- A dedicated `vitest.stryker.config.ts` was created to exclude integration tests that spawn subprocesses (`static.test.ts`, `dynamic.test.ts`, `extractor-helpers.test.ts`).

## Check 4 — Surviving mutants analysis (engine package)

Representative surviving mutants from `@bollard/engine` (the highest-coverage package):

### Genuine test gaps


| File             | Mutant                                                         | Category                                                          |
| ---------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| `runner.ts:147`  | `if (attempt > 0) { onProgress?.(…) }` → `if (attempt > 0) {}` | Gap: retry progress callback not asserted                         |
| `runner.ts:181`  | `node.onFailure ?? "stop"` → `node.onFailure ?? ""`            | Gap: default policy string not tested directly                    |
| `runner.ts:219`  | `Date.now() - ctx.startedAt` → `Date.now() + ctx.startedAt`    | Gap: total duration value not asserted in tests                   |
| `context.ts:60`  | `now.getMonth() + 1` → `now.getMonth() - 1`                    | Gap: month formatting in run ID not pinned                        |
| `eval-runner.ts` | Threshold comparison mutations                                 | Gap: custom threshold boundary conditions not exhaustively tested |


### Acceptable survivors (equivalent or cosmetic)


| File                | Mutant                                                      | Reason                                                                |
| ------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| `runner.ts:183`     | Log message string → `""`                                   | Cosmetic: tests don't assert log message content                      |
| `runner.ts:183`     | Log context object `{ nodeId }` → `{}`                      | Cosmetic: log metadata not asserted                                   |
| `runner.ts:194,202` | `?.message ?? "Node failed"` → `?.message && "Node failed"` | Equivalent in tested paths where `message` is always defined          |
| `runner.ts:212`     | `BollardError.is(err)` → `true`                             | Equivalent in tests that only throw BollardError                      |
| `runner.ts:229`     | `error !== undefined` → `true`                              | Tests always have error or success; intermediate states not exercised |
| `runner.ts:163`     | `lastResult.status !== "fail"` → `false`                    | Equivalent: retry loop only runs with fail status in tests            |


### Summary

The majority of engine survivors fall into two categories:

1. **Log/progress callback content** — tests verify side effects happen but don't pin exact strings or metadata objects.
2. **Operator equivalents** — mutations produce equivalent behavior in the tested code paths (e.g., `??` vs `&&` when the left operand is always truthy in tests).

Both categories are appropriate for a second-pass test-hardening effort but do not indicate logic bugs.

## Check 5 — Threshold calibration


| Scope                      | Recommended threshold | Reasoning                                                                              |
| -------------------------- | --------------------- | -------------------------------------------------------------------------------------- |
| Single package (engine)    | **70%**               | Observed 70.74%; achievable for pure-logic packages                                    |
| Multi-package (4 packages) | **45%**               | Observed 45.32%; heavily penalized by integration-excluded files with 0%               |
| Pipeline default           | **60%**               | Reasonable for targeted project code where tests exist; above the covered-only average |


**Recommendation:** Set the default `mutation.threshold` to **60%** in the pipeline. This is:

- Below the engine-only score (70.74%) — projects with good unit tests will pass.
- Above the multi-package total (45.32%) — but that score is artificially low due to integration test exclusion.
- Close to the multi-package covered-only score (63.02%) — a meaningful bar for code that tests actually exercise.

Individual projects can override via `.bollard.yml` `mutation.threshold`.

## Check 6 — Pipeline integration

The `run-mutation-testing` node (node 16 of 19 in `implement-feature`) is wired and functional:

- **Gate:** `profile.mutation?.enabled` — opt-in, skips with `{ skipped: true }` when disabled.
- **Execution:** Calls `runMutationTesting(workDir, profile)` which routes to `StrykerProvider.run()`.
- **Context:** Sets `ctx.mutationScore = result.score`.
- **Logging:** Emits `mutation_testing_result` event with full metrics.
- **Threshold:** Fails with `MUTATION_THRESHOLD_NOT_MET` when `score < profile.mutation.threshold`.

Full pipeline integration test deferred — requires `BOLLARD_AUTO_APPROVE=1` and an LLM key for the agentic nodes upstream. The node's unit test (`implement-feature.mutation.test.ts`) validates the skip/execute/threshold logic.

## Configuration fixes discovered during validation

1. `**procps` in Dockerfile** — Stryker uses `ps -o pid --no-headers --ppid` for worker process management. `node:22-slim` does not include `ps`. Added `procps` to the `dev` stage `apt-get install`.
2. **Explicit plugin list** — pnpm's strict hoisting prevents Stryker's glob-based discovery (`@stryker-mutator/*`) from resolving the vitest runner in child processes. Added `"plugins": ["@stryker-mutator/vitest-runner"]` to `stryker.config.json`.
3. `**vitest.stryker.config.ts`** — Stryker instruments source files for coverage tracking. Integration tests that run real `pnpm run lint`/`pnpm run typecheck` fail on the instrumented code. Created a Stryker-specific Vitest config excluding `static.test.ts`, `dynamic.test.ts`, and `extractor-helpers.test.ts`.
4. `**.stryker-tmp` in Biome ignore** — Stryker's sandbox directory contains instrumented source files with semicolons and comma operators that Biome flags. Added to `biome.json` `files.ignore`.

## Known gaps

1. **Integration test exclusion inflates no-coverage count.** `verify/src/static.ts` and `verify/src/dynamic.ts` show 0% because their only tests are integration tests excluded from the Stryker config. Their "real" mutation score is unknown.
2. **Static mutants slow down CI.** 317 static mutants (6%) take ~46% of runtime. Enabling `ignoreStatic: true` in `stryker.config.json` would cut multi-package run time roughly in half.
3. **Blueprint node coverage requires integration mocks.** `implement-feature.ts` has 442 no-coverage mutants. Testing these requires full `PipelineContext` stubs with LLM, Docker, and filesystem mocks — a separate testing effort.
4. **Multi-package run exceeds 10 minutes (16m19s).** WS5 scope-aware targeting will reduce this by running Stryker only against files changed in a given pipeline run.
5. **Full pipeline integration test not run.** The `run-mutation-testing` node has not been exercised in a live `implement-feature` self-test (requires LLM key + `BOLLARD_AUTO_APPROVE=1`). Unit-level validation is complete.

## Commit log


| Commit        | Summary                                                                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (this commit) | Stage 3c: self-host Stryker validation — `stryker.config.json`, `vitest.stryker.config.ts`, `procps` in Dockerfile, Biome ignore, baseline scores, validation doc, CLAUDE.md update |


## Remainder (2026-04-16)

**Status:** GREEN on fast suite (`dev` image).


| Check                | Result                            |
| -------------------- | --------------------------------- |
| `pnpm run typecheck` | Clean                             |
| `pnpm run lint`      | Clean                             |
| `pnpm run test`      | 584 passed, 2 skipped (586 total) |


### Shipped

- **Polyglot mutation:** `MutmutProvider` (Python / mutmut), `CargoMutantsProvider` (Rust / cargo-mutants), routing from `runMutationTesting` by `LanguageId`; extended tests in `packages/verify/tests/mutation.test.ts`.
- **Semantic review:** `packages/verify/src/review-grounding.ts` (parse + corpus + grounding), `semantic-reviewer` agent + blueprint nodes `generate-review-diff`, `semantic-review`, `verify-review-grounding`; `approve-pr` shows grounded findings.
- **Streaming:** Anthropic `chatStream` + `executeAgent` consumption + `stream_delta` progress events; OpenAI and Google `chatStream` implementations throw `PROVIDER_NOT_FOUND` until wired to vendor streaming APIs.
- `**go.work` detection:** `parseGoWorkUses` in `packages/detect/src/languages/go.ts`; detects workspaces with `go.work` but no root `go.mod`; root `go.mod` still takes precedence when both exist; fixture `packages/detect/tests/fixtures/go-workspace/`.

### Pipeline shape

The `implement-feature` blueprint is **22 nodes** (contract block, then `run-mutation-testing`, review block, then `docker-verify`, then diff / approve). Older references elsewhere in this file to “19 nodes” or “node 16 of 19” describe the pre-remainder ordering.

### Scope clarification

The following items were originally tracked under Stage 3c but have been moved to Stage 4 (see [ROADMAP.md](./ROADMAP.md) and [07-adversarial-scopes.md §12](./07-adversarial-scopes.md)):

- **Java/Kotlin language expansion (Wave 1)** — mutation-testing integration pattern needed to stabilize on TS/Python/Rust first.
- **OpenAI / Google streaming parity** — Anthropic `chatStream` shipped; others remain stubs.
- **Verification summary batching** — single consolidated feedback message instead of per-check retries.
- **Git rollback on coder max-turns failure** — needs a worktree/branch strategy.

Stage 3 (3a + 3b + 3c) is complete as of this validation.