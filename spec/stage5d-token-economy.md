# Stage 5d — Token Economy

**Status:** Design
**Owner:** Bruno (maintainer)
**Related:** [ROADMAP.md](./ROADMAP.md), [01-architecture.md](./01-architecture.md), [06-toolchain-profiles.md](./06-toolchain-profiles.md), [adr/0004-determinism-local-frontier-tiers.md](./adr/0004-determinism-local-frontier-tiers.md)

## Motivation

The pipeline works. It produces verified, mutation-tested, semantically-reviewed code. But every `implement-feature` run currently spends $0.63–$1.40 of frontier-model budget (the two anchor cost points called out in CLAUDE.md), and a substantial fraction of that spend pays for work that does not need frontier quality. Inspection of the explicit run datum in CLAUDE.md, the line-range-mode commit log, and a handful of generated `.bollard/tests/` files tells a consistent qualitative story: the coder agent works at the upper end of its 80-turn ceiling on non-trivial changes, the post-completion verification hook fires 1–3 times per run with batched typecheck/lint/test failures, and the boundary, contract, and behavioral testers each emit full test files where most of the output is import statements, framework boilerplate, and `describe`/`it` scaffolding identical across runs.

This is not a prompt-quality problem. The prompts are well-tuned. It is a **work-routing** problem: too much mechanical work is being done by the most expensive model in the system, because the architecture historically gave us only two choices — frontier API or hardcoded heuristic. Stage 5d adds the missing middle: deterministic context expansion, deterministic templating, and a local small-model tier for the structured rewriting tasks that fall between "write code from a plan" (frontier) and "look up where a symbol is defined" (deterministic).

The motivating data (sparse — Stage 5a Phase 1 run history only started recording on 2026-05-01, so we have weeks of data, not months):

- **Frontier cost per run** (Sonnet, observed): $0.63 (28-node validation, 2026-04-16) → $1.40 (Stage 3b validation, 2026-04-09 — heavier coder use). These are the two anchor points called out in CLAUDE.md; broader distribution will be available from `bollard history summary` once a few dozen more runs are recorded.
- **Coder turns** (single explicit data point in CLAUDE.md): 42 turns / 60-turn ceiling at the time, cost $1.40, duration 222s. The ceiling has since been raised to 80. The line-range mode commit log (Stage 4c hardening, CLAUDE.md line 817) cites "30–70 coder turns per Bollard-on-Bollard run" wasted on the exact-match search death spiral before the fix landed. Today's runs are below that, but per-run telemetry needs a few more weeks of `bollard history` data before quoting percentiles.
- **Verification feedback loop hits** (post-completion hook): the hook is configured for up to 3 retries (`maxVerificationRetries: 3` in `agent-handler.ts`); validation runs typically see 1–2 retries when verification fails, each one a full coder turn at frontier rates. The hook batches all five checks (typecheck, lint, test, audit, secretScan) into a single round-trip, so a single retry is a high-token call.
- **Adversarial tester output**: boundary, contract, and behavioral testers each emit a complete test file. The grounded-claims protocol (ADR-0001, Stage 3a) already strips ungrounded claims, but the surviving claims still arrive wrapped in full-file boilerplate (imports, `describe`/`it` headers, fast-check setup). A back-of-the-envelope estimate over a handful of generated test files in `.bollard/tests/` puts the boilerplate share at well over half the line count, but a precise number wants the same `bollard history summary` data the cost line above is waiting on.

Phase 6 of this stage builds the cost-trend telemetry that lets us replace these anchor points with a real distribution. Until then, the design assumes the anchor-point cost numbers are within a factor of two of the true median — a conservative-enough margin that the Phase 1 + Phase 3 savings still dominate the noise.

## Scope

Stage 5d does **not** touch the adversarial-scope architecture, the contract/behavioral grounding pipeline, the run history layer (Stage 5a), the blueprint runner, or the IDE integrations (Stage 4d). It changes how individual agent calls are constructed, where the work routes, and which model handles which kind of work. The blueprint shape is unchanged; new nodes are deterministic; replaced LLM calls are wired through the existing `LLMClient.forAgent` per-agent provider routing that Stage 4d already exposes via `.bollard.yml`.

Stage 5d is **not** a Stage 5b prompt-evaluation upgrade in disguise. Prompt regression gating is Stage 5b's territory and stays there. Stage 5d's eval coverage is limited to a cost-regression check on the existing implement-feature evals.

## Phase 1 — Deterministic context expansion

**Problem.** The coder agent receives the planner's `affected_files.modify` list pre-loaded (up to 10 files, 10 KB each — `agent-handler.ts`). When the implementation requires touching a type defined in a fourth file the planner did not list, the coder spends a turn calling `read_file` to fetch it, then often another turn calling `search` to find where the type came from. These are deterministic lookups dressed up as creative work.

**Approach.** A new `expand-affected-files` deterministic node, inserted between `generate-plan` and `implement`. It walks the TypeScript Language Service / tree-sitter graph (depending on the `ToolchainProfile.language`) starting from `affected_files.modify`, collects every transitively-imported symbol, and emits a `PreloadedFiles` data structure on `ctx.results`. The agent-handler's `preloadAffectedFiles` reads from this structure instead of just the planner's literal list, capping at the existing 10-file / 10K-char-per-file budget but selecting the highest-import-fanin files first.

**Why deterministic.** Import resolution has a machine-checkable answer. The TS LS, `tree-sitter`, and the language-specific helpers Bollard already ships (`bollard-extract-go`, `bollard-extract-rs`, `bollard-extract-java`) all expose this information.

**Implementation surface.** New file `packages/verify/src/context-expansion.ts`. New blueprint node in `packages/blueprints/src/implement-feature.ts`. No new error codes; expansion failures degrade gracefully to the existing planner-list behaviour.

**Expected savings.** 3–8 coder turns per run (the searches and read_files for transitively-imported types). At p50 coder turn count ≈ 45, this is a 7–18% reduction.

## Phase 2 — Verification-feedback patcher

**Problem.** The coder's post-completion hook (`createVerificationHook` in `agent-handler.ts`) runs typecheck, lint, test, audit, and secretScan, then sends batched failures back to the coder for up to 3 retries. Every retry is a full frontier turn. But the work the coder does in those turns is overwhelmingly mechanical: rename a variable, add a missing `await`, fix a Biome formatting violation, import a missing symbol. None of this needs frontier-quality reasoning.

**Approach.** Two-stage feedback loop:

1. **Deterministic autofix first.** Run `biome check --write --unsafe` (already available), `tsc --noEmit` to surface remaining errors as a structured diagnostic stream, and any language-specific autofixers in the profile. Reapply the failing checks. If the remaining failure count is zero, return to the coder with success — no frontier turn spent.
2. **Local small-model patcher second.** Feed the remaining structured errors plus the relevant file slices to a local 1–3B model (Qwen2.5-Coder-1.5B-Instruct via llama.cpp; see Phase 4) using a tight `error → patch` prompt. The patcher emits unified-diff hunks. Apply, re-run checks. If still failing after 2 patcher rounds, fall through to the existing frontier-coder retry loop with the residual errors only.
3. **Frontier last.** The frontier coder only sees errors the local patcher could not resolve. The existing `maxVerificationRetries: 3` becomes a budget for frontier escalations, not for any failed check.

**Why this lives in Stage 5d, not Stage 4c cleanup.** The autofix step alone is a Stage 4c-cleanup-class change and could ship standalone. The patcher step requires the local-model runtime from Phase 4. Bundling them under Phase 2 keeps the architectural decision visible: the verification feedback loop is structurally a small-model task, autofix is the deterministic prefix.

**Implementation surface.** New file `packages/verify/src/feedback-patcher.ts`. Refactor `createVerificationHook` to delegate to the patcher when local provider is configured. New error codes: `PATCHER_PATCH_INVALID` (patch did not apply cleanly), `PATCHER_NO_PROGRESS` (failure count did not decrease after patch round).

**Expected savings.** 1.0–1.5 coder turns per run on average (the verification retries that are now handled by autofix + local patcher). Frontier turn cost is roughly 5x the local model's compute cost on a 1.5B model running on CPU for typical patch sizes.

## Phase 3 — Adversarial test scaffolding

**Problem.** The boundary, contract, and behavioral testers all emit complete test files: imports, `describe`/`it` blocks, fast-check setup, helper functions, and the actual property bodies. Across runs, the boilerplate is near-identical for a given `(language, framework, scope)` triple. The frontier model is paying the token cost of regenerating known-good imports and known-good `describe` headers every run.

**Approach.** Convert each tester's output protocol from "test file" to "claim with property body + grounding pointers". This already exists for the contract scope (Stage 3a, ADR-0001). Phase 3 generalizes to boundary and behavioral, then adds a deterministic template renderer that assembles imports, framework setup, and `describe`/`it` blocks around each property body.

The renderer is profile-driven — same `ToolchainProfile` Bollard already uses for verification command selection. For TypeScript+Vitest it produces a Vitest-shaped file; for Python+pytest, a pytest-shaped file; for the JVM scopes, a JUnit 5-shaped file. The fast-check (or hypothesis, or jqwik, etc.) setup boilerplate is template territory.

**Why deterministic.** Test-file scaffolding is a syntactic transformation from a known schema (the claim) to a known target shape (the framework). Templates are the right tool. The agent's creative contribution is the property body and the grounding pointer — not the imports.

**Implementation surface.** Three new claim schemas (or one extended schema with a `scope` discriminant). New file `packages/blueprints/src/test-templates/` with one template per `(language, framework, scope)` triple Bollard already supports. Existing `verify-claim-grounding`, `verify-behavioral-grounding`, and the boundary equivalent (to be added) drop ungrounded claims; the renderer assembles surviving ones.

**Expected savings.** Per tester output ≈ 60–70% token reduction (boilerplate stripped). Across three testers, this is ~$0.10–$0.20 per run at current Sonnet rates.

**Risk.** The renderer must support every `(language, framework, scope)` Bollard already ships. Stage 4c's Java/Kotlin work showed how cross-module test placement is non-trivial (`resolveContractTestModulePrefix`); template work has the same risk surface. Mitigation: ship per-language templates incrementally, fall back to "agent emits full file" for unsupported triples.

## Phase 4 — Local-model runtime

**Problem.** Phases 2 and 5 require a local-model tier. The runtime must fit in the dev-image footprint (~989 MB for `dev`, ~2.24 GB for `dev-full`), must not introduce a Python dependency (Bollard is Node-first), and must be controllable from the existing `LLMProvider` interface so per-agent routing in `.bollard.yml` continues to work.

**Approach.** llama.cpp baked into the `dev` image as a static binary (~10 MB). Models lazy-pulled into a Docker volume on first use (`/var/cache/bollard/models`), so the image itself does not balloon. Two model classes:

- **Embeddings:** `fastembed-js` with `bge-small-en-v1.5` (~133 MB). Pure-Node, no extra runtime, used for file-relevance scoring during Phase 1 context expansion (when the import-graph budget is exceeded, embedding similarity ranks remaining candidates) and for similar-bug retrieval in Stage 5b's prompt-regression-gating work later.
- **Small generation:** llama.cpp + `Qwen2.5-Coder-1.5B-Instruct` quantized Q4_K_M (~1.0 GB). Used by the Phase 2 patcher and the Phase 5 diff classifier. Q4 is the right quantization for these sizes — Q3 degrades patch quality measurably; Q5 doubles memory for marginal gain.

**Why llama.cpp, not Ollama.** Ollama is llama.cpp + a service layer + a model registry. Bollard already has a model registry (the `LLMClient`/`.bollard.yml` config), already manages process lifetimes (per-blueprint-run), and does not need a long-running model server. The service layer is overhead. llama.cpp's CLI invocation per request is ~50 ms slower than a warm Ollama server, but Stage 5d uses local models for short, low-frequency calls (a handful per run), not interactive chat.

**Why not Candle.** Candle (Rust) is a strong alternative — already in `dev-full` for `bollard-extract-rs` — but its model coverage is narrower than llama.cpp's, and the coder/patcher market has converged on GGUF as the de-facto small-model interchange format. Reconsider in Stage 6 if Candle's model coverage catches up.

**Implementation surface.** New `LocalProvider` in `packages/llm/src/providers/local.ts` implementing the existing `LLMProvider` interface (incl. `chatStream` for streaming-progress parity). New model resolution code: on first use, check `/var/cache/bollard/models/<model-id>.gguf`, pull from a configured registry URL if absent, lock-file to handle concurrent first-pulls. Update `compose.yaml` to mount the cache volume. Update `Dockerfile` `dev` target to include the llama.cpp binary. Update `LLMClient.resolveProvider` to handle `"local"`. Extend `BollardConfig.llm` schema to allow `provider: "local"` per-agent overrides. Embeddings via `fastembed-js` ship as a separate `LLMProvider`-adjacent helper (different interface — embeddings are not chat).

**New error codes.** `LOCAL_MODEL_NOT_AVAILABLE` (binary missing), `LOCAL_MODEL_PULL_FAILED`, `LOCAL_MODEL_TIMEOUT` (separate from `LLM_TIMEOUT` because retry semantics differ — local timeout is usually a stuck CPU, retryable but not over rate-limit backoff).

**Test surface.** Mock-provider parity — every `LocalProvider` test must run against `MockProvider` first. Live smoke test gated on a `BOLLARD_LOCAL_RUNTIME=1` env flag, skipped in CI by default to keep CI fast.

## Phase 5 — Per-agent model assignment

**Problem.** With Phases 1–4 in place, the work distribution should look very different from today: planner stays on a cheap frontier model (Haiku is already correct here), coder stays on Sonnet/Opus for the creative work, the testers stay on a cheap frontier for the property bodies (boilerplate stripped), the semantic reviewer becomes a tiered call (local diff classifier first, frontier only for flagged findings), and the patcher (Phase 2) is purely local. Today, `.bollard.yml` already supports per-agent provider/model overrides (`llm.agents.<role>`), but defaults are uniform.

**Approach.** Default per-agent assignment shipped in the `bollard init` config generator and documented in `04-configuration.md`:

- `planner` → `anthropic` / `claude-haiku-4-5-20251001` (already cheap; stays)
- `coder` → `anthropic` / `claude-sonnet-4-20250514` (creative; stays frontier)
- `boundary-tester`, `contract-tester`, `behavioral-tester` → `anthropic` / `claude-haiku-4-5-20251001` once Phase 3 has stripped boilerplate (smaller token surface, less reasoning load — Haiku is sufficient for grounded property bodies)
- `semantic-reviewer` → tiered (`local` diff classifier first, `anthropic` / `claude-haiku-4-5-20251001` for findings the classifier flags)
- `patcher` (new agent role for Phase 2) → `local` / `qwen2.5-coder-1.5b-instruct-q4_k_m`

`bollard cost-budget` CLI command for displaying per-agent budget envelope and per-run consumption. `BollardConfig.maxCostUsd` already exists at the engine level — Stage 5d adds per-agent budget caps (`agentBudgets` Record), wired through `LLMClient.forAgent` to enforce hard stops. Exceeding the budget for a non-coder agent does not fail the run; it falls back to the cheaper tier (Haiku → local diff classifier → fail loud).

**Implementation surface.** Schema extension in `BollardConfig.llm`, defaults in `bollard init` (`packages/cli/src/init-ide.ts` and the underlying `.bollard.yml` generator), CLI `cost-budget` command. The `patcher` role is new — `LLMClient.forAgent("patcher")` must resolve.

## Phase 6 — Cost regression CI

**Problem.** Without a feedback loop, prompt changes, blueprint additions, and provider switches will silently drift cost-per-run upward over time. Stage 5b is building prompt regression gating against eval scores; Stage 5d adds the cost dimension to the same machinery.

**Approach.** Aggregate `CostTracker` snapshots from the Stage 5a Phase 2 SQLite layer into per-blueprint per-task cost trends. CI fails when the median cost on the implement-feature evals (the same ones used for Stage 5b prompt regression) regresses by more than a configurable threshold (default 15%) compared to the baseline tag (`bollard cost-baseline tag <tag-name>`).

**Implementation surface.** New CLI: `bollard cost-baseline tag/diff/show`. New file `packages/engine/src/cost-baseline.ts`. CI workflow in `.github/workflows/cost-regression.yml` (when Stage 5a Phase 5 Bollard-on-Bollard CI lands, this hooks into the same job).

**Why now and not later.** The cost regression check is cheap to add and prevents Phase 1–5 gains from quietly evaporating over the next year. The baseline-tag pattern keeps it useful even when intentional cost increases happen (e.g., switching to Opus for a sensitive blueprint).

## Sequencing

Phase 1 ships standalone (no local-model dependency) and validates the determinization principle on coder turn count. Phase 3 also ships standalone and validates the templating principle on tester output. Phases 1 and 3 together should drop p50 cost-per-run by ~30% before any local-model work begins. Phase 4 is the local runtime — a single integration that unlocks Phase 2 (patcher) and Phase 5 (semantic-reviewer tiering, patcher routing). Phase 6 closes the loop.

```
Phase 1 (deterministic context expansion) ──┐
                                             ├── Phase 4 (local runtime) ── Phase 2 (patcher)
Phase 3 (test scaffolding templates) ────────┘                          └── Phase 5 (per-agent assignment)
                                                                                          │
                                                                              Phase 6 (cost regression CI)
```

Validation order matches: each phase has a Bollard-on-Bollard self-test on a real change (the `CostTracker.subtract()` and `bollard_watch_status` patterns from Stage 4c/4d worked well; reuse them) before the next phase starts.

## Success metrics

Validation gate before declaring Stage 5d GREEN:

- **Cost per implement-feature run on the `CostTracker.subtract()` validation task** drops below $0.30, measured as the median of three back-to-back self-test runs. This is anchored against the existing $0.63 self-test datum in CLAUDE.md (Stage 4c Part 1 hardening), so a 50%+ reduction is the threshold; "$0.30" is the target.
- **Coder turn count on the same validation task** drops by at least 30% compared to a pre-Stage-5d baseline run captured immediately before Phase 1 ships. No absolute number — we capture both runs and compare.
- **Verification retries** (post-completion hook → coder) drop to zero on the validation task. The autofix + local patcher should fully absorb verification failures on a `CostTracker.subtract()`-class change.
- **No regression** on adversarial test quality: `verify-claim-grounding` drop rate stays at zero on the validation task (it was already zero in Stage 3a/3b/4a self-tests), mutation score stays at or above its current band, semantic-review finding rate is non-zero (we want the reviewer to still flag things).
- **Phase 6 CI** catches a synthesized cost regression on a test PR — i.e., we deliberately add a tier-3 call where a tier-2 call would do, push it to a branch, and confirm CI fails. This is the Stage 5d analogue of the Bollard-on-Bollard self-test pattern from Stages 2/4c/4d.

Once `bollard history summary` has accumulated 50+ implement-feature runs across the broader user base, the validation threshold tightens to a population-level median rather than a single-task anchor.

## Non-goals

- **Not** replacing the frontier coder. The coder's job — implementing creative changes from a plan, with multi-step reasoning over a partially-known codebase — is exactly the workload frontier models are best at.
- **Not** training custom models. Stage 5d uses off-the-shelf small models (Qwen2.5-Coder, bge-small) with no fine-tuning.
- **Not** a Stage 5b prompt-quality replacement. Phases 3 and 5 reduce token surface, not prompt complexity. Prompt regressions are Stage 5b's job.
- **Not** GPU-aware. llama.cpp on CPU is sufficient for Stage 5d's workloads. GPU offload is a Stage 6 concern if/when patcher latency becomes a bottleneck.

## Open questions

- **Model registry source.** Hugging Face is the obvious default but introduces a single-point-of-failure for first-run UX. Mirror to a Bollard-controlled URL (S3, Cloudflare R2)? Decide before Phase 4 ships.
- **Cache eviction.** `/var/cache/bollard/models` will accumulate over time. LRU with a configurable size cap is the right shape; the cap belongs in `BollardConfig.localModels.cacheSizeGb`.
- **Embedding model swap.** `bge-small-en-v1.5` is English-only. For multilingual codebases (uncommon but exists), a multilingual model would be needed. Defer until a real user needs it.
- **Patcher escalation criteria.** The Phase 2 design says "fall through to frontier coder after 2 patcher rounds." Is 2 the right number, or should it be adaptive (escalate sooner if the patcher's first round did not reduce error count)? Decide during Phase 2 implementation, with telemetry.
