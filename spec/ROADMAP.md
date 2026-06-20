# Bollard Roadmap

Features deferred from v0.1 spec to keep scope tight. These are all good ideas — they just don't belong in the first build.

## Stage 3 — COMPLETE (validated GREEN)

**Stage 3a** (contract-scope adversarial testing) — validated GREEN on 2026-04-08. See [stage3a-validation-results.md](./stage3a-validation-results.md).

**Stage 3b** (polyglot contract graphs + dev ergonomics) — validated GREEN on 2026-04-09. See [stage3b-validation-results.md](./stage3b-validation-results.md).

**Stage 3c** (mutation testing, semantic review, streaming, `go.work` detection) — validated GREEN on 2026-04-16. See [stage3c-validation-results.md](./stage3c-validation-results.md).

**Stage 4a** (behavioral-scope adversarial testing — deterministic context extraction, `behavioral-tester` agent, grounding, coarse fault injection, behavioral compose) — validated GREEN on 2026-04-16. See [stage4a-validation-results.md](./stage4a-validation-results.md).

**Stage 4b** (production feedback loop — `@bollard/observe` package: probe extraction from behavioral claims, HTTP probe runner, metrics store, deployment tracker, drift detector, flag manager, progressive rollout, probe scheduler; `extract-probes` blueprint node; CLI `probe`/`deploy`/`flag`/`drift` commands; 4 MCP tools; built-in providers only, zero external deps) — validated GREEN on 2026-04-16. See [stage4b-validation-results.md](./stage4b-validation-results.md).

**Stage 4c Part 1** (OpenAI + Google `chatStream` parity with Anthropic) — validated GREEN on 2026-04-16. See [stage4c-streaming-parity.md](./stage4c-streaming-parity.md).

**Stage 4c Part 1 hardening** (auto-format write nodes, grep→ripgrep, `rm` allowlist, model ID update) — 705 pass / 4 skip. Bollard-on-bollard self-test: 28/28 nodes, $0.63.

**Stage 4c Part 2** — Java/Kotlin Wave 1 — automated baseline **validated 2026-04-17** (744 pass / 4 skip; adversarial 331 pass). **2026-04-19:** Full validation re-run under Docker: Phase 0–2 GREEN (753 pass / 4 skip; adversarial 331). Phase 3 Bollard-on-bollard reached 14/28 nodes, surfaced cross-module contract-test placement bug. **2026-04-20 (Wave 1.1 fix):** `resolveContractTestModulePrefix` places cross-module contract tests in consumer module; conditional OWASP audit detection. **769 pass / 4 skip**. Phase 3 re-run: node 15 `run-contract-tests` now compiles and executes (2 tests, 1 pass, 1 runtime error from LLM test-design assumption — not infrastructure). Phase 4 Gradle detection GREEN (live pipeline deferred). Status **GREEN** (infrastructure validated). See [stage4c-validation-results.md](./stage4c-validation-results.md). Design: [stage4c-java-kotlin-wave1.md](./stage4c-java-kotlin-wave1.md).

**Stage 4c cleanup (DONE):** Coder verification hook includes `audit` + `secretScan` (aligned with `runStaticChecks`); no-profile fallback adds them when `pnpm`/`gitleaks` are on PATH. `**static-checks`** and `**run-tests**` blueprint nodes use `onFailure: "skip"` so the pipeline does not stop there after the coder’s batched verification retries. `**ctx.rollbackSha**` records HEAD after branch creation; on coder agent failure, CLI resets the working tree to that SHA when `ctx.gitBranch` is set.

**Stage 4d** — DX & Agent Integrations: `bollard init --ide` with Cursor/Claude Code/Codex/Antigravity generators, MCP v2 (enriched descriptions, 6 resources, 3 prompts), `bollard watch`, `--quiet` verify. See [stage4d-validation-results.md](./stage4d-validation-results.md). Design: [stage4d-dx-agent-integrations.md](./stage4d-dx-agent-integrations.md).

**Stage 4d hardening (DONE, 2026-04-22):** Self-test validation (Bollard-on-Bollard) using `bollard_watch_status` MCP tool task. 862 pass / 4 skip. Protocol compliance: 5/5 checklist items passed. Key findings and fixes:

- **MCP profile resolution:** `handleVerify` now calls `resolveConfig(undefined, dir)` for proper `ToolchainProfile` — was falling back to hardcoded pnpm defaults
- **MCP structured output:** `bollard_verify` returns `{ allPassed, summary, checks[], suggestion }` — agents can act on failures without parsing raw JSON
- **MCP workspace root:** `server.ts` uses `findWorkspaceRoot(process.cwd())` for resilient cwd resolution
- **Static check error capture:** `runStaticChecks` error handler captures both stdout and stderr (tsc/biome write errors to stdout)
- **Protocol compliance finding:** "you MUST" language in rules files is advisory to LLMs. Fixed via WHY-first explanation, explicit DO NOT list with specific command examples, and BEFORE REPORTING COMPLETION self-check checklist. See [ADR-0003](./adr/0003-agent-protocol-compliance.md).
- **Bollard-on-Bollard validation pattern:** Formalized as: give the model a real implementation task → observe whether it follows the verification protocol → measure with checklist. Three rounds validated (Stage 2, 4c, 4d). All infrastructure issues found this way were invisible to unit tests.

---

## Stage 5 — Self-Hosting + Self-Improvement

Bollard has all three adversarial scopes, four concern lenses, mutation testing, semantic review, production observability, and IDE integrations. Stage 5 turns Bollard inward: it builds and verifies itself.

### 5a: Self-Hosting

Bollard runs its own `implement-feature` pipeline on Bollard changes. Every PR to Bollard goes through boundary + contract + behavioral adversarial testing, mutation testing, and semantic review — using Bollard itself.

- ~~**Run history (Phase 1):**~~ **DONE (2026-05-01).** `RunRecord`/`VerifyRecord` types, JSONL-based `FileRunHistoryStore` with `proper-lockfile`, `onRunComplete` callback, CLI `history` command (list/show/compare), automatic recording from `run` and `verify` commands. 872 pass / 4 skip.
- ~~**Run history (Phase 2):**~~ **DONE (2026-05-05).** SQLite derived query layer (`better-sqlite3`, dynamic import with JSONL fallback), `RunSummary` type, `bollard history summary`/`rebuild`, `bollard doctor --history`. 895 pass / 4 skip.
- ~~**Run history (Phase 3):**~~ **DONE (2026-05-XX).** MCP `bollard_history` + `bollard_history_summary` tools, `bollard watch` and MCP verify wired to history with `source: "watch" | "mcp"`. 1058 pass / 6 skip.
- ~~**CI-aware verification (Phase 4a):**~~ **DONE (2026-05-XX).** `detectCIEnvironment` (GitHub Actions, GitLab CI, CircleCI, Jenkins, Buildkite, etc.), `readJUnitResults`, `runStaticChecks` with `skipChecks?`, `bollard verify --ci-passed`. Bollard never skips adversarial scopes or mutation testing. 1076 pass / 6 skip.
- ~~**Adversarial test promotion (Phase 4b):**~~ **DONE (2026-05-19).** `TestFingerprint` + SHA-256 hash, `.bollard/promoted.json` manifest, upgraded `bollard promote-test` with import rewriting + already-promoted guard, Signal 1 bug-catcher detection at `approve-pr` gate. Signal 2 (repeated generation across runs) deferred. See [stage5a-self-hosting.md §13](./stage5a-self-hosting.md).
- ~~**Bollard-on-Bollard CI (Phase 5):**~~ **DONE (2026-05-XX).** `.github/workflows/bollard-verify.yml` — triggers on push/PR to `main`. Runs typecheck + lint natively, then `bollard verify --quiet --ci-passed typecheck,lint` in Docker. First green run: GitHub Actions run 26065111582.
- ~~**Protocol compliance CI (Phase 6):**~~ **DONE (2026-05-21).** `bollard audit-protocol` — deterministic 5-point structural lint on `cursor` and `claude-code` generated configs. `.github/workflows/protocol-compliance.yml` triggers on changes to generators/prompts/MCP source. Zero LLM cost.

### 5b: Self-Improvement

- ~~**Prompt regression gating (Phase 1):**~~ **DONE (2026-05-19).** `EvalBaseline` store at `.bollard/eval-baseline.json` records per-agent pass rates. `bollard eval tag/show/diff` CLI commands — `diff` exits 1 when any agent's pass rate drops more than `thresholdPct` percentage points below baseline. All 5 agents at 100% on baseline `stage5b-quality` after hardening brittle assertions (string vs. object grounding, synonym sets for resilience/reject/quote).
- ~~**Eval regression CI (Phase 2):**~~ **DONE (2026-05-19).** `.github/workflows/eval-regression.yml` — weekly Wednesday 04:00 UTC + manual dispatch. First live run green ([#26072692411](https://github.com/bruno-morel/bollard/actions/runs/26072692411), 7m35s, exit 0, all 5 agents at 100%).
- ~~**Meta-verification (Phase 3):**~~ **DONE (2026-05-30).** `computeScopeCalibration` in `@bollard/engine` — per-scope test-failure vs run-failure correlation from `RunRecord` history. `bollard doctor --risk-audit` renders scope calibration table (advisory only).
- ~~**Adaptive concern weights (Phase 3):**~~ **DONE (2026-05-30).** `computeConcernYield` — scope-level claim grounding rate proxy with increase/keep/decrease suggestions in `bollard doctor --history` when ≥ 5 runs with claim data exist. Boundary degrades gracefully when claim counts are not persisted in history.
- **Protocol behavioral audit (future):** LLM-based self-test — run a synthetic task through MCP tools and verify agent followed the verification protocol. Extends the manual Bollard-on-Bollard pattern into an automated, repeatable behavioral check. Structural lint shipped in 5a Phase 6 (`bollard audit-protocol`). Contract-tester and semantic-reviewer grounding now use the same ADR-0003 self-check pattern as IDE verification protocols.

### 5c: Agent Intelligence Upgrades

- **MCP client for agents:** Bollard's planner/coder agents consume external MCP tools (GitHub, Slack, Jira). Agent tool list = built-in tools + available MCP servers, with allowlist/denylist in `.bollard.yml`. **DEFERRED** — too early; external tool surface adds complexity before core pipeline cost is stable.
- ~~**Parallel scope execution:**~~ **DONE (2026-05-27).** Boundary, contract, and behavioral scope extraction and chains run concurrently via `BlueprintNodeGroup` + `executeParallelGroup`; `implement-feature` has **17** top-level steps (**31** leaf nodes). **+11** unit tests. Live pipeline self-test (`CostTracker.reset()`) optional follow-up — see [stage5c-parallel-scopes-validation.md](./stage5c-parallel-scopes-validation.md).
- **Agent memory across runs:** Agents learn from previous runs on the same project — which probes found real bugs, which test patterns were most effective, which concerns had the highest yield. **DEFERRED** — after cost stabilization.

### 5e: Pipeline Cost Hardening (NEW — 2026-06-01)

Observed from Bollard-on-Bollard self-tests: clean runs land $0.88–$1.90 (19–32 coder turns); elevated runs ($3.38–$5.02, 36–54 turns) are driven by two recurring failure modes. This stage addresses them deterministically before adding new agentic capability.

- ~~**Contract grounding corpus expansion (Phase 1a):**~~ **DONE (2026-06-01).** `contractContextToCorpus` gains optional `sourceContents?: string[]`; `verify-claim-grounding` node reads affected source files from disk post-implementation and passes content into corpus. Closes `grounding_not_in_context` gap where tester quotes source body behavior not present in signatures/plan. +4 tests in `contract-grounding.test.ts`. 1381 pass / 6 skip.
- ~~**Contract-tester prompt tightening (Phase 1b):**~~ **DONE (2026-06-03).** Applied ADR-0003 self-check pattern to `contract-tester.md`: bad/good paraphrase example + BEFORE EMITTING numbered checklist. +0 tests (prompt-only). `write_file` overwrite guard also shipped in this pass (+2 tests in `tools.test.ts`). 1416 pass / 6 skip.
- ~~**Semantic reviewer grounding self-check:**~~ **DONE (2026-06-04).** ADR-0003 pattern on `semantic-reviewer.md` (bad/good diff quote + BEFORE EMITTING). Bollard-on-Bollard `humanReadable()` run `20260604-0303-run-7c191e`: $1.55, 26 coder turns, contract 0% drop; semantic 1/4 kept. Cost baseline **`post-5e-hardening`**. See [self-test-humanreadable-results.md](./self-test-humanreadable-results.md).
- ~~**Three-prompt grounding hardening:**~~ **DONE (2026-06-04).** semantic-reviewer diff-anchor rule (+prefix required), coder `write_file` enforcement language, boundary-tester BEFORE EMITTING checklist. Prompt-only; 1435/6. Bollard-on-Bollard `isUnlimited()` run `20260604-0334-run-b89290`: $1.05, 17 coder turns, boundary/contract 0% drop, semantic 2/5 kept (40%). Cost baseline **`post-prompt-hardening`**. See [self-test-isunlimited-results.md](./self-test-isunlimited-results.md).
- ~~**Determinism fixes (preflight + semantic grounding):**~~ **DONE (2026-06-04).** `findNearestTsconfig` + project-aware `runStrykerPreflight`; `findingIdentifiersInCorpus` identifier-presence fallback for diff-sourced semantic review quotes. +5 tests; 1446/6. Bollard-on-Bollard `breakdown()` run `20260604-0406-run-fa5c2b`: $1.38, 23 coder turns, static-checks pass, Stryker 387 mutants (86.56%), semantic 2/4 kept (50%). Cost baseline **`post-determinism-fixes`**. See [self-test-breakdown-results.md](./self-test-breakdown-results.md).
- ~~**Coder turn reduction on multi-step tasks (Phase 2):**~~ **DONE (2026-06-02).** (a) `MAX_TEST_INVOCATIONS` lowered 5→3 in `run-command.ts`; (c) `resolveAllowedCommands` derives fallback allowlist from `ctx.pipelineCtx.toolchainProfile.packageManager` when `ctx.allowedCommands` unset; `isTestCommand` extended to npm/yarn/bun/pytest/cargo/go; `ls` added to `DEFAULT_ALLOWED_COMMANDS`. +3 tests. 1397 pass / 6 skip. (b) verification short-circuit in post-completion hook — **deferred** (existing `createVerificationHook` + patcher sufficient). Prompt quick-fix already shipped: `coder.md` tells coder to use `{{packageManager}}`.
- ~~**Stryker `stryker_no_mutants` pre-flight (Phase 3):**~~ **DONE (2026-06-02; updated 2026-06-04).** `runStrykerPreflight` in `@bollard/verify` — originally `tsc --noEmit` on scoped files; updated to `tsc --noEmit --project <nearest tsconfig>` to avoid cross-package false positives. +5 tests in `mutation-preflight.test.ts`. 1446 pass / 6 skip.
- ~~**Model registry + pricing unification (Phase 4):**~~ **DONE (2026-06-05).** `model-registry.ts` in `@bollard/llm`; providers' `estimateCost` unified; unknown-model stderr warning; coder/`llm.default` → `claude-sonnet-4-6`; `bollard doctor` registry section. Self-test `budgetStatus()` run `20260605-0441-run-3c0ca8`: $1.15, 16 coder turns, 17/17 steps. Cost baseline **`post-model-registry`**. +15 tests; 1504/6. See [09-model-selection.md](./09-model-selection.md) §8 Phase 1.
- ~~**Eval per-agent model resolution (Phase 4b):**~~ **DONE (2026-06-05).** `runAllAgentScores` uses `forAgent(role)` per agent; optional `AgentEvalScore.model`; `eval show`/`eval diff` per-agent model display + warnings; registry-clean stream test fixture; demo handler observability. Eval baseline retagged **`stage5b-sonnet-4-6`** (all 5 agents 100%). +9 tests; 1513/6.
- ~~**Capability-based model resolution (Phase 5):**~~ **DONE (2026-06-15).** `role-requirements.ts` + `resolveModelForRole` wired into `LLMClient.forAgent` (override → capability-resolved → `llm.default`); deleted hardcoded `DEFAULTS.llm.agents`; `config show --sources` shows `capability-resolved`; unknown roles and unregistered providers fall to `llm.default`; `MODEL_NOT_AVAILABLE` when provider known but unsatisfiable. Golden resolution test; self-test `headroom()` GREEN. Lifecycle guardrails (deprecated warning at config time, retired hard error) deferred to Phase 3. See [09-model-selection.md](./09-model-selection.md) §8 Phase 3.
- ~~**Semantic-reviewer model A/B (Phase 6, experiment):**~~ **DONE (2026-06-19).** Haiku vs `claude-sonnet-4-6` on review grounding keep-rate — pre-registered A/B on `usedFraction()`, N=3 Arm A / N=2 Arm B (run 3 skipped). **Verdict: NO — Haiku retained** (54% vs 53% mean keep-rate; +15pp bar unreachable). Filter-bound follow-up logged. Completes model-selection arc (Phases 4 / 4b / 5 / 6). See [09-model-selection.md](./09-model-selection.md) §8 Phase 4.

### 6: Lifecycle Ownership (Takeover Mode)

Bollard progressively owns recurring maintenance work — test curation, CI sync, dependency hygiene, docs, and monitoring — with per-domain trust levels (`review` | `auto-commit` | `silent`). All domains default to disabled; opt in via `.bollard.yml` `takeover:`.

- ~~**Config types + YAML parsing (Phase 0):**~~ **DONE (2026-06-03).** `TakeoverModeConfig` types in `context.ts` (5 domains: tests, ci, deps, docs, monitoring); Zod schema + `applyTakeoverConfig` in `config.ts`; commented `takeover:` block in `examples/bollard.yml`; Stage 6 error codes (`TAKEOVER_CONFLICT`, `OWNERSHIP_MANIFEST_INVALID`, `CURATION_NO_PROGRESS`, `TAKEOVER_TRUST_GATE`). +4 tests in `config.test.ts`. 1420 pass / 6 skip.
- ~~**Phase 1: Takeover Foundation**~~ **DONE (2026-06-04).** `TakeoverModeConfig` (Phase 0), `TestOwnershipManifest` + `FileOwnershipStore`, `detectManagedFileConflicts`, `bollard ownership` CLI, `PipelineContext.ownershipManifest?`. +10 tests; 1471/6.
- ~~**Phase 2: Test Curation**~~ **DONE (2026-06-04).** `assessTestQuality`, `promoteAdversarialTests`, `pruneRedundantTests`, `verifyCurationGrounding`; `TestCuratorAgent` + `curate-tests` blueprint (9 nodes); `bollard curate` CLI; MCP `bollard_curate_tests`. Trust gate (`review`/`silent`); `auto-commit` and full `rewrite` agent deferred. +18 tests; 1489/6. **Next:** Phase 3 — conflict enforcement + rewrite agent.

- **Phase (docs domain): Docs Takeover — two layers, deterministic first.** Captured 2026-06-05 from a real drift incident: the root `README.md` had silently rotted (claimed `1305 passed / 6 skipped` when reality was `1513/6`; `16` MCP tools when the suite asserts `17`; status line stuck at "Stages 0–5b"; doc/ADR tables missing `09-model-selection.md` and ADR-0005). **None of the four Bollard-on-Bollard CI workflows caught it** — and correctly so: Bollard verifies pipeline-produced artifacts (code, tests, generated IDE configs), not hand-written prose, so README freshness was never in scope. That gap is the motivation for this phase. **Design (do not re-derive — this is the learning):**
  - ~~**Layer 1 — deterministic doc-stats audit (`bollard audit-docs`)**~~ **DONE (2026-06-07).** Pure, zero-LLM, ADR-0001 pattern — structural sibling of `bollard audit-protocol`. Hard checks: README MCP tool count vs `packages/mcp/src/tools.ts` text scan, all `spec/NN-*.md` and `spec/adr/NNNN-*.md` linked in README, README/CLAUDE.md test-count consistency, link-integrity over eligible docs. Advisory: link-orphans, doc-placement. Eligible set via `resolveCuratableDocs`; config `docs.homes`. CI step in `.github/workflows/bollard-verify.yml`. [ADR-0006](./adr/0006-docs-curation-scope.md) increments 1–2 **DONE (2026-06-20).**
  - ~~**Layer 2 — LLM `curate-docs` agent (later, behind `takeover.docs`).**~~ **DONE (2026-06-20).** `docs-curator` agent (Sonnet via `llm.default`), fact-token grounding on `newText`, 9-node `curate-docs` blueprint, human gate mandatory in Phase 1 (`silent`/`auto-commit` deferred). CLI `curate-docs list-drift|run`; MCP `bollard_curate_docs`. Design: [stage6-docs-integrity.md](./stage6-docs-integrity.md). ~~**Next (ADR-0006 increment 3):** `curate-docs` consumes resolver + tiers.~~ **DONE (2026-06-20):** curate tier editable via runtime allowlist; detect-only report-only; never-touch excluded.
  - **Sequencing + principle:** Layer 1 is a few hours, deterministic, needs no `takeover` plumbing, and immediately stops numeric drift — ship it standalone well before the agent. **General lesson this incident reinforces:** every time a hand-maintained doc states a number the build can compute, that number is a future stale assertion — add it to `audit-docs` rather than trusting a human to update it (design principle 17, applied to docs).

### 5d: Token Economy — Determinism + Local Models

**All phases DONE as of 2026-05-19.** The pipeline now runs at $0.88–$1.63 per bounded single-method `implement-feature` run (19–32 coder turns, 31/31 nodes), down from $16.17 (159 turns + rollback) at the Stage 5d start. The coder agent runs at 60-turn ceiling (was 80), with runtime forced-completion at turn 52 and per-attempt cost cap at $5. Frontier API spend is reserved for genuinely creative, multi-turn work — all mechanical work is deterministic or local.

The full design is in [stage5d-token-economy.md](./stage5d-token-economy.md). The decision rule that governs which work goes deterministic vs. local vs. frontier is in [ADR-0004](./adr/0004-determinism-local-frontier-tiers.md).

- ~~**Deterministic context expansion (Phase 1):**~~ **DONE (2026-05-11).** `ts.preProcessFile` + `workspace-resolver.ts` walk relative and `@scope/pkg` imports, rank by fan-in, cap at preload budget; `expand-affected-files` node after `approve-plan`; coder pre-load reads `ctx.results` first. Self-test run `20260511-0314-run-fef3d9`.
- ~~**Verification-feedback patcher (Phase 2):**~~ **DONE (2026-05-12).** `runDeterministicAutofix` (Biome `--write --unsafe`) + `runLocalPatcher` (local model → unified diff → `patch --strip=1`) inserted between check failures and frontier coder retry. `createVerificationHook` now accepts `localModelsConfig`. Error codes: `PATCHER_PATCH_INVALID`, `PATCHER_NO_PROGRESS`. 997 tests. **Live pipeline validated 2026-05-19** — Tier 1 Biome autofix observed in run `20260519-0005-run-afec32`; see [stage5d-phase2-validation-results.md](./stage5d-phase2-validation-results.md).
- ~~**Adversarial test scaffolding (Phase 3):**~~ **DONE (2026-05-12).** Boundary tester converted to claims JSON protocol; `verify-boundary-grounding` node; `assembleTestFile()` pure assembler; all three write nodes unified. 954 tests.
- ~~**Deterministic code metrics + load testing (Phase 3b):**~~ **DONE (2026-05-12).** Six parallel sub-extractors (coverage, complexity, SAST, churn, CVE, probe latency) feeding `## Code Metrics` into semantic reviewer; optional k6 load-test stage in `run-behavioral-tests`; `MetricsConfig` in `ToolchainProfile`. 966 tests.
- ~~**Local-model runtime (Phase 4):**~~ **DONE (2026-05-12).** `LocalProvider` in `@bollard/llm` with RAM floor check, ChatML serialization, llama.cpp spawn + streaming; `LOCAL_MODEL_*` error codes; `localModels` config block. 982 tests.
- ~~**Make local runtime fully opt-in (Phase 4b):**~~ **DONE (2026-05-12).** `llamacpp-builder` + `dev-local` target behind `docker compose --profile local`; removed from `dev` and `dev-full`; `isBinaryAvailable()` probe; `resolveConfig` warning when binary absent. 986 tests.
- ~~**Per-agent model assignment (Phase 5):**~~ **DONE (2026-05-13).** Haiku defaults for planner/testers/reviewer, Sonnet for coder; `agentBudgets` field (parse-and-store); all 6 agent roles visible in `config show --sources`; generated `.bollard.yml` template updated. 1003 tests.
- ~~**Coder turn reduction (Phase 7):**~~ **DONE (2026-05-13).** Self-test on 2026-05-13 spent $16.17 (159 coder turns, rollback) vs $0.63 anchor — the coder is the dominant cost driver, not agent routing. Four sub-changes: (7a) `coder.md` scope guard section (implement only what the plan says, no retrofitting chaining); (7b) hard turn-budget exit signals at turn 52 and 58 in prompt; (7c) lower `maxTurns` 80→60 in `coder.ts`; (7d) planner emits `non_goals[]` in JSON plan to explicitly constrain coder scope. See `spec/stage5d-token-economy.md` Phase 7.
- ~~**Context window management (Phase 8):**~~ **DONE (2026-05-15).** Validated run `20260515-0350-run-75c385`: 31/31 nodes, $2.56, 47 turns, zero rollbacks. Peak input tokens 23,016 (−31.7% vs 33,710 baseline). Avg input/turn 16,596 (−17%). Three changes: (8a) `read_file` capped at 200 lines, `run_command` at 100 lines; (8b) executor constants tightened (`MAX_TOOL_RESULT_CHARS` 8K→4K, `COMPACT_KEEP_RECENT` 6→4); (8c) preload budget limits enforced. See `spec/stage5d-token-economy.md` Phase 8.
- ~~**Runtime turn enforcement + per-attempt cost cap (Phase 9):**~~ **DONE (2026-05-15).** Prompt-level exit signals (Phase 7) were advisory — coder ignored them, burning $3.66 on a failed 60-turn attempt. Phase 9 adds runtime enforcement: (9a) executor injects a forced-completion `user` message at `maxTurns - 8` if no `end_turn` seen; (9b) `ExecutorOptions.maxCostUsd` per-attempt ceiling; (9c) coder wired to `max_cost_usd / 2` ($5 at current $10 aggregate); (9d) aggregate cap raised $5→$10. All three mechanisms stayed correctly inactive in the validated run (coder completed naturally). See `spec/stage5d-token-economy.md` Phase 9.
- ~~**Planner prompt plan compression (Phase 10):**~~ **DONE (2026-05-15).** Phase 9 run used 47 turns because planner generated 9 acceptance criteria for a 3-line method. Phase 10 adds Rule 2 cap (3–5 criteria, no state-permutation enumeration) and Rule 9 conciseness note (`steps[].tests` names properties, not permutations). Mechanism validated: planner produced 5 criteria (within cap) with consolidating phrasing. Full 31/31 turn-count measurement pending next real pipeline task. See `spec/stage5d-token-economy.md` Phase 10.
- ~~**Cost regression CI (Phase 6):**~~ **DONE (2026-05-19).** `CostBaseline` store at `.bollard/cost-baseline.json`. `bollard cost-baseline tag/show/diff` CLI. `.github/workflows/cost-regression.yml` — `smoke_only: true` default for manual runs + weekly Monday 04:00 UTC full pipeline. Default task: `divide(factor: number): void`. Baseline retagged `stage5a-validated` ($1.633, 20% threshold, $1.96 ceiling). First green run [#26074579914](https://github.com/bruno-morel/bollard/actions/runs/26074579914).

**Sequencing rationale:** Phases 1 and 3 give the largest absolute token savings without any local-model work, so they ship first and validate the determinization principle. Phase 2 builds on Phase 1 (the patcher needs the same context-expansion machinery). Phase 4 is the local runtime — a one-time integration that unlocks Phases 5 and beyond. Phases 7 and 8 are the co-critical path to the cost target: Phase 7 reduces turn count (the multiplier) while Phase 8 reduces cost per turn (context window size). Phase 6 closes the loop with a CI gate.

**Achieved results (2026-05-19):** `runCount()` validation: $0.88, 19 coder turns, 31/31 nodes. `formatCost()` validation: $1.63, 32 coder turns, 31/31 nodes. Average: $1.255, well under $1.96 ceiling. Coder turns < 40 target: ✓ (19 and 32). Average context < 15K tokens/turn: not yet measured on recent runs. Full cost data in [stage5d-token-economy.md](./stage5d-token-economy.md).

**Bollard-on-Bollard hardening (2026-05-25) — post-clamp() self-test analysis:**

These two fixes shipped after studying the clamp() run logs (`20260525-0038-run-ee973e`) to find deterministic improvements:

- ~~**Coder write-scope guard (Phase 11):**~~ **DONE (2026-05-25, commit `48dc24a`).** `allowedWritePaths?: string[]` added to `AgentContext`. When set, `write_file` and `edit_file` return an error string (not throw) for any path outside the plan's `affected_files.modify + create`. Workspace-root writes (scratch files like `debug.ts`, `test-foo.js`) blocked unconditionally. `agent-handler.ts` populates the field from the plan for the coder role. Enforces the prompt-level scope constraint in infrastructure — the clamp() coder violated it for 25+ turns (42% of a 54-turn run), causing line-number corruption and 14 TS errors. +7 tests in `tools.test.ts`. 1175→1181 passed.
- ~~**Structured test failure output (Phase 12):**~~ **DONE (2026-05-25, commit `64980b1`).** `isTestCommand()` + `formatVitestFailureSummary()` added to `run-command.ts`. When a test command exits non-zero, `run_command` returns a compact summary (~15 lines: failing suite paths, test names, first error snippets, counts) instead of 100 truncated raw lines. ANSI stripped before parsing. The clamp() coder ran `pnpm test` 10 times and created scratch files to work around the truncated output — this gives it actionable structured output on the first run. +4 tests. 1177→1181 passed.

- ~~**`agentBudgets` enforcement (Phase 13):**~~ **DONE (2026-05-25).** `config.llm.agentBudgets?.[agentRole]` is now resolved and applied as `ExecutorOptions.maxCostUsd` for every agent role. Coder: uses `agentBudgets.coder` if set, falls back to `max_cost_usd / 2` (existing behavior preserved). All other agents: applies `agentBudgets[role]` when configured, otherwise no cap (backward-compatible). Previously parsed and stored but silently ignored at runtime — the comment in `context.ts` said "Enforcement is Stage 6." +5 tests in `agent-handler.test.ts`. 1181→1186 passed.

**Structural issues from logged self-test runs (resolved 2026-05-25):**

- ~~**Contract grounding corpus fix (Phase 14):**~~ **DONE (2026-05-25).** `contractContextToCorpus` extended with optional `taskStr` and `acceptanceCriteria[]` parameters. The `verify-claim-grounding` blueprint node now passes `ctx.task` and `plan.acceptance_criteria[]` so the corpus matches what the contract-tester receives. Root cause: claims quoting from `# Task` and `# Acceptance criteria` in the tester message failed `grounding_not_in_context` because those strings were never in the corpus — only TypeScript signatures, edge descriptions, and `plan.summary` were. Predicted impact: drop rate drops from 55–88% to 0–13% on bounded single-method tasks. +5 tests in `contract-grounding.test.ts`. 1186→1209 passed / 6 skipped.
- ~~**Stryker Docker subprocess fix (Phase 15a–15c):**~~ **DONE (2026-05-25).** Three layered fixes for Stryker inside Docker: (15a) replaced `pnpm exec stryker run` with direct binary invocation; (15b) replaced `.bin/stryker` shell wrapper with `node node_modules/@stryker-mutator/core/bin/stryker.js run` — the pnpm wrapper bakes host `NODE_PATH` at install time, breaking `@stryker-mutator/vitest-runner` resolution in `/app/`; (15c) added `plugins: ["@stryker-mutator/vitest-runner"]` to generated `stryker.config.json` because pnpm hoists the plugin to workspace root while Stryker's default loader only scans core's nested `node_modules`. When `totalMutants === 0` after a Stryker run, the blueprint node logs `warn: stryker_no_mutants` and returns `{ skipped: true }`. `strykerSmokeTest(workDir)` checks the JS entry point. +3 tests in `mutation.test.ts`. **Live validation (2026-05-25, Docker smoke):** `runMutationTesting` on `cost-tracker.ts` → **202 mutants**, **90.10%** score, no `stryker_no_mutants`. See [spec/stage5d-phase15b-validation-results.md](./stage5d-phase15b-validation-results.md). Prior limitUsd() run `20260525-2109-run-b8c50b` predates 15b/15c.

**Phase 15 live validation + follow-on items (2026-05-25):**

- ~~**Contract-tester negative-remaining() issue:**~~ **Mitigated (2026-05-25).** JSDoc on `remaining()` and `exceeded()` committed; `limitUsd()` self-test completed 31/31 with contract tests 6/6 pass (no negative-remaining assertions).
- ~~**Phase 15 validation prompt (limitUsd()):**~~ **RUN (2026-05-25).** Run `20260525-2109-run-b8c50b` — 31/31 nodes, Phase 14 held (25% contract drop). Phase 15: `stryker_no_mutants` — superseded by 15b/15c Docker validation.
- ~~**Stryker vitest-runner Docker env:**~~ **DONE (2026-05-25).** Resolved via node+stryker.js + explicit plugins in generated config. See [stage5d-phase15b-validation-results.md](./stage5d-phase15b-validation-results.md).
- ~~**Phase 15 live pipeline (`toJSON()` self-test):**~~ **GREEN (2026-05-25).** Run `20260525-2222-run-39f3e2` — node 22 `run-mutation-testing` → **totalMutants 204**, score **90.20%**. `deriveVitestConfigFile` now prefers `vitest.stryker.config.ts`. Stryker Phase 15 fully closed (Docker smoke + live pipeline). See [self-test-to-json-results.md](./self-test-to-json-results.md).

- ~~**Coder test-surgery-loop guard (Phase 16):**~~ **DONE (commit `0843bc8`).** Layer 1: pre-existing `*.test.ts` / `*.test.js` paths stripped from coder `allowedWritePaths` in `agent-handler.ts` even when the planner lists them in `affected_files.modify`. Layer 2: `testInvocationCount` on `AgentContext`, hard-stop after `MAX_TEST_INVOCATIONS` (5) in `run-command.ts`. +5 tests (`tools.test.ts` Layer 1 predicate, `run-command.adversarial.test.ts` counter). **Live validated (2026-05-27, run `20260527-0056-run-ace38a`):** coder **22** turns / **$1.90**. Phase 16 guard fired Layer 1 (blocked `cost-tracker.test.ts` edits); Layer 2 did not fire. Surgery-loop pattern **eliminated** vs clamp/merge/limitUsd ($3.21–$5.02, 51–54 turns). See [self-test-percent-used-results.md](./self-test-percent-used-results.md). **Third validation (cap(), run `20260527-0134-run-3be761`):** **3** turns / **$0.20** (31/31 verification-only). Forward attempts `5dce47`/`2a12d4` failed at contract/mutation ($3.17–$3.63); Layer 1 fired but turn cost remained high (34–38 turns). Cost baseline retag **skipped** — no forward run under $1.96. See [self-test-cap-results.md](./self-test-cap-results.md).

### Lessons from Stage 4d that shape Stage 5

These findings are architectural — they affect how every future stage is designed:

1. **Advisory ≠ enforced.** Rules files and system prompts that say "you MUST" are suggestions to LLMs, not constraints. Any protocol that must be followed needs three structural elements: WHY the protocol exists (so the model can reason about it), explicit DO NOT section with concrete negative examples, and a self-check checklist the model runs before declaring completion. See [ADR-0003](./adr/0003-agent-protocol-compliance.md).

2. **Self-tests find what unit tests can't.** All three Bollard-on-Bollard rounds (Stage 2, 4c, 4d) surfaced issues invisible to the 862-test suite. The pattern: give a real model a real task through real infrastructure, observe what breaks. This is not a substitute for unit tests — it's a different verification layer that catches integration-level and protocol-level failures.

3. **MCP tools need structured output from day one.** Raw JSON dumps force the consuming agent to parse and interpret. Structured output with `allPassed`, `summary`, `suggestion` fields lets the agent act immediately. Every new MCP tool should return an actionable shape, not a data dump.

4. **Workspace resolution is never simple.** `process.cwd()` is wrong in containers, wrong under `pnpm --filter`, wrong when MCP servers are spawned from different directories. Always use `findWorkspaceRoot()` or equivalent. Any new entry point (CLI command, MCP handler, hook) must thread workspace resolution through.

5. **Error output goes to unexpected places.** TypeScript compiler and Biome write errors to stdout, not stderr. Any error-capture code must collect both streams. This is a general principle: don't assume tools follow Unix conventions.

---

## Stage 3c — shipped (validated GREEN 2026-04-16)

- ~~**Per-language mutation testing**~~ — Stryker (JS/TS), `MutmutProvider` (Python), `CargoMutantsProvider` (Rust). Go mutation testing deferred (no maintained upstream tool). Scope-aware targeting via `mutateFiles` reduces pipeline runs from full-repo to coder-changed files only.
- ~~**Semantic review agent**~~ — `semantic-reviewer` agent sees diff + plan, produces structured `ReviewFinding`s with grounding. Deterministic verifier filters hallucinations. Advisory only (never blocks pipeline). Findings shown at `approve-pr`.
- ~~**Streaming LLM responses**~~ — Anthropic `chatStream` + executor integration + `stream_delta` progress events. OpenAI + Google `chatStream` shipped in **Stage 4c Part 1** (see [stage4c-streaming-parity.md](./stage4c-streaming-parity.md)).
- ~~`**go.work`-only detection**~~ — `parseGoWorkUses` in Go detector; root `go.mod` takes precedence when both exist.

### Moved to Stage 4c

These items were originally tracked under Stage 3c but have been rescheduled through 4a/4b to 4c:

- **Java/Kotlin language expansion (Wave 1)** — originally Stage 3c per [07-adversarial-scopes.md §12.1](07-adversarial-scopes.md). Moved to Stage 4c because the mutation-testing integration pattern needed to stabilize on TS/Python/Rust first.
- ~~**OpenAI / Google streaming parity**~~ — **Done (Stage 4c Part 1, 2026-04-16).** See [stage4c-streaming-parity.md](./stage4c-streaming-parity.md).
- ~~**Verification summary batching**~~ — **Done (Stage 4c cleanup).** Coder post-completion hook runs typecheck, lint, test, audit, secretScan in one pass with batched failure output (up to 3 retries).
- ~~**Git rollback on coder max-turns failure**~~ — **Done (Stage 4c cleanup).** `rollbackSha` + `git reset --hard` in CLI agent-handler when coder throws; only on `bollard/`* branch (`ctx.gitBranch` set).

---

## Stage 4b+: Production Feedback Loop Enhancements

These extend the core probe → measure → correct loop shipped in Stage 4b.

### ~~Bollard-Owned Feature Flags~~ — SHIPPED (Stage 4b)

- `FileFlagProvider` (built-in) + `FlagProvider` interface for external providers (Flagsmith, LaunchDarkly)
- Progressive rollout state machine: OFF → canary (5%) → partial (25%) → full (100%)
- Risk-gated rollout advancement (auto for low/medium, human-gated for high/critical)
- CLI: `bollard flag set/list/kill`

### ~~Drift Detection~~ — SHIPPED (Stage 4b)

- `GitDriftDetector` (built-in) + `DriftDetector` interface for external providers (ArgoCD, Flux)
- Severity classification: test-only = low, source = medium, config/infra = high
- CLI: `bollard drift check/watch`

### External Provider Implementations (4b+)

- Datadog Synthetic for probes, Prometheus pushgateway for metrics
- Flagsmith / LaunchDarkly for flags
- Cloud Run / ArgoCD / Flux for deployment tracking and drift detection
- **When:** When teams need them; interfaces are ready.

### SLO Tracking and Error Budgets (4b+)

- Rolling-window error budget math on probe results
- Risk-tier-derived SLO targets (availability, latency P95/P99)
- Budget consumption notifications (25%, 50%, 75%)
- Auto-task creation when budget exhausted
- **Why deferred:** Requires stable probe data over weeks. Specifying thresholds before running a single probe is premature.

---

## Stage 3+: Documentation as Artifact (Full)

The principle (docs go through the same adversarial pipeline) is in the spec. The full implementation is deferred.

### Doc Verification Agent

- Separate agent sees diff + plan + docs (NOT implementation)
- Impact analysis: which docs are affected by code changes
- Orphan detection: docs referencing removed code
- **When:** Stage 3, after adversarial test agent is proven

### Documentation Inventory

- INVENTORY.yml — machine-readable manifest of all docs
- Living docs (auto-generated), curated docs (human-owned), ephemeral docs (per-run)
- Doc coverage as a verification postcondition

### Documentation Testing

- Extract code blocks from guides, test them in sandbox
- Link checking, config sync, freshness detection
- Monthly verification cycle

---

## Stage 3+: Extended Observability

### Advanced Rollout Automation

- Basic progressive rollout by risk tier is in the spec (see [01-architecture.md](01-architecture.md) Section 11)
- This roadmap item covers: automatic step advancement based on probe health, rollout state machine persistence, optimistic concurrency for concurrent rollouts, rollout-to-rollout interaction handling
- **Why deferred:** Basic percentage-based canary with manual/risk-gated advancement is sufficient for v0.1

### Probe Scheduling

- Cron-based continuous probe execution
- Probe-to-probe dependencies for stateful APIs
- Multi-region probing

### Browser-Based Probes

- Playwright flows simulating real user journeys
- Visual regression detection
- Full synthetic monitoring (beyond API contract verification)

---

## Stage 1.5–3: Language Agnosticism — MOVED TO SPEC

Now a core concern across multiple stages. See [06-toolchain-profiles.md](06-toolchain-profiles.md) for the full design and [02-bootstrap.md](02-bootstrap.md) for the updated stage breakdown:

- **Stage 1.5:** Toolchain detection (`@bollard/detect`), profile-driven verification, templatized agent prompts, interactive `bollard init`. All existing TypeScript behavior preserved, plus Python/Go/Rust/Ruby/Java detection.
- **Stage 2:** Docker-isolated adversarial test containers, black-box testing in Bollard's own runtime (language-independent), in-language test generation for supported frameworks, `SignatureExtractor` interface with TS implementation + LLM fallback.
- **Stage 3:** Per-language mutation testing (Stryker for TS/JS, mutmut for Python, cargo-mutants for Rust), deterministic type extractors for Python/Go/Rust, semantic review agent, Anthropic LLM streaming. *Note: go-mutesting (Go) was deferred — no maintained upstream tool. Go mutation will be revisited when a viable tool emerges.*

The persistent-native adversarial test mode (tests written in the project's language, integrated with the project's test runner) is a Stage 2 deliverable. See [06-toolchain-profiles.md](06-toolchain-profiles.md) Section 13 for the ephemeral vs. persistent-native lifecycle model.

---

## Stage 4c → 5+: Language Coverage Expansion

Stages 3–4b ship with deterministic support for TypeScript, JavaScript, Python, Go, and Rust. Additional major languages are sequenced into three waves. **Full design and rationale in [07-adversarial-scopes.md §12.1](07-adversarial-scopes.md#121-language-expansion-roadmap).**

Each new language is a four-step integration: detector (`packages/detect/src/languages/<lang>.ts`), deterministic `SignatureExtractor` (ideally a compiled helper binary, same pattern as `bollard-extract-go` / `bollard-extract-rs`), Docker verify image (`docker/Dockerfile.verify-<lang>`), and mutation-testing wrapper.

### Wave 1 — Stage 4c: Java + Kotlin (JVM)

- **Why first:** largest enterprise footprint; **PIT** is the flagship mutation tool in any language, so Java becomes Bollard's reference mutation-testing integration. Originally slated for Stage 3c; moved to Stage 4c because the mutation-testing integration pattern needed to stabilize on TS/Python/Rust first.
- Detection: `pom.xml` / `build.gradle`* / `settings.gradle*`
- Toolchain: javac + kotlinc, SpotBugs/Checkstyle/ErrorProne/ktlint/detekt, JUnit 5 / TestNG, Temurin JDK 21
- Extractor: JavaParser-based CLI jar (`bollard-extract-java`) in dev image; Kotlin shares the helper
- Mutation: **PIT** (`pitest`)
- Contract graph: Gradle/Maven `project(...)` references map directly to `ContractContext` module edges

### Wave 2 — Stage 4+: C#/.NET

- **Why second:** `dotnet` CLI is one cohesive entry point, Roslyn gives a first-class AST API, and **Stryker.NET** is healthy. Sequenced after Wave 1 to reuse the Bollard mutation-testing integration contract established there
- Detection: `*.csproj` / `*.sln` / `global.json`
- Toolchain: `dotnet build` / `dotnet format` / `dotnet test`, xUnit/NUnit/MSTest
- Extractor: Roslyn-based .NET global tool (`bollard-extract-dotnet`) — Roslyn's semantic model gives richer type information than any current extractor
- Mutation: **Stryker.NET**
- Contract graph: `.sln` + `ProjectReference` elements give a deterministic module graph

### Wave 3 — Stage 5+: Ruby + PHP

- **Why third:** smaller cohesive audiences, both underserved by AI tooling. PHP is the dark horse — massive install base plus **Infection** (on par with PIT and Stryker.NET)
- **Ruby:** `Gemfile` detection, Sorbet/RBS typecheck (optional — contract scope is weaker without it), RuboCop, RSpec/Minitest, **mutant** (validate licensing), Prism-based helper for projects without Sorbet
- **PHP:** `composer.json` detection, PHPStan/Psalm typecheck, PHPCS/PHP-CS-Fixer, PHPUnit/Pest, **Infection** for mutation testing, nikic/php-parser for extraction

### Explicit non-goals (no near-term timeline)

- **Swift** — Apple-ecosystem-dominant, limited server-side relevance
- **Scala** — JVM, complex toolchain relative to audience size; may piggyback on Wave 1 if a contributor shows up
- **Elixir** — reserved in `LanguageId`; may move earlier if Stage 4c wants a resilience-concern reference implementation (BEAM's supervision model)
- **F#, Clojure, Haskell, OCaml, Nim, Zig** — no near-term plans; the `LanguageId` union grows when demand appears

### Sequencing principle

Waves run in sequence, not parallel, so each wave re-validates the four-integration-point abstraction before we commit to the next, and so the `dev-full` image grows predictably (~200 MB JDK, ~500 MB .NET SDK, ~150 MB Ruby+PHP across the three waves).

---

## Stage 5+: Agent Intelligence

### ~~MCP Client for Agents~~ — MOVED TO Stage 5c

See Stage 5c above.

### Prompt Evaluation Framework (Full)

- ~~Eval sets per agent~~ — **Done (Stage 1).** Planner (4 cases), coder (2), boundary-tester, contract-tester eval sets exist. `bollard eval [agent]` command works.
- Prompt change gating: new prompt must pass ≥ baseline evals — **Stage 5b**
- Prompt regression detection over N runs — **Stage 5b**
- Additional assertion types: test_catches_bug, no_implementation_leak — **Stage 5b**

### ~~Information Isolation Verification~~ — DONE (Stage 3a)

- Contract context re-export closure limits `publicExports` to entry-export paths — private internals no longer leak into adversarial agent prompts
- Regression test added in Stage 3a validation
- Leak scan in `write-tests` / `write-contract-tests` / `write-behavioral-tests` nodes

### ~~Meta-Verification~~ — MOVED TO Stage 5b

See Stage 5b above. Needs hundreds of runs of calibration data.

---

## Stage 4+: Cloud Providers (Beyond GCP)

The BollardProvider interface supports all of these. Implementation priority follows demand.

### Cloud-Native CI

- Azure Pipelines provider
- AWS CodeBuild provider

### Cloud Compute

- AWS provider (ECS Fargate)
- Azure provider (ACI)
- OpenStack provider (Zun/Heat)

### CI Platforms

- GitLab CI provider (self-hosted runner support)
- Bitbucket Pipelines provider

---

## Future (No Timeline)

- A/B experiment statistics (significance testing) on flag cohorts
- Audience-based flag targeting (user attributes beyond percentage)
- ~~SQLite or webhook-push historical data storage~~ — SQLite shipped in Stage 5a Phase 2 (2026-05-05)
- ~~Local model support (ollama, llama.cpp) as LLM provider~~ — promoted to Stage 5d ([stage5d-token-economy.md](./stage5d-token-economy.md))
- Bollard marketplace for community blueprints
- IDE extensions (VS Code, JetBrains) beyond MCP
- Multi-repo / monorepo-aware verification
- Parallel multi-provider deployment

---

*Items move from this roadmap into the spec when there's evidence they're needed — not when they sound good.*