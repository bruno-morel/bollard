# Self-Test and Stage-Validation History

> Archived per-run self-test logs and stage-validation snapshots relocated from CLAUDE.md (2026-06-20). Auto never-touch via the `self-test-*` content-class denylist.

## Per-run self-test logs (from CLAUDE.md)

Bollard-on-Bollard self-test **2026-05-11** (run id `20260511-0314-run-fef3d9`, CostTracker.divide validation task) completed **29/29** nodes successfully.

Self-test **2026-05-13** (run id `20260513-0248-run-e19e6e`, Stage 5d Phase 5 — `CostTracker.divide` validation) finished with CLI **success** and **31/31** steps, but `static-checks` and `run-tests` nodes recorded `status: fail` (skipped per `onFailure: skip`). Total cost **$16.17** (~**+2467%** vs $0.63 anchor); **implement** ~**699s**, **$8.28** (coder **80** turns + rollback + **79** turns on retry **2/2**). Boundary grounding **15/15** (drop 0), contract **10/10** (drop 0). Manual follow-up: `biome format` + `import type` for `PublicCostTracker` restored **1000 passed / 6 skipped**.

Self-test **2026-05-18** (run id `20260518-2327-run-1c01db`, Stage 5a validation — `runCount()` method) completed **31/31** nodes successfully. Total cost **$0.88** (~**-66%** vs $2.56 baseline); **implement** ~**118s**, **$0.79** (coder **19** turns). Boundary grounding **11/11** (drop 0), contract **5/8** (drop 3).

Self-test **2026-05-19** (run id `20260519-0005-run-afec32`, Stage 5d Phase 2 validation — `formatCost()`) completed **31/31** nodes successfully. Total cost **$1.63**; **implement** ~**118s**, **$1.55** (coder **32** turns). Tier 1 patcher fired on post-completion hook.

Self-test **2026-05-24** (run id `20260524-2344-run-794b98`, `CostTracker.multiply()` verification-only re-run — post write-tests/contract fallbacks + adversarial vitest routing) completed **31/31** nodes successfully. Total cost **$0.43**; **implement** ~**48.5s**, **$0.25** (coder **11** turns). Boundary grounding **14/14** (drop 0), contract **4/9** (drop 5). `run-tests` recorded **fail** (14/14 adversarial cases: `new CostTracker()` missing `limitUsd`; skipped per `onFailure: skip`). Signal 1: **not promoted** (no candidates listed at `approve-pr`). See [spec/self-test-multiply-results.md](./self-test-multiply-results.md).

Self-test **2026-05-25** (run id `20260525-0038-run-ee973e`, `CostTracker.clamp()` — first full forward run after all infrastructure fixes) completed **31/31** nodes successfully. Total cost TBD; coder completed turn 54 with `stop=end_turn` after hard-exit fired at turn 53 (previously caused Anthropic 400 on the prior clamp attempt `20260525-0019-run-45addb`). **Executor tool_use/tool_result pairing fix validated** — no `LLM_PROVIDER_ERROR` on long coder runs crossing the hard-exit boundary.

Self-test **2026-05-25** (run id `20260525-0343-run-cb1abe`, `CostTracker.merge()` — first full forward run with post-clamp hardening: scope guard, structured test output, agentBudgets enforcement) completed **31/31** nodes successfully. Total cost **$4.75**; **implement** ~**361s**, **$4.61** (coder **51** turns). Boundary grounding **17/17** (drop 0), contract **1/8** (drop 7). Scope guard: did not fire on coder (no OOB writes); in-plan test-file churn drove cost. `cost-baseline diff` **FAIL** (+34.5% vs baseline). See [spec/self-test-merge-results.md](./self-test-merge-results.md).

Self-test **2026-05-25** (run id `20260525-2025-run-ecae8e`, `CostTracker.withLimit()` — Phase 14/15 validation: contract grounding corpus fix + Stryker binary path fix) halted at **16/31** nodes (`run-contract-tests` fail). Total cost **$4.75**; **implement** ~**174s**, **$4.61** (coder **54** turns). Boundary grounding **15/15** (drop 0), contract **6/8** (drop 2 — **25% vs 87.5% pre-fix**; Phase 14 validated). Stryker: **not reached** (Phase 15 deferred). `cost-baseline diff` **FAIL**. See [spec/self-test-with-limit-results.md](./self-test-with-limit-results.md).

Self-test **2026-05-25** (run id `20260525-2109-run-b8c50b`, `CostTracker.limitUsd()` — Phase 15 validation: Stryker direct binary path + continued Phase 14 observation) completed **31/31** nodes successfully. Total cost **$5.02**; **implement** ~**176s**, **$4.91** (coder **54** turns). Boundary grounding **9/11** (drop 2), contract **6/8** (drop 2). Stryker: `stryker_no_mutants` (totalMutants 0). See [spec/self-test-limit-accessor-results.md](./self-test-limit-accessor-results.md).

Self-test **2026-05-25** (run id `20260525-2222-run-39f3e2`, `CostTracker.toJSON()` — Stryker live pipeline validation) completed **31/31** nodes successfully. Total cost **$1.32**; **implement** ~**99s**, **$1.19** (coder **16** turns). Boundary grounding **12/12** (drop 0), contract **5/7** (drop 28.6%). Stryker: **totalMutants 204**, score **90.20%**. Infra fix: `deriveVitestConfigFile` prefers `vitest.stryker.config.ts`. See [spec/self-test-to-json-results.md](./self-test-to-json-results.md).

Self-test **2026-05-27** (run id `20260527-0056-run-ace38a`, `CostTracker.percentUsed()` — Phase 16 test-surgery-loop guard validation) completed **31/31** nodes successfully. Total cost **$1.90**; **implement** ~**163s**, **$1.77** (coder **22** turns). Boundary grounding **10/10** (drop 0), contract **8/8** (drop 0%). Stryker: **totalMutants 217**, score **85.25%**. Phase 16 guard: Layer 1 **fired** (blocked `cost-tracker.test.ts` edits), Layer 2 **did not fire**. See [spec/self-test-percent-used-results.md](./self-test-percent-used-results.md).

Self-test **2026-05-27** (run id `20260527-0134-run-3be761`, `CostTracker.cap()` — Phase 16 third validation + baseline retag attempt) completed **31/31** nodes successfully. Total cost **$0.20**; **implement** ~**53s**, **$0.06** (coder **3** turns — verification-only, code pre-merged after forward attempts). Boundary grounding **16/18** (drop 11.1%), contract **6/6** (drop 0%). Stryker: **stryker_no_mutants** on pipeline (manual smoke **85.11%** post unit tests). Phase 16 guard: Layer 1 **did not fire** on authoritative run; **fired** on forward attempts (`5dce47`/`2a12d4`, 34–38 turns / $3.17–$3.63). Baseline retag **skipped** — no forward run under $1.96 ceiling. See [spec/self-test-cap-results.md](./self-test-cap-results.md).

Self-test **2026-05-27** (run id `20260527-0207-run-446ba7`, `CostTracker.scale()` — Phase 17 live validation) completed **31/31** nodes (CLI success). Total cost **$3.41**; **implement** ~**256s**, **$3.25** (coder **54** turns). Boundary grounding **20/20** (drop 0), contract **8/10** (drop 2). Phase 17 Rule 11 **fired** — planner emitted `cost-tracker-scale.test.ts` in `affected_files.create`; coder wrote file at turn 2; fallback injection **not needed**. Stryker: **totalMutants 274**, score **85.77%** (post-fix; pipeline run had `stryker_no_mutants` due to test parse errors; fixed by rewriting test file, rerunning Stryker manually). `static-checks`/`run-tests` **fail** (skipped). **Latest test count: 1300 passed / 6 skipped** (post Phase 18 +3 tests). See [spec/self-test-scale-results.md](./self-test-scale-results.md).

Self-test **2026-05-27** (run id `20260527-0259-run-2b1364`, `CostTracker.floor()` — Phase 18 write-once guard validation) halted at **17/31** nodes (`run-contract-tests` fail — LLM contract assertion 2.06 vs correct 2.05; fixed post-run). Total cost **$1.18**; **implement** ~**133s**, **$1.05** (coder **23** turns). Phase 18 write-once guard: **not needed** (coder wrote unit test at turn 8, no `edit_file` on test file; **5** `run_command` test invocations on `cost-tracker-floor.test.ts` drove turns above <15 target). Boundary grounding **10/11** (drop 9.1%), contract **14/14** (drop 0%). Stryker (manual smoke): **totalMutants 294**, score **86.73%**. `cost-baseline diff` **FAIL** (repo avg). See [spec/self-test-floor-results.md](./self-test-floor-results.md).

Self-test **2026-05-27** (run id `20260527-0353-run-f157de`, `CostTracker.exceeded()` — Phase 18c `blockedTestPaths` guard validation attempt) completed **31/31** nodes (CLI success) but **Phase 18c not exercised** — degenerate run: planner `affected_files` empty, `non_goals` blocked new test file; coder **5** turns, no `cost-tracker-exceeded.test.ts`, no write-once guard error. Total cost **$0.21**; **implement** ~**39s**, **$0.11**. Boundary grounding **9/10** (drop 10%), contract **1/4** grounded (drop 75%). See [spec/self-test-exceeded-results.md](./self-test-exceeded-results.md).

**Root cause fixed (commit `5324403`) + re-validated GREEN (run `20260527-0444-run-7c8778`):** Phase 18b fired at turn 5 (write_file on `cost-tracker-exceeded.test.ts`), Phase 18c blocked `run_command` at turn 6. Coder 32 turns (elevated by mid-run test-suite failures from stale mocks — not guard regression; all fixed in commits `570c625`–`632b3b5`). `cost-tracker-exceeded.test.ts` committed to main. **Latest test count: 1348 passed / 6 skipped.**

Self-test **2026-05-28** (run id `20260528-0353-run-f616b1`, `CostTracker.reset()` — Stage 5c parallel scope execution validation) completed **17/17** top-level steps (CLI success). Total cost **$3.38**; **implement** ~**297s**, **$3.25** (coder **36** turns). Boundary grounding **12/12** (drop 0%), contract **0/8** (short claim IDs; fallback fires). Stryker: `stryker_no_mutants` (Babel parse error on syntax artifact). Parallel execution confirmed: `scope-extraction` group wall time **655ms** (3 concurrent branches), `scope-chains` group wall time **11.8s** (3 concurrent adversarial agents). `ls` in `DEFAULT_ALLOWED_COMMANDS` (Stage 5e Phase 2).

Self-test **2026-06-02** (run id `20260602-0343-run-d0c256`, `CostTracker.available()` — Stage 5e Phase 1–3 live validation) completed **17/17** top-level steps (CLI success). Total cost ~**$3.05**; **implement** ~**428s**, **$2.93** (coder **49** turns). Boundary grounding **11/12** (bnd4 dropped, drop 8.3%), contract **7/7** (drop 0%). `static-checks` **fail** (skipped — typecheck error from coder full-file rewrite at turn 18). Mutation: **skipped** (Stryker preflight fired — Stage 5e Phase 3 validated in production: tsc error caught before Stryker launch). Semantic review: **1/11** grounded (r1 — plan divergence: coder extended Infinity support to constructor, `withLimit()`, `remaining()`, `percentUsed()`, `summary()` beyond plan scope; required for `new CostTracker(Infinity)` to work). `cost-tracker.adversarial.test.ts` replaced by boundary-tester with 11 available() tests. Phase 18b fired on `cost-tracker-available.test.ts` at turn 2. Follow-up: fix tsc error in branch `bollard/20260602-0343-run-d0c256`, `biome format`, verify final test count.

Self-test **2026-06-04** (run id `20260604-0303-run-7c191e`, `CostTracker.humanReadable()` — post-5e hardening validation) completed **17/17** top-level steps (CLI success). Total cost **$1.55**; **implement** ~**195s**, **$1.44** (coder **26** turns). Boundary grounding **14/14** (drop 0%), contract **8/8** (drop 0%). Semantic review grounding **1/4** kept (drop 75% — improved vs 1/11 pre-fix but below 50% target). Overwrite guard: **did not fire** (new test file only). `static-checks` **fail** (skipped); mutation **skipped** (Stryker preflight tsc). Cost baseline retagged **`post-5e-hardening`** ($1.5494). See [spec/self-test-humanreadable-results.md](./self-test-humanreadable-results.md).

Self-test **2026-06-04** (run id `20260604-0334-run-b89290`, `CostTracker.isUnlimited()` — three-prompt hardening validation) completed **17/17** top-level steps (CLI success). Total cost **$1.05**; **implement** ~**198s**, **$0.95** (coder **17** turns). Boundary grounding **7/7** (drop 0%), contract **6/6** (drop 0%). Semantic review grounding **2/5** kept (40% — improved vs 25% humanReadable but below 50% target). Overwrite guard: **did not fire** (new test file only). `static-checks` **fail** (skipped — audit only); mutation **skipped** (Stryker preflight single-file tsc false positive). Cost baseline retagged **`post-prompt-hardening`** ($1.0537). See [spec/self-test-isunlimited-results.md](./self-test-isunlimited-results.md).

## Stage 2 Validation (2026-04-02)

- **Test suite:** 344/344 pass, typecheck clean, lint clean
- **Milestone (TS):** Pipeline ran nodes 1–5 (create-branch → generate-plan → approve-plan → implement → static-checks). Coder correctly used `edit_file` for existing files. Failed at static-checks (Biome lint formatting) due to `deferPostCompletionVerifyFromTurn` (née `skipVerificationAfterTurn`) skipping lint after turn 48/60.
- **Milestone (Python):** `--work-dir` flag validated. `detectToolchain` correctly identified Python/pytest/ruff. Planner produced Python-specific plan. Coder exhausted 60 turns because `python`/`pytest` were not in `allowedCommands` — **fixed in post-validation cleanup** (test.cmd and pip-audit now whitelisted).
- **Retro-adversarial:** Tester generated tests for 5 packages ($0.34 total). Information barrier held (no private identifiers leaked). All outputs include property-based tests. Key issue: tester constructs invalid ToolchainProfile stubs (uses wrong field names). See `../.bollard/retro-adversarial/SUMMARY.md`.
- **Bug fixed:** `eval-runner.ts` regex validation — invalid regex in `matches_regex` assertion now returns `passed: false` instead of crashing.
- **Post-validation cleanup (2026-04-02):** Fixed Python `allowedCommands` gap, added `LlmFallbackExtractor` warn logging, renamed `integrateWithTestRunner` → `checkTestRunnerIntegration` with corrected return semantics, hardened `promote-test` CLI command, aligned MCP `tsconfig.json`, archived 12 historical spec prompts.

## Stage 3a Validation (2026-04-08) — Status **GREEN**

Full per-check results: [`./stage3a-validation-results.md`](./stage3a-validation-results.md).

- **Test suite (post-GREEN, 2026-04-08):** 461 passed / 4 skipped; typecheck + lint clean. (+55 from grounding golden corpus and pipeline-generated `CostTracker.subtract()` tests.)
- **Information barrier fix:** `buildContractContext` now limits `publicExports` / reachable types to files in the `package.json` `exports["."]` re-export closure — private engine internals (`compactOlderTurns`, `deferPostCompletionVerifyFromTurn`, etc.) no longer leak into the contract-tester prompt. Regression test added.
- **Executor rename:** `ExecutorOptions.skipVerificationAfterTurn` → `deferPostCompletionVerifyFromTurn` (more accurately describes the deferral semantics — the post-completion verification hook is deferred above the 80% turn budget, not permanently skipped).
- **`pnpm-workspace.yaml` `overrides` — transitive security floors:** Bollard's static `audit` check runs `pnpm audit --audit-level=high` (`packages/verify/src/static.ts`), so any HIGH advisory in the lockfile fails `static-checks` locally AND the `bollard-verify` CI workflow. After the 2026-06 dependency refresh removed the original override block, several transitive chains re-pinned vulnerable versions; the current floors (pnpm 11 keeps `overrides` in `pnpm-workspace.yaml`, not `package.json`) are: `vite "8.0.16"` (exact — `>=` did not lift 8.0.7), `esbuild >=0.28.1`, `hono >=4.12.25` (all HIGH), `qs >=6.15.2`, `ip-address >=10.1.1`, `protobufjs >=7.6.3`, `@babel/core >=7.29.1` (moderate/low, needed for `pnpm audit` = 0). Remove each only when its upstream chain ships a patched version naturally and `pnpm audit` stays clean without it. **This is the mechanism by which Bollard's own CI caught a post-refresh HIGH vuln (vite/esbuild) on `main` — the audit step doing its job.**
- **`runBlueprint` takes `toolchainProfile`:** New optional positional; `runBlueprint(blueprint, task, config, agenticHandler?, humanGateHandler?, onProgress?, toolchainProfile?)` sets `ctx.toolchainProfile` from the passed profile. The CLI `implement-feature` command now threads the `resolveConfig` profile through — **previously contract nodes silently skipped** because the context field was unset.
- **Vitest contract config for `.bollard/` paths:** Vitest's default `include` ignores `.bollard/**`, so `runTests` now uses `vitest.contract.config.ts` (workspace `@bollard/*` aliases + `.bollard/**` include) whenever the requested test file paths touch `.bollard/`. Integration test in `packages/verify/tests/dynamic.test.ts`.
- **Toolchain-gated extractor tests:** `packages/verify/tests/type-extractor.test.ts` now has `it.skipIf` integration tests for Python / Go / Rust with explicit `TODO(stage-3b)` titles when the toolchain is absent from the dev image.
- **`.bollard/validation-fake-plan.json` gitignored:** Local convenience for `bollard contract --plan <file>` checks.

### Stage 3a commits on `main`

| Commit | Summary |
|--------|---------|
| `ff0fa7c` | Contract context limited to entry-export closure; `deferPostCompletionVerifyFromTurn` rename; information-barrier regression test; ignore `validation-fake-plan.json` |
| `614dc33` | `pnpm.overrides` for `vite >= 7.3.2` — clears audit blocker in `static-checks` |
| `b81a4b7` | Thread `ToolchainProfile` into `runBlueprint` / `PipelineContext`; CLI wires `resolveConfig` profile into `implement-feature` |
| `13cfc1e` | Toolchain-gated Go/Rust/Python extractor integration tests |
| `f14bd66` | `vitest.contract.config.ts` + `runTests` branch for `.bollard/` paths; dynamic integration test; Biome override |

### GREEN — validated 2026-04-08

Full 17-node `implement-feature` self-test ran against the `CostTracker.subtract()` task:

- 17/17 nodes passed on first attempt, no retries (Node count increased to 18 post-validation with the addition of the risk-gate skeleton, Stage 3a+ commit <TBD>.)
- `verify-claim-grounding`: 5 claims proposed / 5 grounded / 0 dropped
- Surviving contract tests in `.bollard/tests/contract/add-a-subtract-usd-method/cost-tracker.contract.test.ts` assert legitimate properties (negative input throws, underflow throws, basic subtraction, interaction with `add`, `snapshot` reflects subtracted cost). No float-exactness or frozen-mutation traps.
- Test suite before → after: 406 passed / 4 skipped → **461 passed / 4 skipped** (+55 from golden corpus and pipeline-generated tests)

Grounding-layer post-mortem and the "when to add a deterministic filter" principle are captured in [spec/adr/0001-deterministic-filters-for-llm-output.md](./adr/0001-deterministic-filters-for-llm-output.md). Read it before adding any similar post-filter in Stage 3b.

**Reproduction command** (for future regression runs — the `sh -c` wrapper is mandatory because Compose v2 intercepts bare `--filter`):

```bash
docker compose run --rm -e BOLLARD_AUTO_APPROVE=1 dev sh -c \
  'pnpm --filter @bollard/cli run start -- run implement-feature --task "…" --work-dir /app'
```

## Stage 3b Validation (2026-04-09) — Status **GREEN**

Full per-check results: [`./stage3b-validation-results.md`](./stage3b-validation-results.md).

- **Test suite:** 523 passed / 2 skipped; typecheck + lint clean.
- **Dev image:** `bollard-extract-go` 0.1.0, `bollard-extract-rs` 0.1.0, Python 3.11.2 on PATH.
- **`dev-full` image:** 2.23 GB — Go 1.22.6, Rust 1.94.1, Python 3.11.2, pytest 9.0.3, ruff 0.15.10.
- **Extractors:** All four deterministic extractors pass (TS:2, Py:2, Go:4, Rs:4) + 3 helper binary tests.
- **Contract providers:** 22 tests across `buildContractContext` router (7), `PythonContractProvider` (5), `GoContractProvider` (5), `RustContractProvider` (5).
- **Contract graph (self):** 8 modules, 18 edges, all TypeScript — identical to Stage 3a baseline.
- **Risk gate polyglot:** 16 `scanDiffForExportChanges` tests (TS + Python + Go + Rust).
- **Test parsers polyglot:** 8 `parseSummary` tests (Vitest + pytest + `go test` + `cargo test`).
- **Fixture tests:** Python (2 modules / 1 edge), Go (2/1 with root `go.mod`), Rust (2/1).
- **ADR-0002:** `spec/adr/0002-syn-helper-for-rust-extraction.md` exists with correct frontmatter.
- **File structure:** Barrel 7 lines, 5 provider files (1,367 LOC), no stale monolith.

### GREEN — validated 2026-04-09

Full 18-node `implement-feature` self-test ran against the `CostTracker.subtract()` task:

- **18/18 nodes passed** on first attempt, 0 retries
- `verify-claim-grounding`: 6 claims proposed / 6 grounded / 0 dropped
- `contract_grounding_result`: `{"proposed":6,"grounded":6,"dropped":0,"dropRate":0}`
- Coder turns: 42/60, cost $1.40, duration 222s
- Post-run cleanup restored test suite to 523 passed / 2 skipped

### Stage 3b commits on `main`

| Commit | Summary |
|--------|---------|
| `cb37b8b` | Stage 3a+: contract-scope risk gate skeleton |
| `663dd14` | Stage 3a+: risk-gate measurement correctness |
| `b43e0e3` | Stage 3b: polyglot dev image + slim dev-full (2.43GB → 2.24GB) |
| `122ca6b` | Stage 3b: rewrite Rust extractor to shell out to bollard-extract-rs |
| `4274ffc` | Stage 3b: ADR-0002 — syn helper for Rust signature extraction |
| `bb3f9d5` | Stage 3b: refactor buildContractContext into ContractGraphProvider |
| `d5d116a` | Stage 3b: add GoContractProvider to buildContractContext |
| `8d05523` | Stage 3b: split contract-extractor.ts into per-provider files (PythonContractProvider) |
| `6676004` | Stage 3b: add RustContractProvider to buildContractContext |
| `0e0a6b1` | Stage 3b: cleanup gitignore, worktree ref, and Go extractor tweaks |
| `d3ee41c` | Stage 3b: polyglot risk gate + test summary parsers |

### Stage 3 completion log

All Stage 3 work (3a, 3b, 3c) is complete. Items 1–8 shipped; items 9–10 and four others moved to Stage 4c.

1. ~~**Contract-tester grounding (Layer 1)**~~ — **Done (Stage 3a).** `contract_grounding_result` log event emits per run.
2. ~~**Go / Rust in the dev image**~~ — **Done (Stage 3b).** `bollard-extract-go` and `bollard-extract-rs` in dev image; `dev-full` adds full toolchains.
3. ~~**Contract graph beyond TypeScript**~~ — **Done (Stage 3b).** `ContractGraphProvider` + Python / Go / Rust providers.
4. ~~**Risk gate per-language refinement**~~ — **Done (Stage 3b).** `scanDiffForExportChanges` with TS/Python/Go/Rust patterns.
5. ~~**Per-language mutation testing**~~ — **Done (Stage 3c).** Stryker (TS/JS), `MutmutProvider` (Python), `CargoMutantsProvider` (Rust).
6. ~~**Semantic review agent**~~ — **Done (Stage 3c).** `semantic-reviewer` agent + `review-grounding.ts` + grounding verifier. Advisory only.
7. ~~**Streaming LLM responses**~~ — **Done (Stage 3c Anthropic + Stage 4c Part 1 OpenAI/Google).** All three providers implement `chatStream`; executor + `stream_delta` events.
8. ~~**`detectToolchain` for `go.work`-only layouts**~~ — **Done (Stage 3c).** `parseGoWorkUses` in `go.ts`.

**Moved to Stage 4c:** Java/Kotlin language expansion (Wave 1). Verification summary batching + coder git rollback are **done** (Stage 4c cleanup). See [spec/ROADMAP.md](./ROADMAP.md).

