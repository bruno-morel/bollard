# Stage 5d — Token Economy

**Status:** Phases 1, 3, 3b, 4, 4b, 2, 5, 7 DONE. Phase 8 (context window management) co-critical-path with Phase 7. Phase 6 pending (gates on Phase 7 + Phase 8 validated).
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

## Phase 1 — Deterministic context expansion ✅ DONE

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

## Phase 3 — Adversarial test scaffolding ✅ DONE

**Problem.** The boundary, contract, and behavioral testers all emit complete test files: imports, `describe`/`it` blocks, fast-check setup, helper functions, and the actual property bodies. Across runs, the boilerplate is near-identical for a given `(language, framework, scope)` triple. The frontier model is paying the token cost of regenerating known-good imports and known-good `describe` headers every run.

**Approach.** Convert each tester's output protocol from "test file" to "claim with property body + grounding pointers". This already exists for the contract scope (Stage 3a, ADR-0001). Phase 3 generalizes to boundary and behavioral, then adds a deterministic template renderer that assembles imports, framework setup, and `describe`/`it` blocks around each property body.

The renderer is profile-driven — same `ToolchainProfile` Bollard already uses for verification command selection. For TypeScript+Vitest it produces a Vitest-shaped file; for Python+pytest, a pytest-shaped file; for the JVM scopes, a JUnit 5-shaped file. The fast-check (or hypothesis, or jqwik, etc.) setup boilerplate is template territory.

**Why deterministic.** Test-file scaffolding is a syntactic transformation from a known schema (the claim) to a known target shape (the framework). Templates are the right tool. The agent's creative contribution is the property body and the grounding pointer — not the imports.

**Implementation surface.** Three new claim schemas (or one extended schema with a `scope` discriminant). New file `packages/blueprints/src/test-templates/` with one template per `(language, framework, scope)` triple Bollard already supports. Existing `verify-claim-grounding`, `verify-behavioral-grounding`, and the boundary equivalent (to be added) drop ungrounded claims; the renderer assembles surviving ones.

**Expected savings.** Per tester output ≈ 60–70% token reduction (boilerplate stripped). Across three testers, this is ~$0.10–$0.20 per run at current Sonnet rates.

**Risk.** The renderer must support every `(language, framework, scope)` Bollard already ships. Stage 4c's Java/Kotlin work showed how cross-module test placement is non-trivial (`resolveContractTestModulePrefix`); template work has the same risk surface. Mitigation: ship per-language templates incrementally, fall back to "agent emits full file" for unsupported triples.

## Phase 3b — Deterministic code metrics + load testing ✅ DONE

**Problem.** The semantic reviewer currently sees only the diff and the plan. It infers coverage gaps, complexity hotspots, and security patterns from raw code — work that deterministic tools already perform on every run.

**Approach.** A new `extract-code-metrics` deterministic node (position 26 of 31, between `generate-review-diff` and `semantic-review`) runs six parallel sub-extractors with a 90s hard timeout and per-extractor graceful degradation: coverage delta (v8/go-cover/tarpaulin/pytest-cov), complexity hotspots from diff hunk parsing (pure TS, zero deps), SAST via `rg` patterns with Semgrep upgrade path when available, git churn via `git log`, CVE detail via `--json` audit re-run, and probe latency percentiles from `FileMetricsStore` + k6 output. The results are injected as a `## Code Metrics` section into `buildSemanticReviewerMessage`. Optional k6 load-test stage added inside `run-behavioral-tests` (opt-in via `metrics.loadTest.enabled: true`). Two new `ReviewCategory` values: `"insufficient-coverage"` and `"security-pattern"`.

**Status.** DONE (2026-05-12). 966 passed / 4 skipped.

## Phase 4 — Local-model runtime ✅ DONE (opt-in via `dev-local`)

**Problem.** Phases 2 and 5 require a local-model tier. The runtime must fit in the dev-image footprint (~989 MB for `dev`, ~2.24 GB for `dev-full`), must not introduce a Python dependency (Bollard is Node-first), and must be controllable from the existing `LLMProvider` interface so per-agent routing in `.bollard.yml` continues to work.

**Approach.** llama.cpp baked into the `dev` image as a static binary (~10 MB). Models lazy-pulled into a Docker volume on first use (`/var/cache/bollard/models`), so the image itself does not balloon. Two model classes:

- **Embeddings:** `fastembed-js` with `bge-small-en-v1.5` (~133 MB). Pure-Node, no extra runtime, used for file-relevance scoring during Phase 1 context expansion (when the import-graph budget is exceeded, embedding similarity ranks remaining candidates) and for similar-bug retrieval in Stage 5b's prompt-regression-gating work later.
- **Small generation:** llama.cpp + `Qwen2.5-Coder-1.5B-Instruct` quantized Q4_K_M (~1.0 GB). Used by the Phase 2 patcher and the Phase 5 diff classifier. Q4 is the right quantization for these sizes — Q3 degrades patch quality measurably; Q5 doubles memory for marginal gain.

**Why llama.cpp, not Ollama.** Ollama is llama.cpp + a service layer + a model registry. Bollard already has a model registry (the `LLMClient`/`.bollard.yml` config), already manages process lifetimes (per-blueprint-run), and does not need a long-running model server. The service layer is overhead. llama.cpp's CLI invocation per request is ~50 ms slower than a warm Ollama server, but Stage 5d uses local models for short, low-frequency calls (a handful per run), not interactive chat.

**Why not Candle.** Candle (Rust) is a strong alternative — already in `dev-full` for `bollard-extract-rs` — but its model coverage is narrower than llama.cpp's, and the coder/patcher market has converged on GGUF as the de-facto small-model interchange format. Reconsider in Stage 6 if Candle's model coverage catches up.

**Implementation surface.** `LocalProvider` shipped in `packages/llm/src/providers/local.ts` implementing the existing `LLMProvider` interface (incl. `chatStream`). `LLMClient.resolveProvider` handles `"local"`. `BollardConfig` extended with `localModels?: Partial<LocalModelsConfig>`. **The llama.cpp binary is NOT in the `dev` image** — it ships in a separate `dev-local` Docker target (Stage F in Dockerfile) behind `docker compose --profile local`. This keeps `docker compose build dev` fast for contributors who don't use local inference. The `bollard_models` volume is mounted only by `dev-local`. `resolveConfig` emits a yellow warning when `provider: local` is configured but `llama-cli` is not on PATH. Phase 4b (in progress) completes this opt-in restructuring. Embeddings via `fastembed-js` deferred to Phase 5.

**RAM floor and graceful skip.** The Qwen2.5-Coder-1.5B Q4_K_M model requires roughly 1.5–2 GB of resident memory at inference time (weights + KV cache + runtime overhead). On machines with less than 3 GB of available RAM, CPU inference will thrash swap and be slower than the frontier call it is supposed to replace. `LocalProvider` must check available memory before the first inference call (via `/proc/meminfo` on Linux, `vm_stat` on macOS, or Node's `os.freemem()` as a cross-platform fallback) and skip the local call — falling through directly to the frontier tier — if available RAM is below a configurable floor (default `localModels.minFreeRamGb: 3` in `BollardConfig`). Log at `warn` level when skipping; never fail the pipeline.

**CI runner budget.** GitHub Actions standard runners have 7 GB total RAM. The `dev-full` image is 2.24 GB. With the model volume (~1.0 GB), the runner has roughly 3.7 GB headroom. This clears the 3 GB floor but only marginally — CI smoke tests for `LocalProvider` must run with a 2.5 GB model-memory cap (`--ctx-size` in llama.cpp) and `--threads 2` to leave headroom for the OS and Docker daemon. Gate the live smoke test on `BOLLARD_LOCAL_RUNTIME=1` (skipped by default in CI; opt-in on dedicated runners with ≥ 8 GB free).

**CPU inference latency.** llama.cpp on CPU generates roughly 10–30 tokens/second on typical developer hardware (Apple M-series CPU at the high end; x86_64 at the low end). For the patcher's expected output size (a unified-diff hunk, typically 20–80 tokens), that is 1–8 seconds per patch round — tolerable. For the Phase 5 diff classifier (a short classification response, < 20 tokens), it is sub-second. The `LOCAL_MODEL_TIMEOUT` hard deadline is 60 seconds (configurable via `localModels.timeoutSec`); anything slower than that on the patcher workload indicates a resource contention problem and should escalate to frontier rather than block the pipeline. The 50 ms overhead cited above (llama.cpp CLI vs. warm Ollama server) is per-call startup; it is negligible relative to actual inference time for cold invocations.

**New error codes.** `LOCAL_MODEL_NOT_AVAILABLE` (binary missing or RAM floor not met), `LOCAL_MODEL_PULL_FAILED`, `LOCAL_MODEL_TIMEOUT` (separate from `LLM_TIMEOUT` because retry semantics differ — local timeout is usually resource contention, not a rate-limit; fall through to frontier rather than back off).

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

## Phase 7 — Coder turn reduction (NEW — highest priority)

**Problem.** The 2026-05-13 self-test cost $16.17 — 26× the $0.63 anchor — because the coder exhausted all 80 turns on attempt 1 (rollback triggered), then used 79 more turns on attempt 2. Phases 1–5 routing savings ($0.02–$0.05 on Haiku agents) are negligible compared to 159 Sonnet turns. The coder is the dominant cost driver and the problem is structural, not incidental.

**Root causes identified from the 2026-05-13 run:**

1. **Chaining drift.** The task description said "returns `this` for chaining" — the coder interpreted this as "retrofit chaining to `add()` too", cascading into test-file rewrites that consumed most turns. The task prompt was ambiguous.
2. **Test file inflation.** The coder wrote a full new adversarial test file (`cost-tracker.adversarial.test.ts`) using `write_file` instead of editing the existing test file. This is a pattern: the coder treats test writing as "write a new file" rather than "add cases to the existing file", which creates large write operations and subsequent read/verify cycles.
3. **No early exit on turn budget.** The coder prompt says "if you're past turn 60, declare completion with whatever you have" but this is advisory — the model ignores it under pressure. There is no hard signal forcing early completion.
4. **Turn budget itself is too high.** 80 turns creates a psychological (and mechanical) "fill the budget" dynamic. A tighter ceiling with a cleaner exit signal would force earlier declaration and let the verification hook catch remaining issues.

**Approach — four concrete changes, each independently shippable:**

### 7a — Coder prompt: scope guard and explicit non-goals

Add a "# Scope" section at the top of `coder.md` (immediately after `# What You Produce`) that instructs the coder to implement exactly what the plan says and nothing more:

```
# Scope

Implement ONLY what the approved plan specifies. Do NOT:
- Add chaining to methods not mentioned in the plan
- Retrofit new patterns (e.g. fluent interface) to existing methods
- Rewrite existing test files from scratch — add new test cases to existing files
- Add new exports not in the plan's affected_files

If the plan is ambiguous, implement the minimal interpretation. The adversarial testers will probe edge cases independently.
```

### 7b — Coder prompt: hard turn-budget signals

Replace the current "Turns 50+" guidance with three hard signals:

```
# Turn Budget

**Hard limits — the system enforces these:**
- Turn 64 (80% of 80): verification hook stops running. Declare completion before this turn if possible.
- Turn 72 (90% of 80): emit your completion JSON NOW regardless of what's left. The verification hook will catch remaining issues and feed them back.
- Turn 80: hard stop. The pipeline rolls back and retries from scratch — a full retry costs 2× as much.

**The single most expensive thing you can do is hit turn 80.**
A partial implementation declared at turn 72 with tests costs less than a maxed-out run that triggers rollback.
```

### 7c — Coder agent: lower `maxTurns` from 80 to 60

The 80-turn ceiling was set in Stage 4c to give the coder more room after the exact-match search death spiral fix. The line-range `edit_file` mode (also Stage 4c) eliminated that spiral. The ceiling never came back down.

In `packages/agents/src/coder.ts`, change `maxTurns: 80` → `maxTurns: 60`. The executor's `deferPostCompletionVerifyFromTurn` is `floor(maxTurns * 0.8)` = 48, which is a reasonable implementation window. The verification hook feeds failures back; the coder has `maxVerificationRetries: 3` additional turns for fixes.

This single change cuts the worst-case cost by 25% (60 vs 80 turns) and reduces the rollback-trigger probability on bounded tasks.

### 7d — Planner: explicit "no-chaining" constraint in plan output

The planner produces the plan the coder follows. Add a `non_goals` field to the planner's JSON output schema (alongside `summary`, `acceptance_criteria`, `steps`) that explicitly lists things the coder must not do. The planner prompt already produces `acceptance_criteria`; `non_goals` is the inverse. Example output for the divide task:

```json
{
  "non_goals": [
    "Do not add chaining to existing CostTracker methods (add, subtract, reset)",
    "Do not rewrite existing test files — add new test cases only"
  ]
}
```

The coder receives this in the plan and the `# Scope` section references it. The planner is on Haiku — this is a cheap addition.

**Expected savings:** Reducing maxTurns from 80→60 alone cuts worst-case cost from ~~$10/retry to ~$7.50/retry. Combined with scope guard (preventing chaining drift) and early-exit signals, a `CostTracker.divide`-class task should complete in 20–35 turns (~~$1.50–$3.00) rather than 79–80 turns. That's still above the $0.30 target, but the $0.30 target was set when we thought agent routing was the main cost lever. The revised target after this analysis: **below $3.00 per run on a bounded single-method task**, with a path to $1.00 once Phase 2 (local patcher) is wired to the verification hook and task descriptions are tightened.

**Implementation surface.** `packages/agents/prompts/coder.md` (7a, 7b), `packages/agents/src/coder.ts` (7c), `packages/agents/prompts/planner.md` + planner output schema (7d). No new infrastructure; all changes are prompt and config.

## Phase 8 — Context Window Management (co-critical-path with Phase 7)

**Problem.** The 2026-05-13 API logs show that **94% of run cost is input tokens, not output**. The raw Anthropic usage data for the self-test (87 Sonnet requests, ~1.74M input tokens, ~20K output tokens) makes this concrete: output is almost free; input is the cost. Context grows monotonically turn-by-turn — from ~6K tokens in early turns to ~33K tokens in late turns — because `read_file` results, `run_command` output, and failed-check feedback all accumulate in the conversation history without pruning. The jump from ~14K to ~26K input marks the rollback boundary: the second attempt starts with a fresh context but immediately reloads all pre-loaded files, reproducing the bloat.

Even a perfect 25-turn run at ~20K average input/turn = 500K input tokens = **$1.50 in input alone**. To get below $1.00, turns must decrease (Phase 7) AND cost-per-turn must decrease (Phase 8). Neither alone is sufficient.

**Three context inflators (in observed order of severity):**

1. **Accumulated `read_file` results.** Every file read stays in every subsequent turn's context window. A coder that reads 15 files over 30 turns carries all 15 files' contents through turns 16–30, even if most are no longer relevant.
2. **Verbose `run_command` output.** `tsc`, `biome`, and `vitest` output can run to 2–5K tokens per invocation (especially failure output with full file paths, line numbers, and context). These are retained in history across turns.
3. **Monotonic conversation growth.** `compactOlderTurns` exists in `packages/agents/src/executor.ts` but may not be aggressive enough — old tool call pairs from early turns should be pruned once the coder has moved past that step.

**Approach — three concrete changes:**

### 8a — Tool result truncation

Cap `read_file` output at 200 lines with a `... (truncated, N total lines — use search to find specific sections)` marker appended. Cap `run_command` output at 50 lines of errors/warnings, dropping noise lines (e.g. full vitest module resolution traces). The marker tells the coder how to get more detail without re-reading the full file.

**Implementation surface:** `packages/agents/src/tools/read-file.ts` (add `MAX_LINES = 200` cap before returning content), `packages/agents/src/tools/run-command.ts` (add `MAX_OUTPUT_LINES = 50` cap on the result string).

### 8b — Aggressive `compactOlderTurns`

Review and tighten the compaction policy in `packages/agents/src/executor.ts`. Current behavior: compacts older turns but retains tool results. Target behavior: keep only the last 10 turns + the current step's tool calls + the system prompt. Early tool call pairs (call + result from turns 1–(N-10)) should be replaced with a compact summary entry: `[tool_result: read_file "src/foo.ts" — 120 lines, retained in turn 3]`. The coder can re-read a file if needed; it does not need the full content replayed in every subsequent turn.

**Implementation surface:** `packages/agents/src/executor.ts` — update `compactOlderTurns` policy. No new error codes; compaction is transparent to the pipeline.

### 8c — Pre-load budget verification and enforcement

The planner's `affected_files` pre-loading is supposed to be capped at 10 files / 10K chars per file in `packages/cli/src/agent-handler.ts`. Verify these limits are actually enforced (not just documented). If a pre-loaded file exceeds 10K chars, truncate to 10K and append a marker. If the total pre-loaded file count exceeds 10, drop the lowest-priority files (by import fan-in from Phase 1's `expandAffectedFiles`).

**Implementation surface:** `packages/cli/src/agent-handler.ts` — `preloadAffectedFiles` function. Verify and enforce existing documented limits.

**Expected savings.** If average context per turn drops from ~20K to ~10K tokens (truncation + compaction), input cost halves. A 25-turn run goes from $1.50 to $0.75 in input. Combined with Phase 7 (fewer turns — target < 40 on bounded tasks), the arithmetic is: 30 turns × 10K avg input = 300K input tokens ≈ **$0.90 in input**, leaving room for output + non-coder agents within the $1.00 target.

**Why this unblocks the $1.00 target.** Phase 7 reduces turn count; Phase 8 reduces cost per turn. Both are required. Phase 7 alone at 30 turns × 20K avg input = $1.80 in input — still above $1.00. Phase 8 alone at 87 turns × 10K avg input = $0.52 in input, but the $0.52 is multiplied by the rollback frequency. Only together do they make the $1.00 target structurally achievable.

**Implementation surface summary.** `packages/agents/src/executor.ts` (compactOlderTurns aggressiveness — 8b), `packages/agents/src/tools/read-file.ts` (200-line cap — 8a), `packages/agents/src/tools/run-command.ts` (50-line output cap — 8a), `packages/cli/src/agent-handler.ts` (preload budget verification — 8c).

## Phase 6 — Cost regression CI

**Problem.** Without a feedback loop, prompt changes, blueprint additions, and provider switches will silently drift cost-per-run upward over time. Stage 5b is building prompt regression gating against eval scores; Stage 5d adds the cost dimension to the same machinery.

**Approach.** Aggregate `CostTracker` snapshots from the Stage 5a Phase 2 SQLite layer into per-blueprint per-task cost trends. CI fails when the median cost on the implement-feature evals (the same ones used for Stage 5b prompt regression) regresses by more than a configurable threshold (default 15%) compared to the baseline tag (`bollard cost-baseline tag <tag-name>`).

**Implementation surface.** New CLI: `bollard cost-baseline tag/diff/show`. New file `packages/engine/src/cost-baseline.ts`. CI workflow in `.github/workflows/cost-regression.yml` (when Stage 5a Phase 5 Bollard-on-Bollard CI lands, this hooks into the same job).

**Why now and not later.** The cost regression check is cheap to add and prevents Phase 1–5 gains from quietly evaporating over the next year. The baseline-tag pattern keeps it useful even when intentional cost increases happen (e.g., switching to Opus for a sensitive blueprint).

## Sequencing

Phase 1 ships standalone (no local-model dependency) and validates the determinization principle on coder turn count. Phase 3 also ships standalone and validates the templating principle on tester output. Phases 1 and 3 together should drop p50 cost-per-run by ~30% before any local-model work begins. Phase 4 is the local runtime — a single integration that unlocks Phase 2 (patcher) and Phase 5 (semantic-reviewer tiering, patcher routing). Phase 6 closes the loop.

```
Phase 1 ✅ (context expansion)
Phase 3 ✅ (test scaffolding)
Phase 3b ✅ (code metrics+k6)
Phase 4 ✅ (local runtime) ── Phase 4b ✅ (opt-in) ── Phase 2 ✅ (patcher)
Phase 5 ✅ (per-agent routing)
Phase 7 ✅ (coder turn reduction + cost-cap)  ──┐
Phase 8    (context window management)          ──┼── Phase 6 (cost regression CI)
```

Phases 1, 3, 3b, 5 are routing/context/templating work — they reduce cost by improving what gets sent to models. Phases 7 and 8 are the co-critical path: Phase 7 attacks turn count (the multiplier) and Phase 8 attacks context size (cost per turn). The 2026-05-13 API logs show both are required — 94% of cost is input tokens, so reducing turns without reducing per-turn context still leaves the total above $1.00. Phase 6 closes the loop with CI gating and should gate on both Phase 7 and Phase 8 being validated. Phase 2's local patcher provides additional savings once Phase 7+8 have brought per-run cost into a range where individual verification failures (not rollbacks) are the margin.

Self-test cadence: each phase has a Bollard-on-Bollard run before the next phase starts. Self-tests should use a deliberately narrow task description (no ambiguous "returns this for chaining" language) to avoid scope drift. Always check that coder turns < maxTurns before declaring the self-test valid.

## Success metrics

**Revised after 2026-05-13 self-test ($16.17, 159 coder turns, rollback).** The original $0.30 target was set before measuring a real run. The actual cost floor is driven by coder turns, not agent routing. Updated targets:

- **Coder turns per run** (primary metric): below 40 turns on a bounded single-method task (e.g. `CostTracker.divide`). The 2026-05-13 run used 80+79=159. Phase 7 changes (maxTurns 80→60, scope guard, hard exit signals) should bring this to 20–35 on the same task class.
- **Context tokens per turn** (new metric — Phase 8): target < 15K average input tokens per turn (current: ~20K average, peaks at 33K in the 2026-05-13 API logs). Measured from raw Anthropic API usage logs via `bollard history`. Phase 8's tool result truncation and aggressive `compactOlderTurns` are the primary levers.
- **Cost per run** (derived): below $3.00 on a bounded single-method task after Phase 7. Below $1.00 once Phase 8 context management is also active. The $0.30 original target was unrealistic — the coder alone at 20 turns × 20K avg input ≈ $1.20 in input alone; Phase 8 must reduce that to ~10K avg to make $1.00 feasible.
- **Rollback rate**: 0 on bounded tasks. A rollback (coder hitting maxTurns) doubles cost. Phase 7's lower ceiling and scope guard should eliminate rollbacks on single-method tasks.
- **Verification retries** (post-completion hook → coder): 0 on the validation task once Phase 2 local patcher is active.
- **No regression** on adversarial test quality: `verify-claim-grounding` drop rate stays at zero (it was 0/15 boundary and 0/10 contract in the 2026-05-13 run — grounding held), mutation score stays at or above current band.
- **Phase 6 CI** catches a synthesized cost regression (deliberately add a frontier call where a local call would do, confirm CI fails). Phase 6 gates on both Phase 7 (turn count) and Phase 8 (per-turn context) being validated before the baseline is locked.

Once `bollard history summary` has accumulated 20+ implement-feature runs, the validation threshold tightens to a median over the distribution rather than a single-task anchor.

## Non-goals

- **Not** replacing the frontier coder. The coder's job — implementing creative changes from a plan, with multi-step reasoning over a partially-known codebase — is exactly the workload frontier models are best at.
- **Not** training custom models. Stage 5d uses off-the-shelf small models (Qwen2.5-Coder, bge-small) with no fine-tuning.
- **Not** a Stage 5b prompt-quality replacement. Phases 3 and 5 reduce token surface, not prompt complexity. Prompt regressions are Stage 5b's job.
- **Not** GPU-aware. llama.cpp on CPU is sufficient for Stage 5d's workloads. GPU offload is a Stage 6 concern if/when patcher latency becomes a bottleneck.

## Open questions

- **Model registry source.** Hugging Face is the obvious default but introduces a single-point-of-failure for first-run UX. Mirror to a Bollard-controlled URL (S3, Cloudflare R2)? Decide before Phase 4 ships.
- **RAM floor tuning.** The default `localModels.minFreeRamGb: 3` is conservative for 1.5B Q4_K_M. If smaller quantizations (Q2_K at ~0.6 GB) prove acceptable quality for the patcher workload, the floor could drop to 2 GB. Requires a quality-vs-latency eval on real patcher inputs before changing the default.
- **Cache eviction.** `/var/cache/bollard/models` will accumulate over time. LRU with a configurable size cap is the right shape; the cap belongs in `BollardConfig.localModels.cacheSizeGb`.
- **Embedding model swap.** `bge-small-en-v1.5` is English-only. For multilingual codebases (uncommon but exists), a multilingual model would be needed. Defer until a real user needs it.
- **Patcher escalation criteria.** The Phase 2 design says "fall through to frontier coder after 2 patcher rounds." Is 2 the right number, or should it be adaptive (escalate sooner if the patcher's first round did not reduce error count)? Decide during Phase 2 implementation, with telemetry.

