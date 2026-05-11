# CLAUDE.md — Bollard

> This file guides AI coding agents (Claude Code, Cursor, Copilot) working on the Bollard codebase. Read it before writing any code.

## What Bollard Is

Bollard is an **artifact integrity framework** for AI-assisted software development. It ensures every artifact (code, tests, docs, infra) is produced, adversarially verified, and mechanically proven sound before shipping. The core innovation: separate the producer from the verifier, then prove the verification itself is meaningful (via mutation testing).

Bollard has completed **Stage 2** (adversarial verification infrastructure), **Stage 3a** (contract-scope adversarial testing — **validated GREEN on 2026-04-08**), **Stage 3b** (multi-language contract graph + dev ergonomics — **validated GREEN on 2026-04-09** — see [spec/stage3b-validation-results.md](../spec/stage3b-validation-results.md)), the **Stage 3c remainder** (polyglot mutation providers, semantic review + grounding, Anthropic response streaming, `go.work`-only Go detection — see the Remainder section in [spec/stage3c-validation-results.md](../spec/stage3c-validation-results.md)), **Stage 4a** (behavioral-scope adversarial testing — **validated GREEN on 2026-04-16** — see [spec/stage4a-validation-results.md](../spec/stage4a-validation-results.md)), and **Stage 4b** (production feedback loop — **validated GREEN on 2026-04-16** — see [spec/stage4b-validation-results.md](../spec/stage4b-validation-results.md)). The kernel (Stage 0) executes blueprints — sequences of deterministic and agentic nodes. Stage 1 added multi-turn agents (planner, coder, boundary tester), filesystem tools, static verification, the `implement-feature` blueprint, eval sets, and adversarial test generation. Stage 1.5 added language-agnostic toolchain detection (`@bollard/detect`, `ToolchainProfile`), templatized agent prompts, and profile-driven verification. Stage 2 (first half) fixed critical agent infrastructure issues: `edit_file` tool for surgical edits, deeper type extraction with reference resolution, correct test placement, markdown fence stripping, and coder turn budget management. Stage 2 (second half) added Docker-isolated verification containers, LLM fallback signature extraction for edge languages, in-language adversarial test generation, adversarial test lifecycle (ephemeral + persistent-native), MCP server (`@bollard/mcp`), and OpenAI + Google LLM providers. **Stage 3a** adds per-scope `AdversarialConfig` with concern weights, `boundary-tester` + `contract-tester` agents, deterministic extractors for Python/Go/Rust, TypeScript contract graph (`buildContractContext`), four contract blueprint nodes, and `bollard contract` / MCP `bollard_contract`. **Stage 3b** adds polyglot dev image with pre-built Go/Rust extractor helpers, `dev-full` image with full Go/Rust/Python toolchains, `ContractGraphProvider` interface with Python/Go/Rust providers, polyglot risk gate (`scanDiffForExportChanges`), polyglot test summary parsers, and ADR-0002 for the syn-based Rust extractor helper. **Stage 4a** adds behavioral-scope adversarial testing: `buildBehavioralContext` (endpoints, config, deps, failure modes), `behavioral-tester` agent, behavioral grounding, coarse fault injection (`service_stop`), behavioral compose generator, 5 behavioral pipeline nodes. **Stage 4b** adds the production feedback loop: `@bollard/observe` package (probe extraction, HTTP probe runner, metrics store, deployment tracker, drift detector, flag manager, progressive rollout, probe scheduler), `extract-probes` blueprint node, CLI `probe`/`deploy`/`flag`/`drift` commands, 4 MCP tools, provider-based architecture with fully standalone built-in implementations. **Stage 4c** completes Java/Kotlin Wave 1 (detector, `bollard-extract-java`, contract graph, PIT, JVM compose). **Stage 4d** adds DX and agent integrations: `bollard init --ide` (Cursor, Claude Code, Codex, Antigravity), MCP v2 (enriched tool descriptions, 6 resources, 3 prompts), `bollard watch`, and `verify --quiet`. **Stage 5a Phase 1** adds run history: `RunRecord`/`VerifyRecord` types, JSONL-based `FileRunHistoryStore` with `proper-lockfile`, `onRunComplete` callback on `runBlueprint`, CLI `history` command (list/show/compare), automatic recording from `run` and `verify` commands. **Stage 5a Phase 2** adds the SQLite derived query layer: `better-sqlite3` dynamic import with JSONL fallback, `RunSummary` type, `history summary`/`history rebuild` CLI commands, `bollard doctor --history` integration, `SqliteIndex` closure factory in `run-history-db.ts`. **Stage 5d Phase 1** adds deterministic TypeScript import-graph context expansion: `expandAffectedFiles` and `workspace-resolver` in `@bollard/verify`, `expand-affected-files` blueprint node after `approve-plan`, and `preloadAffectedFiles(ctx, workDir)` reading `ctx.results["expand-affected-files"]` before falling back to the planner list. Bollard-on-Bollard self-test **2026-05-11** (run id `20260511-0314-run-fef3d9`, CostTracker.divide validation task) completed **29/29** nodes successfully. A **pre-implementation** `history compare` baseline was **not** captured in local run history before coding began, so the strict coder-turn and total-cost regression gate from the Phase 1 prompt could not be executed here — capture a baseline on `main` and compare after merge when measuring savings.

The forward roadmap (see [07-adversarial-scopes.md](../spec/07-adversarial-scopes.md) and [spec/ROADMAP.md](../spec/ROADMAP.md)):
- **Stage 4c:** Java/Kotlin Wave 1 shipped (Part 2 — detector, `bollard-extract-java`, contract graph, PIT, JVM compose, prompts). (OpenAI + Google `chatStream` parity was Part 1.)
- **Stage 4d:** DX & Agent Integrations: `bollard init --ide` generates platform-specific config for Cursor (rules, hooks, commands), Claude Code (commands, agents, hooks, CLAUDE.md augmentation), Codex, and Antigravity. MCP server v2 adds enriched tool descriptions, 6 resource endpoints (`bollard://profile`, etc.), and 3 prompt templates. `bollard watch` provides continuous verification with file watching. `--quiet` flag on `verify` enables machine-readable JSON output for hooks.
- **Stage 5:** Self-hosting (5a: run history [Phase 1+2 DONE], CI-aware verification, adversarial test promotion, Bollard-on-Bollard CI, protocol compliance CI), self-improvement (5b: prompt regression gating, meta-verification, adaptive concern weights), agent intelligence (5c: MCP client for agents, parallel scope execution, agent memory), token economy (5d: deterministic context expansion, verification-feedback patcher, adversarial test scaffolding, local-model runtime via llama.cpp, per-agent model assignment, cost regression CI). See [spec/ROADMAP.md](../spec/ROADMAP.md) and [spec/stage5d-token-economy.md](../spec/stage5d-token-economy.md).

Stage 2's single adversarial tester (now called the **boundary-scope** tester) is the first of three adversarial scopes. Each scope has its own agent, context, and execution mode, probing four cross-cutting concerns (correctness, security, performance, resilience) with per-scope weights.

### What works right now

```bash
# Run static verification (tsc, biome, audit)
docker compose run --rm dev --filter @bollard/cli run start -- verify

# Generate a plan for a task (requires ANTHROPIC_API_KEY)
docker compose run --rm dev --filter @bollard/cli run start -- plan --task "Add retry logic to HTTP client"

# Run the full implement-feature pipeline (plan → approve → code → verify → test → approve)
docker compose run --rm dev --filter @bollard/cli run start -- run implement-feature --task "Add health check endpoint"

# Run agent eval sets
docker compose run --rm dev --filter @bollard/cli run start -- eval planner

# Print contract graph JSON (optional planner JSON for affected file paths)
docker compose run --rm dev --filter @bollard/cli run start -- contract [--plan plan.json]

# Generate platform-specific IDE integration config
docker compose run --rm dev --filter @bollard/cli run start -- init --ide cursor
docker compose run --rm dev --filter @bollard/cli run start -- init --ide claude-code
docker compose run --rm dev --filter @bollard/cli run start -- init --ide all

# Continuous verification (file watcher)
docker compose run --rm dev --filter @bollard/cli run start -- watch

# Machine-readable verification (for hooks)
docker compose run --rm dev --filter @bollard/cli run start -- verify --quiet

# Run history (list / show / compare / summary / rebuild)
docker compose run --rm dev --filter @bollard/cli run start -- history
docker compose run --rm dev --filter @bollard/cli run start -- history show <run-id>
docker compose run --rm dev --filter @bollard/cli run start -- history compare <id-a> <id-b>
docker compose run --rm dev --filter @bollard/cli run start -- history summary
docker compose run --rm dev --filter @bollard/cli run start -- history rebuild

# Doctor with run history health
docker compose run --rm dev --filter @bollard/cli run start -- doctor --history
```

### Known limitations (Stage 4c JVM Wave 1)

- Docker-isolated verification requires Docker-in-Docker (`docker.sock` mount) — degrades gracefully when unavailable.
- Contract graph (`buildContractContext`) supports **TypeScript, Python, Go, Rust, Java, and Kotlin** Maven/Gradle layouts; other languages return an empty graph with a warning.
- Test output parsing supports Vitest, pytest, `go test`, `cargo test`, Maven Surefire, and Gradle test summary lines. Non-standard runners fall back to zero/error detection.
- Unknown languages still need an LLM provider for signature extraction (`getExtractor` throws `PROVIDER_NOT_FOUND` without one).
- **LLM streaming:** Anthropic, OpenAI, and Google all implement `chatStream`; the executor uses the streaming path whenever `provider.chatStream` is present.
- **Kotlin source extraction** in the helper is regex-based (no compiler); bytecode path for compiled `.class` is best-effort.
- **Mutation testing:** TS/JS (Stryker), Python (mutmut), Rust (cargo-mutants), Java/Kotlin (PIT). Go mutation testing deferred — no maintained upstream tool (`go-mutesting` is unmaintained). `MutationToolId` reserves `"go-mutesting"` for future use.
- **Coder rollback:** After `create-branch`, `ctx.rollbackSha` stores the branch HEAD. If the **coder** agent throws (e.g. max turns), the CLI runs `git checkout -- .`, `git clean -fd`, `git reset --hard` to that SHA when `ctx.gitBranch` is set. Rollback errors are logged; the original error still stops the pipeline.
- **Coder search + `regex: true`:** The `search` tool auto-falls back to literal string matching when a regex pattern fails to parse (exit code 2). The coder prompt discourages `regex: true` for code pattern searches. Control characters (newlines, tabs) are stripped from patterns before passing to ripgrep. Any ripgrep error returns a message to the LLM instead of throwing — search never wastes a coder turn on a tool exception.
- **`edit_file` line-range mode:** `edit_file` accepts `start_line` + `end_line` (1-based, inclusive) as an alternative to `old_string`. Coder prompt teaches "search → get line numbers → edit by range" as the preferred workflow. This eliminates the exact-match death spiral (coder burned 30-70 turns per run trying to construct `old_string` from memory).
- **Risk gate numeric scores:** The planner outputs numeric risk scores (`blast_radius: 0-4`, etc.). `deriveRiskLevel()` maps these to categorical levels (`"low"` / `"medium"` / `"high"`). Previously the risk gate only accepted a string `level` field which the planner never produced, causing all runs to default to `"unknown"` and never skip contract testing.
- **Static-checks / run-tests:** Both use `onFailure: "skip"` — the coder verification hook already ran the same checks (typecheck, lint, test, audit, secretScan) with batched feedback up to 3 retries, so redundant failures there do not halt the rest of the pipeline (contract, behavioral, mutation, review).
- **Observe providers:** `@bollard/observe` ships built-in providers only (HTTP fetch, JSON files, git). External providers (Datadog, Flagsmith, Cloud Run, ArgoCD) are 4b+ — interfaces exist, implementations come when needed.
- **Advanced fault injection:** Only `service_stop` implemented; network_delay/resource_limit are future work.
- **`runBlueprint` signature:** takes an optional trailing `toolchainProfile` — omitting it silently disables contract nodes. Any new entry point that constructs a blueprint run must thread the profile through (see CLI `implement-feature` for the pattern).
- **Vitest discovery of `.bollard/`:** `runTests` branches on paths containing `.bollard/` and uses `vitest.contract.config.ts`. Any new "write test to `.bollard/` then run it" flow must go through `runTests(profile, testFiles)` rather than invoking `pnpm run test` directly.
- **JVM cross-module contract tests:** `resolveContractTestModulePrefix` places contract tests in the consumer module (from `affectedEdges[0].from`). If the contract-tester agent generates assertions that assume the consumer has been extended (e.g., new dispatch cases), those tests may fail at runtime — this is an LLM test-design issue, not infrastructure.
- **JVM audit detection:** OWASP dependency-check commands are only emitted when the plugin is declared in `pom.xml` / `build.gradle(.kts)`. Projects without the plugin get no `audit` check (previously caused hard failures).
- **`bollard watch`** uses `fs.watch` with `recursive: true` — supported on macOS and Windows but not on Linux. Falls back to non-recursive top-level watch on Linux.
- **Claude Code plugin packaging** under `plugin/claude-code/` is a scaffold only — npm publishing and `claude plugin add` registration are future work.
- **CI-aware verification:** Not yet implemented. Bollard re-runs all static checks even when a prior CI step already passed them. `detectCIEnvironment`, `--ci-passed`, and `last-verified.json` SHA-match skip logic are Stage 5a Phase 4. Bollard uses its own `last-verified.json` (not tool-specific cache timestamps) for local dev skip detection — simpler, under Bollard's control, toolchain-agnostic. Integration model: Bollard as smart observer + optional pre-commit hook, never script injection. See [spec/stage5a-self-hosting.md §12](spec/stage5a-self-hosting.md).
- **Adversarial test promotion:** Manual only via `bollard promote-test`. Automatic candidate detection (bug-catcher signal, repeated-generation fingerprinting) is Stage 5a Phase 4. See [spec/stage5a-self-hosting.md §13](spec/stage5a-self-hosting.md).

## Tech Stack (Non-Negotiable)

- **Dev environment:** Docker Compose — all tooling runs inside containers, nothing installed locally except Docker.
- **Runtime:** Node.js 22+ (no experimental flags)
- **Language:** TypeScript 5.x, strict mode ON (`strict: true` in tsconfig). Every `noUnchecked*` flag enabled. `exactOptionalPropertyTypes: true`.
- **Package manager:** pnpm with workspaces. No npm, no yarn.
- **Test runner:** Vitest. No Jest.
- **Linter/formatter:** Biome. No ESLint, no Prettier.
- **Property-based testing:** fast-check (used by adversarial test agent later, but available now).
- **Runtime validation:** Zod at all boundaries.
- **Dev runner:** tsx (esbuild-based, runs TS directly — no build step during development).
- **Mutation testing:** Per-language — Stryker (TS/JS), mutmut (Python), cargo-mutants (Rust); opt-in via `.bollard.yml`.
- **Secret scanning:** gitleaks (checked by `@bollard/verify` when installed).

### Explicitly NOT used

- No local Node.js/pnpm install required (Docker handles it)
- No Turborepo (pnpm workspaces + `--filter` is sufficient)
- No ESLint + Prettier (Biome replaces both)
- No Jest (Vitest is faster and TS-native)
- No agent frameworks (LangChain, CrewAI, etc.) — Bollard IS the framework
- No remote caching or build services

## Development via Docker Compose (Mandatory)

**Every command — tests, lint, typecheck, format, running the CLI, installing deps — MUST go through `docker compose`. Never run bare `pnpm`, `node`, `npx`, `tsc`, `vitest`, or `biome` on the host machine.**

```bash
# Build the dev image (first time or after dependency changes)
docker compose build dev

# Run commands (entrypoint is pnpm, so args go after "dev")
docker compose run --rm dev run test          # run tests
docker compose run --rm dev run typecheck     # type-check
docker compose run --rm dev run lint          # lint + format check
docker compose run --rm dev run format        # auto-format

# Run a specific package command
docker compose run --rm dev --filter @bollard/cli run start -- run demo --task "Say hello"

# Install new dependencies
docker compose run --rm dev add -Dw <package>
docker compose run --rm dev add --filter @bollard/llm <package>
# After adding deps, rebuild the image to bake them in:
docker compose build dev

# If you add NEW packages to pnpm-workspace, update the lockfile first:
docker run --rm -e CI=true -v "$(pwd):/app" -w /app node:22-slim \
  sh -c "corepack enable && corepack prepare pnpm@latest --activate && pnpm install --no-frozen-lockfile"
# Then rebuild: docker compose build dev
# Then recreate volumes: docker compose down -v

# Interactive shell inside container
docker compose run --rm --entrypoint sh dev
```

The `compose.yaml` mounts the workspace as a volume so edits are reflected immediately. Node modules live in named volumes to avoid polluting the host. **When adding new workspace packages, you must `docker compose down -v` to recreate stale volumes.**

Pass `ANTHROPIC_API_KEY` via a `.env` file at the project root.

### Two images: `dev` and `dev-full`

Bollard ships two Docker targets:

- **`dev`** (default, fast): Node 22 + pnpm + python3 + pre-built Go/Rust/**Java** extractor helpers (`bollard-extract-go`, `bollard-extract-rs`, `bollard-extract-java` GraalVM native). Use this for day-to-day TS development, unit tests, and any pipeline run that doesn't touch Go/Rust/Java project code. Built by `docker compose build dev`.
- **`dev-full`** (~2.24 GB; opt-in via compose profile `full`): extends `dev` with full Go 1.22 and Rust stable toolchains plus `pytest`/`ruff`, **JDK 21 + Maven** for JVM pipeline validation. Required for Stage 3b validation runs and any pipeline that runs `go test` / `cargo test` / `pytest` against project code. Built by `docker compose --profile full build dev-full`. Run with `docker compose --profile full run --rm dev-full …`. The single consolidated RUN layer installs everything and cleans up build-only packages (curl, python3-pip) and unused GCC sanitizer runtimes in one pass to minimize image size. **Size floor is roughly 2.2 GB** (Rust toolchain + LLVM ~480 MB, Go ~224 MB, gcc/binutils/libc-dev ~120 MB, on top of the 989 MB `dev` base). Further trimming would require giving up a capability — don't chase it.

CI runs the fast suite on `dev` and the Stage 3b validation suite on `dev-full`. Day-to-day contributors never need to build `dev-full` unless they're working on polyglot pipeline runs.

## Project Structure (Stage 3b)

```
bollard/
├── Dockerfile                    # Multi-stage: go/rust/java helper builders, dev, dev-full
├── compose.yaml                  # Docker Compose for all dev commands (dev + dev-full behind `full` profile)
├── scripts/
│   ├── extract_go/               # Go AST extractor helper (bollard-extract-go binary)
│   │   ├── go.mod
│   │   ├── main.go
│   │   ├── extract.go
│   │   └── extract_test.go
│   ├── extract_rs/               # Rust syn-based extractor helper (bollard-extract-rs binary)
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── main.rs
│   │       └── extract.rs
│   ├── extract_java/             # JavaParser + Kotlin regex + ASM (bollard-extract-java native image)
│   │   └── pom.xml, src/main/java/dev/bollard/extract/*.java
│   └── retro-adversarial.ts
├── docker/
│   ├── Dockerfile.verify         # Black-box adversarial test container (Node 22 + vitest)
│   ├── Dockerfile.verify-python  # Node + Python 3 runtime
│   ├── Dockerfile.verify-go      # Node + Go 1.22
│   ├── Dockerfile.verify-rust    # Node + Rust toolchain
│   └── Dockerfile.verify-jvm     # Node + Temurin JDK 21 + Maven
├── .env                          # ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY (gitignored)
├── package.json                  # root workspace
├── pnpm-workspace.yaml           # packages: ["packages/*"]
├── tsconfig.json                 # shared strict config (all packages extend this)
├── biome.json                    # shared lint/format config
│
├── packages/
│   ├── detect/                   ← TOOLCHAIN DETECTION (Stage 1.5)
│   │   ├── src/
│   │   │   ├── types.ts          # ToolchainProfile, AdversarialConfig, VerificationCommand, LanguageId, etc.
│   │   │   ├── concerns.ts       # defaultAdversarialConfig, resolveScopeConcerns, …
│   │   │   ├── detect.ts         # detectToolchain — main orchestrator
│   │   │   ├── derive.ts         # deriveSourcePatterns, deriveTestPatterns, etc.
│   │   │   └── languages/
│   │   │       ├── typescript.ts # Detect tsconfig, pnpm/yarn/npm, biome/eslint, vitest/jest
│   │   │       ├── python.ts     # Detect pyproject.toml, poetry/pipenv/uv, ruff/mypy, pytest
│   │   │       ├── go.ts         # Detect go.mod or go.work, golangci-lint, go vet/test
│   │   │       ├── rust.ts       # Detect Cargo.toml, clippy, cargo test/audit
│   │   │       ├── javascript.ts # Detect package.json w/o tsconfig, ESLint/Biome, Jest/Vitest/Mocha
│   │   │       ├── java.ts       # Maven/Gradle; Java vs Kotlin from source tree
│   │   │       └── fallback.ts   # Returns null; buildManualProfile for interactive init
│   │   └── tests/
│   │       ├── detect.test.ts    # 31 tests — all detectors + orchestrator
│   │       └── fixtures/         # ts-project/, …, go-workspace/ (go.work-only), empty-project/
│   │
│   ├── engine/                   ← THE KERNEL (Stage 0 + Stage 5a)
│   │   ├── src/
│   │   │   ├── types.ts          # Barrel re-exports for all engine types
│   │   │   ├── blueprint.ts      # Blueprint, BlueprintNode, NodeResult, NodeResultError
│   │   │   ├── errors.ts         # BollardError class + BollardErrorCode union
│   │   │   ├── context.ts        # PipelineContext (includes toolchainProfile?), createContext, BollardConfig
│   │   │   ├── runner.ts         # runBlueprint, AgenticHandler, HumanGateHandler, ProgressCallback, RunBlueprintCompleteCallback
│   │   │   ├── run-history.ts    # RunRecord, VerifyRecord, RunSummary, FileRunHistoryStore (JSONL + SQLite), RunComparison
│   │   │   ├── run-history-db.ts # SqliteIndex, createSqliteIndex — SQLite derived layer (dynamic import)
│   │   │   ├── proper-lockfile.d.ts  # Type declarations for proper-lockfile
│   │   │   ├── cost-tracker.ts   # CostTracker class
│   │   │   └── eval-runner.ts    # runEvals — eval case runner for agent prompts
│   │   └── tests/
│   │       ├── runner.test.ts
│   │       ├── run-history.test.ts  # Phase 1 tests + Phase 2 summary/rebuild
│   │       ├── run-history-db.test.ts  # 16 tests — SQLite schema, round-trips, filters, summary, rebuild
│   │       ├── errors.test.ts
│   │       ├── context.test.ts
│   │       ├── cost-tracker.test.ts
│   │       └── eval-runner.test.ts
│   │
│   ├── llm/                      ← LLM ABSTRACTION (Stage 0 + Stage 2)
│   │   ├── src/
│   │   │   ├── types.ts          # LLMProvider, LLMRequest, LLMResponse, LLMStreamEvent, optional chatStream, etc.
│   │   │   ├── client.ts         # LLMClient — resolves provider per-agent from config
│   │   │   ├── providers/
│   │   │   │   ├── anthropic.ts  # AnthropicProvider + chatStream (Messages streaming API)
│   │   │   │   ├── openai.ts     # OpenAIProvider — Chat Completions + streaming
│   │   │   │   └── google.ts     # GoogleProvider — Generative AI + streaming
│   │   │   └── mock.ts           # MockProvider — deterministic mock for testing
│   │   └── tests/
│   │       ├── client.test.ts    # Provider resolution + live smoke tests
│   │       ├── openai.test.ts    # OpenAI mapping + live smoke test (skips if no key)
│   │       └── google.test.ts    # Google mapping + live smoke test (skips if no key)
│   │
│   ├── agents/                   ← AGENT INFRASTRUCTURE (Stage 1 + 1.5)
│   │   ├── src/
│   │   │   ├── types.ts          # AgentTool, AgentContext, AgentDefinition, AgentResult
│   │   │   ├── executor.ts       # executeAgent — multi-turn tool-use loop
│   │   │   ├── prompt-template.ts # fillPromptTemplate — {{variable}} replacement from ToolchainProfile
│   │   │   ├── planner.ts        # createPlannerAgent(profile?) — read-only tools, structured JSON output
│   │   │   ├── coder.ts          # createCoderAgent(profile?) — all tools, implements plans
│   │   │   ├── boundary-tester.ts # createBoundaryTesterAgent(profile?) — boundary-scope adversarial tests
│   │   │   ├── contract-tester.ts # createContractTesterAgent(profile?) — contract-scope adversarial tests
│   │   │   ├── semantic-reviewer.ts # createSemanticReviewerAgent(profile?) — post-mutation diff review (no tools)
│   │   │   ├── eval-loader.ts    # loadEvalCases, availableAgents
│   │   │   ├── tools/
│   │   │   │   ├── index.ts      # ALL_TOOLS, READ_ONLY_TOOLS
│   │   │   │   ├── read-file.ts  # Read file contents (path-traversal protected)
│   │   │   │   ├── write-file.ts # Write file, create dirs (path-traversal protected)
│   │   │   │   ├── edit-file.ts  # Surgical string replacement in files (Stage 2)
│   │   │   │   ├── list-dir.ts   # List directory with type indicators
│   │   │   │   ├── search.ts     # Ripgrep-based search with glob filtering (fixed-string default)
│   │   │   │   └── run-command.ts # Execute whitelisted commands with timeout
│   │   │   └── evals/
│   │   │       ├── planner/cases.ts  # 4 eval cases for planner output quality
│   │   │       ├── coder/cases.ts    # 2 eval cases for coder output quality
│   │   │       ├── boundary-tester/cases.ts
│   │   │       └── contract-tester/cases.ts
│   │   ├── prompts/
│   │   │   ├── planner.md        # System prompt with {{language}}, {{packageManager}}, etc. placeholders
│   │   │   ├── coder.md          # System prompt with {{testFramework}}, {{typecheck}}, {{linter}} placeholders
│   │   │   ├── boundary-tester.md # Boundary scope + {{#concern}} concern lenses
│   │   │   ├── contract-tester.md
│   │   │   └── semantic-reviewer.md
│   │   └── tests/
│   │       ├── executor.test.ts  # 19 tests — multi-turn, max turns, errors, cost, verification
│   │       ├── tools.test.ts     # 17 tests — all 6 tools + path traversal guards
│   │       ├── prompt-template.test.ts  # 9 tests — placeholder replacement, TS/Python profiles
│   │       ├── planner.test.ts   # 5 tests — prompt loading, read-only tools, JSON schema
│   │       ├── coder.test.ts     # 5 tests — prompt loading, full toolset, turns, maxTurns
│   │       ├── boundary-tester.test.ts
│   │       └── contract-tester.test.ts
│   │
│   ├── verify/                   ← VERIFICATION (Stage 1 + 1.5 + Stage 2)
│   │   ├── src/
│   │   │   ├── static.ts         # runStaticChecks(workDir, profile?) — profile-driven or hardcoded fallback
│   │   │   ├── dynamic.ts        # runTests(workDir, testFiles?, profile?) — profile-driven test execution
│   │   │   ├── type-extractor.ts # SignatureExtractor, TsCompilerExtractor, LlmFallbackExtractor, getExtractor
│   │   │   ├── contract-extractor.ts # Barrel re-export from contract-providers/
│   │   │   ├── contract-providers/
│   │   │   │   ├── types.ts          # ModuleNode, ContractEdge, ContractContext, ContractGraphProvider, buildContractContext router
│   │   │   │   ├── typescript.ts     # TypeScriptContractProvider + TS workspace helpers
│   │   │   │   ├── python.ts         # PythonContractProvider + Python workspace helpers
│   │   │   │   ├── go.ts             # GoContractProvider + Go workspace helpers
│   │   │   │   ├── rust.ts           # RustContractProvider + Cargo workspace helpers
│   │   │   │   └── java.ts           # JavaContractProvider (Maven/Gradle multi-module)
│   │   │   ├── extractors/       # python.ts, go.ts, rust.ts, java.ts — deterministic SignatureExtractor
│   │   │   ├── behavioral-extractor.ts  # buildBehavioralContext — endpoints, config, deps, failure modes (regex)
│   │   │   ├── behavioral-grounding.ts  # behavioralContextToCorpus → contract-style claim grounding
│   │   │   ├── fault-injector.ts       # createFaultInjector — service_stop via docker compose (extensible)
│   │   │   ├── compose-generator.ts  # generateVerifyCompose, generateBehavioralCompose
│   │   │   ├── mutation.ts       # runMutationTesting — Stryker / mutmut / cargo-mutants / pitest by language
│   │   │   ├── review-grounding.ts # parseReviewDocument, verifyReviewGrounding (semantic review Layer 1)
│   │   │   └── test-lifecycle.ts # resolveTestOutputDir, resolveContractTestOutputRel, resolveBehavioralTestOutputRel, writeTestMetadata, …
│   │   └── tests/
│   │       ├── static.test.ts    # 4 tests — structure + live integration
│   │       ├── dynamic.test.ts   # 2 tests — integration test
│   │       ├── type-extractor.test.ts  # signatures, types, extractors
│   │       ├── extractor-helpers.test.ts  # bollard-extract-go/rs/java helper binaries
│   │       ├── contract-extractor.test.ts
│   │       ├── compose-generator.test.ts  # 6 tests — YAML generation per language/mode
│   │       └── test-lifecycle.test.ts  # lifecycle resolution, output dirs, metadata
│   │
│   ├── blueprints/               ← BLUEPRINT DEFINITIONS (Stage 1 + 1.5 + 2)
│   │   ├── src/
│   │   │   ├── implement-feature.ts  # 28-node pipeline: boundary + contract + behavioral + probes + mutation + semantic review + docker-verify
│   │   │   └── write-tests-helpers.ts  # deriveAdversarialTestPath (scope: boundary | contract | behavioral), stripMarkdownFences
│   │   └── tests/
│   │       ├── implement-feature.test.ts  # node order, types, structure
│   │       └── write-tests-helpers.test.ts  # test path derivation, fence stripping
│   │
│   ├── cli/                      ← CLI (Stage 0 + Stage 1 + Stage 1.5 + Stage 2 + Stage 4d + Stage 5a)
│   │   ├── src/
│   │   │   ├── index.ts          # Entry: parse args, route commands, progress output
│   │   │   ├── config.ts         # detectToolchain + .bollard.yml overrides + ToolchainProfile
│   │   │   ├── adversarial-yaml.ts
│   │   │   ├── contract-plan.ts # collectAffectedPathsFromPlan
│   │   │   ├── agent-handler.ts  # Multi-turn agentic handler (threads profile to agents)
│   │   │   ├── diff.ts           # diffToolchainProfile — compare profile vs Stage 1 defaults
│   │   │   ├── human-gate.ts     # Interactive human approval via stdin
│   │   │   ├── history.ts        # runHistoryCommand — CLI list/show/compare/summary/rebuild with table output
│   │   │   ├── history-record.ts # buildRunRecord, buildVerifyRecord — assemble history records from pipeline results
│   │   │   ├── git-utils.ts      # getHeadSha — git rev-parse HEAD helper
│   │   │   ├── template-renderer.ts  # renderTemplate — profile-driven config file generation
│   │   │   ├── ide-detect.ts     # parseIdePlatform — cursor, claude-code, codex, antigravity, all
│   │   │   ├── init-ide.ts       # generateIdeConfigs, writeGeneratedFiles, mergeJsonFile
│   │   │   ├── watch.ts          # bollard watch — fs.watch + debounced runStaticChecks
│   │   │   ├── quiet-verify.ts   # formatQuietVerifyResult — JSON shape for verify --quiet
│   │   │   └── generators/
│   │   │       ├── cursor.ts
│   │   │       ├── claude-code.ts
│   │   │       ├── antigravity.ts
│   │   │       └── codex.ts
│   │   └── tests/
│   │       ├── config.test.ts    # 10 tests — defaults, detection, YAML, profile
│   │       ├── profile-flag.test.ts  # 2 tests — verify --profile flag
│   │       ├── diff.test.ts      # 6 tests — diff helper
│   │       └── config.adversarial.test.ts
│   │
│   ├── observe/                  ← PRODUCTION FEEDBACK LOOP (Stage 4b)
│   │   ├── src/
│   │   │   ├── providers/types.ts   # ProbeExecutor, MetricsStore, FlagProvider, DeploymentTracker, DriftDetector
│   │   │   ├── providers/resolve.ts   # resolveProviders — built-in only in 4b
│   │   │   ├── probe-extractor.ts   # extractProbes from behavioral claims
│   │   │   ├── probe-runner.ts      # HttpProbeExecutor
│   │   │   ├── probe-scheduler.ts   # runOnce / watch
│   │   │   ├── metrics-store.ts     # FileMetricsStore (JSONL)
│   │   │   ├── deployment-tracker.ts
│   │   │   ├── drift-detector.ts    # GitDriftDetector
│   │   │   ├── flag-manager.ts
│   │   │   └── rollout.ts
│   │   └── tests/
│   │
│   └── mcp/                      ← MCP SERVER (Stage 2 + 4b + Stage 4d)
│       ├── src/
│       │   ├── server.ts         # MCP server entry point (stdio transport)
│       │   ├── tools.ts          # MCP tools (enriched descriptions in Stage 4d)
│       │   ├── resources.ts      # 6 resource endpoints (bollard://profile, etc.)
│       │   └── prompts.ts        # 3 prompt templates
│       └── tests/
│           └── tools.test.ts     # tool definitions, schemas, handlers
```

## Current Test Stats

- **Run `docker compose run --rm dev run test` for authoritative counts** (Stage 3a added contract/boundary tests and contract extractor coverage).
- **Adversarial suite:** `vitest.adversarial.config.ts` — `packages/*/tests/**/*.adversarial.test.ts`
- **Source:** 9 packages; prompts include `planner.md`, `coder.md`, `boundary-tester.md`, `contract-tester.md`, `behavioral-tester.md`
- **Latest count (authoritative, 2026-05-05, Stage 5a hardening):** `897` passed, `4` skipped (901 total). Skips: 4 LLM live smoke tests (no key). +2 from search fallback tests, agent-handler fail-path alignment.
- **Adversarial suite** (`vitest.adversarial.config.ts`): `335` tests in `30` files — full glob `packages/*/tests/**/*.adversarial.test.ts`; all legacy files were rewritten to current API shapes (Stage 4c). +4 from cleanup (audit/secretScan hook, rollback paths).
- **Vitest + Vite 8:** you may see `esbuild` option deprecated in favor of `oxc` — harmless until Vitest defaults align; pin Vite 7.x if you need a silent log.

### Mutation Testing (Stage 3c)

- **TypeScript / JavaScript:** Stryker 9.6.0 + `@stryker-mutator/vitest-runner`
- **Python:** mutmut (via `runMutationTesting` → `MutmutProvider`)
- **Rust:** cargo-mutants JSON (via `CargoMutantsProvider`)
- **Baseline score (engine):** 70.74% (79.09% on covered code)
- **Baseline score (engine + detect + verify + blueprints):** 45.32% (63.02% on covered code)
- **Default threshold:** 60% (configurable via `.bollard.yml` `mutation:` section)
- **Run command (Stryker):** `docker compose run --rm dev exec stryker run`
- **Config:** `stryker.config.json` (root); `vitest.stryker.config.ts` excludes integration tests that break on instrumented code
- **Pipeline node:** `run-mutation-testing` (after `run-contract-tests`), opt-in via `mutation.enabled: true` in `.bollard.yml`
- **Dockerfile:** `procps` required in dev image for Stryker's worker process management
- **Full results:** [spec/stage3c-validation-results.md](spec/stage3c-validation-results.md)

### Stage 3a follow-ups (agent UX)

Long LLM waits no longer look frozen: `executeAgent` emits optional `AgentProgressEvent`s (`turn_start` / `turn_end` / `tool_call_start` / `tool_call_end`, and `stream_delta` when the provider implements `chatStream`) via `AgentContext.progress`. The CLI wires them to `createAgentSpinner()` — TTY sessions get an in-place braille spinner with elapsed time and per-tool hints; non-TTY (CI, pipes) gets one line per milestone with no ANSI escapes. See `packages/cli/src/spinner.ts`, `packages/agents/tests/executor.progress.test.ts`, and `packages/agents/tests/executor.stream.test.ts`.

### Stage 3a validation (maintainers)

```bash
docker compose build dev
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
docker compose run --rm dev --filter @bollard/cli run start -- verify --profile
docker compose run --rm dev --filter @bollard/cli run start -- contract
docker compose run --rm dev --filter @bollard/cli run start -- behavioral
```

## Stage 2 Validation (2026-04-02)

- **Test suite:** 344/344 pass, typecheck clean, lint clean
- **Milestone (TS):** Pipeline ran nodes 1–5 (create-branch → generate-plan → approve-plan → implement → static-checks). Coder correctly used `edit_file` for existing files. Failed at static-checks (Biome lint formatting) due to `deferPostCompletionVerifyFromTurn` (née `skipVerificationAfterTurn`) skipping lint after turn 48/60.
- **Milestone (Python):** `--work-dir` flag validated. `detectToolchain` correctly identified Python/pytest/ruff. Planner produced Python-specific plan. Coder exhausted 60 turns because `python`/`pytest` were not in `allowedCommands` — **fixed in post-validation cleanup** (test.cmd and pip-audit now whitelisted).
- **Retro-adversarial:** Tester generated tests for 5 packages ($0.34 total). Information barrier held (no private identifiers leaked). All outputs include property-based tests. Key issue: tester constructs invalid ToolchainProfile stubs (uses wrong field names). See `.bollard/retro-adversarial/SUMMARY.md`.
- **Bug fixed:** `eval-runner.ts` regex validation — invalid regex in `matches_regex` assertion now returns `passed: false` instead of crashing.
- **Post-validation cleanup (2026-04-02):** Fixed Python `allowedCommands` gap, added `LlmFallbackExtractor` warn logging, renamed `integrateWithTestRunner` → `checkTestRunnerIntegration` with corrected return semantics, hardened `promote-test` CLI command, aligned MCP `tsconfig.json`, archived 12 historical spec prompts.

## Stage 3a Validation (2026-04-08) — Status **GREEN**

Full per-check results: [`spec/stage3a-validation-results.md`](../spec/stage3a-validation-results.md).

- **Test suite (post-GREEN, 2026-04-08):** 461 passed / 4 skipped; typecheck + lint clean. (+55 from grounding golden corpus and pipeline-generated `CostTracker.subtract()` tests.)
- **Information barrier fix:** `buildContractContext` now limits `publicExports` / reachable types to files in the `package.json` `exports["."]` re-export closure — private engine internals (`compactOlderTurns`, `deferPostCompletionVerifyFromTurn`, etc.) no longer leak into the contract-tester prompt. Regression test added.
- **Executor rename:** `ExecutorOptions.skipVerificationAfterTurn` → `deferPostCompletionVerifyFromTurn` (more accurately describes the deferral semantics — the post-completion verification hook is deferred above the 80% turn budget, not permanently skipped).
- **`pnpm.overrides` for `vite >= 7.3.2`:** Clears the high-severity GHSA surfaced by `pnpm audit --audit-level=high` — unblocks the `static-checks` node in `implement-feature`.
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

Grounding-layer post-mortem and the "when to add a deterministic filter" principle are captured in [spec/adr/0001-deterministic-filters-for-llm-output.md](../spec/adr/0001-deterministic-filters-for-llm-output.md). Read it before adding any similar post-filter in Stage 3b.

**Reproduction command** (for future regression runs — the `sh -c` wrapper is mandatory because Compose v2 intercepts bare `--filter`):

```bash
docker compose run --rm -e BOLLARD_AUTO_APPROVE=1 dev sh -c \
  'pnpm --filter @bollard/cli run start -- run implement-feature --task "…" --work-dir /app'
```

## Stage 3b Validation (2026-04-09) — Status **GREEN**

Full per-check results: [`spec/stage3b-validation-results.md`](../spec/stage3b-validation-results.md).

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

**Moved to Stage 4c:** Java/Kotlin language expansion (Wave 1). Verification summary batching + coder git rollback are **done** (Stage 4c cleanup). See [spec/ROADMAP.md](../spec/ROADMAP.md).

## Key Types (Source of Truth)

### BollardErrorCode + BollardError (packages/engine/src/errors.ts)

- `BollardErrorCode` is a string union of all error codes (LLM_TIMEOUT, LLM_RATE_LIMIT, LLM_AUTH, LLM_PROVIDER_ERROR, LLM_INVALID_RESPONSE, COST_LIMIT_EXCEEDED, TIME_LIMIT_EXCEEDED, NODE_EXECUTION_FAILED, POSTCONDITION_FAILED, STATIC_CHECK_FAILED, TEST_FAILED, MUTATION_THRESHOLD_NOT_MET, CONTRACT_VIOLATION, HUMAN_REJECTED, RISK_GATE_BLOCKED, CONFIG_INVALID, DETECTION_FAILED, PROFILE_INVALID, PROVIDER_NOT_FOUND, MODEL_NOT_AVAILABLE, CONCERN_CONFIG_INVALID, CONTRACT_TESTER_OUTPUT_INVALID, CONTRACT_TESTER_NO_GROUNDED_CLAIMS, REVIEW_OUTPUT_INVALID, BEHAVIORAL_CONTEXT_EMPTY, BEHAVIORAL_TESTER_OUTPUT_INVALID, BEHAVIORAL_NO_GROUNDED_CLAIMS, FAULT_INJECTION_FAILED, PROBE_EXECUTION_FAILED, PROBE_ASSERTION_FAILED, DRIFT_DETECTED, ROLLOUT_BLOCKED, FLAG_NOT_FOUND, IDE_CONFIG_INVALID).
- `BollardError extends Error` with `code`, `context`, `retryable` (getter — true for LLM_TIMEOUT, LLM_RATE_LIMIT, LLM_PROVIDER_ERROR).
- Static methods: `BollardError.is(err)` type guard, `BollardError.hasCode(err, code)`.

### ToolchainProfile + VerificationCommand + LanguageId (packages/detect/src/types.ts)

- `LanguageId` is a string union: `"typescript" | "javascript" | "python" | "go" | "rust" | "java" | "kotlin" | "ruby" | "csharp" | "elixir" | "unknown"`.
- `PackageManagerId` is a string union: `"pnpm" | "npm" | "yarn" | "bun" | "poetry" | "pipenv" | "uv" | "pip" | "go" | "cargo" | "bundler" | "gradle" | "maven"`.
- `VerificationCommand { label: string; cmd: string; args: string[]; source: ConfigSource }` — a single executable check.
- `ToolchainProfile { …; adversarial: AdversarialConfig }` — per-scope `boundary` / `contract` / `behavioral` with `enabled`, `integration`, `lifecycle`, `concerns`, `frameworkCapable?`, and boundary-only `mode` / `runtimeImage`. Computed from auto-detection + root `adversarial:` YAML + legacy `toolchain.adversarial` (maps to `boundary` when root block absent).
- `detectToolchain(cwd): Promise<ToolchainProfile>` — orchestrator that runs per-language detectors (TypeScript → Python → Go → Rust → fallback) and returns the first match.
- `fillPromptTemplate(template, profile, scopeConcerns?)` — replaces `{{variable}}` placeholders, `{{#if isTypeScript}}…{{/if}}` blocks, `{{concerns.*.weight}}`, and `{{#concern x}}…{{/concern}}` (stripped when weight is `off` or `scopeConcerns` omitted). Variables: `{{language}}`, `{{packageManager}}`, `{{typecheck}}`, `{{linter}}`, `{{testFramework}}`, `{{auditTool}}`, `{{allowedCommands}}`, `{{sourcePatterns}}`, `{{testPatterns}}`. Booleans: `isTypeScript`, `isPython`, `isGo`, `isRust`.

### Blueprint types (packages/engine/src/blueprint.ts)

- `NodeType = "deterministic" | "agentic" | "risk_gate" | "human_gate"`
- `NodeResultError { code: string; message: string }` — structured error on node results
- `NodeResult { status: "ok" | "fail" | "block"; data?; cost_usd?; duration_ms?; error?: NodeResultError; probes?: ProbeDefinition[] }`
- `BlueprintNode { id; name; type: NodeType; execute?; agent?; postconditions?; onFailure?: "stop" | "retry" | "skip" | "hand_to_human"; maxRetries? }`
- `Blueprint { id; name; nodes: BlueprintNode[]; maxCostUsd; maxDurationMinutes }`

### PipelineContext (packages/engine/src/context.ts)

- Single source of truth for a run. Flat type with optional fields that grow across stages.
- Fields: `runId, task, blueprintId, config, currentNode, results, changedFiles, gitBranch?, rollbackSha?` (HEAD at branch creation, for coder failure rollback), `plan?: unknown, mutationScore?, generatedProbes?, deploymentManifest?, toolchainProfile?: ToolchainProfile, costTracker, log, upgradeRunId(taskSlug)`.
- `plan` is typed as `unknown` — the planner agent stores parsed JSON here, the coder agent reads it.
- `toolchainProfile` is set by the CLI from auto-detection; used by blueprint nodes for profile-driven verification.

### Runner (packages/engine/src/runner.ts)

`runBlueprint(blueprint, task, config, agenticHandler?, humanGateHandler?, onProgress?, toolchainProfile?, onRunComplete?) → Promise<RunResult>`

- The optional trailing `toolchainProfile` was added in Stage 3a validation. When provided, the runner sets `ctx.toolchainProfile` on the created `PipelineContext`. The CLI `implement-feature` command threads the profile from `resolveConfig` — without it, contract nodes silently skip with `contract scope disabled`.
- `RunBlueprintCompleteCallback = (ctx, result, blueprint) => Promise<void>` — called after the pipeline completes (success or failure) but before `runBlueprint` returns. Used by the CLI to persist `RunRecord` to history. Errors in the callback are caught and logged via `ctx.log.warn` — they never fail the pipeline.

- `AgenticHandler = (node, ctx) => Promise<NodeResult>` — called for agentic nodes. The CLI wraps multi-turn agent execution behind this callback.
- `HumanGateHandler = (node, ctx) => Promise<NodeResult>` — called for human_gate nodes. The CLI implements interactive stdin approval.
- `ProgressCallback = (event: ProgressEvent) => void` — called before/after each node for CLI status output.
- `ProgressEvent { type: "node_start" | "node_complete" | "node_retry"; nodeId; nodeName; nodeType; step; totalSteps; status?; attempt?; maxAttempts?; costUsd?; durationMs? }`

### Agent types (packages/agents/src/types.ts)

- `AgentTool { name; description; inputSchema; execute(input, ctx): Promise<string> }`
- `AgentContext { pipelineCtx: PipelineContext; workDir: string; allowedCommands?: string[] }`
- `AgentDefinition { role; systemPrompt; tools: AgentTool[]; maxTurns; temperature }`
- `AgentResult { response; data?; totalCostUsd; totalDurationMs; turns; toolCalls }`

### Multi-turn executor (packages/agents/src/executor.ts)

`executeAgent(agent, userMessage, provider, model, ctx) → Promise<AgentResult>`

The core Stage 1 upgrade. Runs a tool-use loop:
1. Send messages to LLM with tools (uses `chatStream` when the provider implements it, otherwise `chat`)
2. If `stopReason === "tool_use"`, execute each tool, collect results
3. Append assistant message + tool results, loop back to step 1
4. If `stopReason !== "tool_use"`, extract text response and return
5. Throws `NODE_EXECUTION_FAILED` if `maxTurns` exceeded

### Agent tools (packages/agents/src/tools/)

| Tool | Name | Access | Description |
|------|------|--------|-------------|
| read-file | `read_file` | Planner + Coder | Read file contents, path-traversal protected |
| write-file | `write_file` | Coder only | Write/overwrite files, creates parent dirs |
| edit-file | `edit_file` | Coder only | Surgical file editing: string replacement OR line-range replacement (Stage 2 + 5a hardening) |
| list-dir | `list_dir` | Planner + Coder | List directory contents with type indicators |
| search | `search` | Planner + Coder | Ripgrep-based search with fixed-string default (optional regex mode) |
| run-command | `run_command` | Coder only | Execute whitelisted commands (pnpm, node, tsc, biome, git, rm, etc.) with path guards |

All tools enforce path-traversal protection: resolved path must start with `workDir`.

### Agents

- **Planner** (`createPlannerAgent(profile?)`): read-only tools, temperature 0.2, max 25 turns. Produces structured JSON plan with summary, acceptance criteria, affected files, risk assessment, steps.
- **Coder** (`createCoderAgent(profile?)`): all 6 tools, temperature 0.3, max 80 turns. Implements plans, writes tests. Prefers `edit_file` for existing files, `write_file` for new files. Verification hook skipped after 80% of turns to prevent budget exhaustion.
- **Boundary tester** (`createBoundaryTesterAgent(profile?)`): no tools, temperature 0.3, max 5 turns. Generates boundary-scope adversarial tests from type signatures and referenced type definitions; prompt includes four concern lenses when weights are not `off`.
- **Contract tester** (`createContractTesterAgent(profile?)`): no tools, temperature 0.4, max 10 turns. Generates contract-scope tests from `ContractContext` (module graph + edges); language/framework via profile.
- **Behavioral tester** (`createBehavioralTesterAgent(profile?)`): no tools, temperature 0.5, max 15 turns. Generates behavioral-scope tests from `BehavioralContext` (endpoints, config, dependencies, failure modes); concern lenses via profile.

All agent creation functions accept an optional `ToolchainProfile` — when provided, prompt `{{placeholders}}` and `{{#if}}` conditionals are filled with detected language/tool values.

### Static verification (packages/verify/src/static.ts)

`runStaticChecks(workDir, profile?) → { results: StaticCheckResult[]; allPassed: boolean }`

When `profile` is provided, runs checks from `profile.checks` (typecheck, lint, audit, secretScan). When omitted, falls back to hardcoded TypeScript defaults (`pnpm run typecheck`, `pnpm run lint`, `pnpm audit`, `gitleaks detect`).

### Dynamic test runner (packages/verify/src/dynamic.ts)

`runTests(workDir, testFiles?, profile?) → TestRunResult`

When `profile?.checks.test` is provided, uses its `cmd`/`args`. When omitted, falls back to `pnpm exec vitest run`.

### implement-feature blueprint (packages/blueprints/src/implement-feature.ts)

28-node pipeline:

1. **create-branch** (deterministic) — `git checkout -b bollard/{runId}`; sets `ctx.rollbackSha` (`git rev-parse HEAD`) best-effort
2. **generate-plan** (agentic/planner) — planner agent explores codebase, produces JSON plan
3. **approve-plan** (human_gate) — shows plan, waits for human approval
4. **implement** (agentic/coder) — coder agent implements plan with full toolset
5. **static-checks** (deterministic) — profile-driven typecheck + lint + audit + secretScan; `onFailure: "skip"` (trust-but-verify after coder hook; failure is logged, pipeline continues)
6. **extract-signatures** (deterministic) — extract signatures + types (TS + deterministic Python/Go/Rust extractors; LLM fallback only for unknown languages when a provider is configured)
7. **generate-tests** (agentic/boundary-tester) — boundary-scope adversarial tests
8. **write-tests** (deterministic) — strip fences, `deriveAdversarialTestPath(..., "boundary")`, leak scan
9. **run-tests** (deterministic) — profile-driven test execution; `onFailure: "skip"` (coder hook already ran tests; e.g. boundary test bugs should not block downstream scopes)
10. **assess-contract-risk** (deterministic) — emits `contract_scope_decision` event; skips downstream contract nodes when risk is low and no exported symbols changed
11. **extract-contracts** (deterministic) — `buildContractContext` (skipped when `!profile.adversarial.contract.enabled` or risk-gate says skip)
12. **generate-contract-tests** (agentic/contract-tester) — emits JSON claims document (skipped in agent-handler when contract disabled)
13. **verify-claim-grounding** (deterministic) — `parseClaimDocument` + `verifyClaimGrounding` against `ContractCorpus`; drops ungrounded claims, fails on zero survivors (`CONTRACT_TESTER_NO_GROUNDED_CLAIMS`) or malformed JSON (`CONTRACT_TESTER_OUTPUT_INVALID`)
14. **write-contract-tests** (deterministic) — assembles surviving claim `.test` fields into a test file, `resolveContractTestOutputRel` + contract path basename, TS leak scan
15. **run-contract-tests** (deterministic) — `runTests` with only the new contract test file path
16. **extract-behavioral-context** (deterministic) — `buildBehavioralContext`; skips downstream when `!profile.adversarial.behavioral.enabled` or empty context (`BEHAVIORAL_CONTEXT_EMPTY`)
17. **generate-behavioral-tests** (agentic/behavioral-tester) — JSON claims for behavioral scope (skipped when behavioral disabled or empty context)
18. **verify-behavioral-grounding** (deterministic) — `parseClaimDocument` + `verifyClaimGrounding` with `behavioralContextToCorpus`; behavioral error codes for parse / empty survivors
19. **write-behavioral-tests** (deterministic) — assemble grounded claims, `resolveBehavioralTestOutputRel`, leak scan
20. **run-behavioral-tests** (deterministic) — writes `compose.behavioral.yml`, `runTests` on behavioral test file
21. **extract-probes** (deterministic) — `extractProbes` from grounded behavioral claims → `ProbeDefinition[]`, persist `.bollard/probes/*.json`, set `ctx.generatedProbes` / `NodeResult.probes`
22. **run-mutation-testing** (deterministic) — profile-driven mutation run (Stryker / mutmut / cargo-mutants); skipped when mutation disabled or not applicable
23. **generate-review-diff** (deterministic) — unified diff for semantic review input
24. **semantic-review** (agentic/semantic-reviewer) — structured JSON review findings (no tools)
25. **verify-review-grounding** (deterministic) — `parseReviewDocument` + `verifyReviewGrounding`; drops ungrounded findings
26. **docker-verify** (deterministic) — Docker-isolated adversarial test execution (gracefully degrades without Docker)
27. **generate-diff** (deterministic) — `git diff --stat main`
28. **approve-pr** (human_gate) — shows diff summary and review findings, waits for human approval

### CLI commands

| Command | Description |
|---------|-------------|
| `run demo --task "..."` | Stage 0 demo blueprint (1 deterministic + 1 agentic node) |
| `run implement-feature --task "..." [--work-dir <path>]` | Full Stage 1 pipeline with human gates (optional work dir override) |
| `plan --task "..." [--work-dir <path>]` | Standalone planner agent (no implementation) |
| `verify [--profile] [--work-dir <path>] [--quiet]` | Run static checks (or show detected profile as JSON); `--quiet` emits JSON on failure (hooks) |
| `init --ide <platform>` | Generate platform-specific config (`cursor`, `claude-code`, `codex`, `antigravity`, `all`) |
| `watch [--quiet] [--debounce N]` | Continuous verification — re-verify on file changes |
| `verify --quiet` | Machine-readable JSON verification output (for hooks) |
| `contract [--plan <file>] [--work-dir <path>]` | Print `ContractContext` JSON (optional planner JSON for affected paths) |
| `behavioral [--work-dir <path>]` | Print `BehavioralContext` JSON |
| `diff` | Compare detected profile vs hardcoded Stage 1 defaults |
| `eval [agent]` | Run eval sets (planner, coder, boundary-tester, contract-tester, behavioral-tester; `tester` aliases boundary) |
| `config show [--sources]` | Show resolved configuration |
| `init [--mode=...] [--persist] [--ide <platform>]` | Detect project configuration, generate `.bollard.yml` (+ optional IDE integration files) |
| `promote-test <path>` | Promote adversarial test to project test directory |
| `probe` (`run`, `watch`, `list`) | HTTP probes from `.bollard/probes/` (`--url` / `observe.baseUrl`) |
| `deploy` (`record`, `list`, `current`) | Built-in deployment tracker (`.bollard/observe/deployments.json`) |
| `flag` (`set`, `list`, `kill`) | File-based flags (`.bollard/flags/flags.json`) |
| `drift` (`check`, `watch`) | Git drift vs `.bollard/observe/last-verified.json` |
| `history` [list\|show\|compare\|summary\|rebuild] | Run history — list/show/compare/summary/rebuild (`--json`, `--limit`, `--status`, `--blueprint`) |

All commands output colored, structured progress to stderr. JSON results go to stdout.

## Coding Conventions

### Style

- **No default exports.** Use named exports only.
- **No semicolons.** Biome enforces this.
- **No classes unless necessary.** Prefer functions + interfaces. Exceptions: `BollardError`, `CostTracker`, `LLMClient`, provider implementations.
- **No `any`.** Use `unknown` and narrow. TypeScript strict mode catches the rest.
- **No barrel files** that re-export everything. Each package has a `types.ts` that re-exports public types, but implementation files import directly.
- **Naming:** camelCase for functions/variables, PascalCase for types/classes, UPPER_SNAKE for constants. File names: kebab-case.
- **Error handling:** Always use `BollardError` with appropriate code. Never throw raw `Error`. Attach context (nodeId, runId, cost) to every error.
- **Logging:** Use `ctx.log.*` for all logging during pipeline execution. Never use `console.log`.
- **Import ordering:** Biome sorts imports alphabetically. Run `biome check --fix --unsafe .` to auto-fix.
- **`exactOptionalPropertyTypes`:** Optional properties cannot be set to `undefined` explicitly. Use spread `...(val !== undefined ? { key: val } : {})` instead.

### Dependencies

- Minimize external dependencies. Runtime deps are:
  - `@anthropic-ai/sdk` (in @bollard/llm)
  - `openai` (in @bollard/llm)
  - `@google/generative-ai` (in @bollard/llm)
  - `@modelcontextprotocol/sdk` (in @bollard/mcp)
  - `zod` (for config/input validation in @bollard/cli, @bollard/mcp)
  - `yaml` (for .bollard.yml parsing in @bollard/cli)
  - `proper-lockfile` (for concurrent JSONL append safety in @bollard/engine — ~12 KB, zero transitive deps)
  - `better-sqlite3` (for SQLite derived query layer in @bollard/engine — ~3 MB, dynamically imported, graceful fallback to JSONL-only when unavailable)
- Dev deps: `typescript`, `vitest`, `@biomejs/biome`, `tsx`, `fast-check`
- If you're about to add a dependency, think twice. Can it be done in 50 lines of TypeScript instead?
- **Install deps via Docker:** `docker compose run --rm dev add <package>` (then `docker compose build dev` to bake into image).

### Testing

- **Always run tests via Docker:** `docker compose run --rm dev run test`
- Every source file gets a corresponding test file.
- Tests use Vitest (`describe`, `it`, `expect`).
- Use the `MockProvider` (from @bollard/llm) for all engine/agent tests. No real LLM calls in unit tests.
- Live smoke tests in `@bollard/llm` for Anthropic, OpenAI, and Google (gracefully skip if no key).
- Agent tools are tested against real temp directories (created/cleaned per test).
- The `@bollard/verify` integration test runs actual typecheck + lint against the bollard repo itself.
- Test names should describe behavior, not implementation.

### Config Resolution (packages/cli/src/config.ts)

Priority: CLI flags → env vars → .bollard.yml → auto-detected → hardcoded defaults.

Every resolved value has a `source` annotation: `"auto-detected"`, `"env:BOLLARD_MODEL"`, `"file:.bollard.yml"`, or `"default"`.

## Scope Control

### Stage 0 (DONE):
- Engine types, sequential runner, CostTracker
- LLM types, LLMClient, AnthropicProvider, MockProvider
- CLI skeleton with `run demo`, `config show`, `init`
- Config auto-detection + .bollard.yml
- Eval runner framework

### Stage 1 (DONE):
- Multi-turn agent executor with tool-use loop
- 5 agent tools (read-file, write-file, list-dir, search, run-command)
- Planner agent (read-only tools, structured JSON plan output)
- Coder agent (all tools, implements plans)
- Static verification package (tsc, biome, audit, gitleaks)
- `implement-feature` blueprint (11-node pipeline with human gates, extended to 12 in Stage 2)
- CLI commands: `plan`, `verify`, `run implement-feature`, `eval`
- Human gate handler (interactive stdin approval)
- Agent eval sets (planner: 4 cases, coder: 2 cases)
- Progress callbacks for CLI status output
- Runner upgrades: HumanGateHandler, ProgressCallback, structured NodeResult.error

### Stage 1.5 (DONE):
- `@bollard/detect` package with `ToolchainProfile`, per-language detectors (TypeScript, Python, Go, Rust)
- `detectToolchain(cwd)` orchestrator — auto-detect language, package manager, linter, test framework, type checker
- `fillPromptTemplate(template, profile)` — `{{placeholder}}` replacement in agent prompts
- Profile-driven `runStaticChecks(workDir, profile?)` and `runTests(workDir, testFiles?, profile?)`
- Agent creation functions accept optional `ToolchainProfile` for templatized prompts
- CLI `config.ts` integrates detection, `.bollard.yml` `toolchain:` overrides
- CLI `init` command shows detected toolchain with verification layers
- `agent-handler.ts` threads profile through agent creation, verification hooks, project tree
- `implement-feature` blueprint uses `ctx.toolchainProfile` for all verification nodes
- `PipelineContext.toolchainProfile` field
- New error codes: `DETECTION_FAILED`, `PROFILE_INVALID`

### Stage 2 — Agent Infrastructure (DONE):
- `edit_file` agent tool for surgical string replacement (prevents whole-file rewrites)
- Deeper type extraction: `ExtractedTypeDefinition`, `ExtractionResult`, `resolveReferencedTypes`
- `SignatureExtractor` interface with `TsCompilerExtractor` and `LlmFallbackExtractor`
- `write-tests` node: profile-aware test placement (src/ → tests/), markdown fence stripping
- Coder max turns increased to 80 (from 60, originally 40) with explicit turn allocation guidance in prompt
- `deferPostCompletionVerifyFromTurn` in executor (renamed in Stage 3a validation from `skipVerificationAfterTurn`) — post-completion verification hook deferred above 80% turn budget
- `buildTesterMessage` includes referenced type definitions alongside signatures
- `compactOlderTurns` handles `edit_file` payloads

### Stage 2 — Docker Isolation & Multi-Provider (DONE):
- Docker-isolated verification containers: `Dockerfile.verify`, `Dockerfile.verify-python`, `Dockerfile.verify-go`, `Dockerfile.verify-rust`, `Dockerfile.verify-jvm`
- `compose-generator.ts` generates `compose.verify.yml` from `ToolchainProfile`
- `docker-verify` blueprint node (after contract nodes) with graceful Docker-unavailable degradation
- `LlmFallbackExtractor` — LLM-based signature extraction for unknown languages when a provider is supplied
- `getExtractor(lang, provider?, model?)` routes TS/Python/Go/Rust to deterministic extractors; unknown without provider throws `PROVIDER_NOT_FOUND`
- In-language adversarial test generation: conditional `{{#if}}` blocks in `fillPromptTemplate`, boundary-tester prompt outputs Python/Go/Rust test templates
- `deriveAdversarialTestPath` supports Python, Go, Rust naming conventions and `scope: "boundary" | "contract" | "behavioral"`
- Adversarial test lifecycle: `TestLifecycle` type, `resolveTestOutputDir`, `resolveContractTestOutputRel`, `writeTestMetadata`, `checkTestRunnerIntegration`
- `ToolchainProfile.adversarial.boundary.lifecycle` — maps from legacy `toolchain.adversarial.persist` when root `adversarial:` is absent
- `@bollard/mcp` package — MCP server with 12 tools (verify, plan, implement, eval, config, profile, contract, behavioral, probe_run, deploy_record, flag_set, drift_check)
- `OpenAIProvider` — maps `LLMRequest` to OpenAI Chat Completions API with function calling
- `GoogleProvider` — maps `LLMRequest` to Google Generative AI API with function declarations
- `LLMClient` resolves `"openai"` and `"google"` providers via env vars
- `promote-test` CLI command — copy adversarial tests to project test directory
- `bollard init` generates `.bollard.yml` and `.bollard/mcp.json`
- Blueprint now has **28 nodes** (risk gate + contract + behavioral + probe extraction + mutation + semantic review + review grounding before `docker-verify`)

### Stage 3a (DONE) — Contract scope bundle
- `AdversarialConfig` per scope + `concerns.ts` defaults and YAML merge (`CONCERN_CONFIG_INVALID` on bad config)
- `boundary-tester` + `{{#concern}}` templating; `contract-tester` + `buildContractContext` (TypeScript monorepo)
- CLI `contract`, MCP `bollard_contract`, `examples/bollard.yml`
- Dev image includes `python3` for the Python extractor script
- **Stage 3a validation fixes (2026-04-07):** contract context re-export closure (information barrier), `deferPostCompletionVerifyFromTurn` rename, `pnpm.overrides` for `vite >= 7.3.2`, `runBlueprint(..., toolchainProfile?)`, `vitest.contract.config.ts` for `.bollard/` paths, toolchain-gated extractor tests.
- **Stage 3a GREEN (2026-04-08):** Layer 1 contract-tester grounding verifier (`verify-claim-grounding` node 12) + structured claims protocol. Validated end-to-end via `CostTracker.subtract()` self-test (17/17 nodes, 5/5 claims grounded). Post-mortem and principle in [ADR-0001](../spec/adr/0001-deterministic-filters-for-llm-output.md). Commits: `5e5e11f`, `dfced13`, `f9a9a47`, `82da59e`.

### Stage 4a (DONE) — Behavioral scope
- `buildBehavioralContext` (endpoints, config, external deps, failure modes — deterministic, regex-based, 4 languages)
- `behavioral-tester` agent (blackbox, claims JSON protocol, maxTurns 15, temp 0.5)
- Behavioral grounding: `behavioralContextToCorpus()` adapter reuses `parseClaimDocument` + `verifyClaimGrounding`
- Coarse fault injector: extensible `FaultInjector` interface (`inject`/`cleanup` with `FaultSpec`), only `service_stop` implemented
- Behavioral compose generator: `generateBehavioralCompose` (2-service compose)
- 5 behavioral pipeline nodes (extract-behavioral-context, generate-behavioral-tests, verify-behavioral-grounding, write-behavioral-tests, run-behavioral-tests)
- CLI `bollard behavioral` + MCP `bollard_behavioral`
- **Stage 4a GREEN (2026-04-16):** 626 pass / 2 skip; 27-node pipeline. See [spec/stage4a-validation-results.md](../spec/stage4a-validation-results.md).

### Stage 4b (DONE) — Production feedback loop
- `@bollard/observe` package: probe extraction, HTTP probe runner, metrics store, deployment tracker, drift detector, flag manager, progressive rollout, probe scheduler
- Provider-based architecture: every observe component has interface + fully standalone built-in implementation
- Built-in providers: `HttpProbeExecutor` (Node fetch), `FileMetricsStore` (JSONL), `FileFlagProvider` (JSON), `FileDeploymentTracker` (JSON), `GitDriftDetector` (git diff)
- `extract-probes` blueprint node: deterministic filter on behavioral claims (ADR-0001 pattern)
- `ProbeAssertion` extended: `body_contains`, `body_matches`, `header` (+ existing `status`, `latency`, `json_field`)
- 5 new error codes: `PROBE_EXECUTION_FAILED`, `PROBE_ASSERTION_FAILED`, `DRIFT_DETECTED`, `ROLLOUT_BLOCKED`, `FLAG_NOT_FOUND`
- Progressive rollout state machine: risk-tier-driven (low→auto, medium→probe-gated, high/critical→human-gated)
- CLI `probe`/`deploy`/`flag`/`drift` commands; 4 MCP tools (`bollard_probe_run`, `bollard_deploy_record`, `bollard_flag_set`, `bollard_drift_check`)
- Optional `observe:` section in `.bollard.yml` with Zod validation
- **Stage 4b GREEN (2026-04-16):** 665 pass / 2 skip; 28-node pipeline. See [spec/stage4b-validation-results.md](../spec/stage4b-validation-results.md).

### Stage 4c (Part 1) (DONE) — OpenAI / Google streaming parity
- `OpenAIProvider.chatStream` and `GoogleProvider.chatStream` use the native streaming APIs; same `LLMStreamEvent` protocol as Anthropic.
- Anthropic `tool_input_delta` events now carry the correct `toolUseId` (from the preceding `content_block_start`).
- See [spec/stage4c-streaming-parity.md](../spec/stage4c-streaming-parity.md).

### Stage 4c (Part 1) hardening (DONE) — Pipeline quality-of-life
- **Auto-format generated adversarial tests:** `formatGeneratedAdversarialTestFile()` runs `biome check --write --unsafe` after each write node (boundary, contract, behavioral). Non-fatal try/catch.
- **Search tool → ripgrep:** `search.ts` now uses `rg` with `--fixed-strings` by default. `regex: true` auto-falls back to literal string on parse errors (exit code 2). Control characters stripped from patterns. All ripgrep errors return messages instead of throwing — search tool is zero-exception (only path traversal throws).
- **`edit_file` line-range mode:** `start_line` + `end_line` alternative to `old_string` string matching. Coder prompt updated to prefer line-range mode. Eliminates the exact-match search death spiral that wasted 30-70 coder turns per Bollard-on-Bollard run.
- **`rm` in coder allowlist:** Path-guarded (must be inside workDir, no recursive `-r`/`-rf`).
- **Anthropic model ID:** smoke test and pricing updated to `claude-haiku-4-5-20251001`.
- **Bollard-on-bollard self-test:** `CostTracker.summary()` — 28/28 nodes, $0.63, information barrier held, 699 → 705 tests.

### Stage 4c (Part 2) (DONE) — Java/Kotlin Wave 1
- `detectToolchain` JVM detector (Maven/Gradle), `MutationToolId` `"pitest"`, `scripts/extract_java` + Graal `bollard-extract-java`, `JavaParserExtractor`, `JavaContractProvider`, `PitestProvider`, Surefire/Gradle `parseSummary`, `docker/Dockerfile.verify-jvm`, `DEFAULT_IMAGES` Temurin 21 for java/kotlin, behavioral compose JVM start commands.
- **Validation (2026-04-20, Wave 1.1 fix):** 769 pass / 4 skip; adversarial 331 pass. Phase 0–2 GREEN; Phase 3 Bollard-on-bollard reached node 15 `run-contract-tests` (cross-module test now placed in consumer module `api/`, compiles and runs). Wave 1.1 fixes: `resolveContractTestModulePrefix` for cross-module JVM contract-test placement, conditional OWASP audit detection (`hasOwaspMavenPlugin`/`hasOwaspGradlePlugin`). Phase 4 Gradle detection GREEN (live pipeline deferred). See [spec/stage4c-validation-results.md](../spec/stage4c-validation-results.md).

### Stage 4d (DONE) — DX & Agent Integrations:
- `bollard init --ide <platform>` with platform detection and config generation
- Template rendering engine (`renderTemplate`) for profile-driven config files
- Cursor integration: `.cursor/rules/bollard.mdc` (Always-on verification protocol; no `hooks.json` per-edit verify), 4 slash commands, MCP config, automations guide
- Claude Code integration: `.claude/commands/`, `.claude/agents/bollard-verifier.md`, blocking pre-commit verify hook in `.claude/settings.json` (no per-edit verify), CLAUDE.md augmentation, `.mcp.json`
- Secondary platforms: Antigravity (`mcp_config.json`), Codex (`.codex/config.toml`)
- MCP server v2: enriched tool descriptions, 6 resource endpoints, 3 prompt templates
- `bollard watch` — continuous verification with file watching, debounce, quiet mode
- `--quiet` flag on `verify` — JSON output for hooks
- Plugin packaging scaffold for Claude Code

### Stage 4d hardening (DONE):
- MCP `handleVerify` resolves `ToolchainProfile` via `resolveConfig` — no more hardcoded pnpm fallback
- MCP verify returns structured output (`allPassed`, `summary`, `checks[]`, `suggestion`)
- MCP `handleConfig` passes `workDir` correctly (was defaulting to `process.cwd()`)
- MCP `server.ts` uses `findWorkspaceRoot(process.cwd())` for resilient cwd resolution
- `runStaticChecks` error handler captures both stdout and stderr (tsc/biome write errors to stdout)
- Verification protocol rewritten: WHY-first, explicit negative examples (DO NOT run raw commands), BEFORE REPORTING COMPLETION self-check checklist — applied to both Cursor and Claude Code generators
- `.bollard.yml` removed from workspace root markers
- Dockerfile `packages/observe/package.json` COPY fix committed
- `bollard init` cwd resolution fixed (`resolveWorkspaceDirFromArgs` replaces raw `process.cwd()`)
- Cursor command frontmatter descriptions added
- MCP enable warning (yellow) in `bollard init --ide cursor` output

### Stage 5a Phase 1 (DONE) — Run History:
- `RunRecord` / `VerifyRecord` discriminated union with `schemaVersion: 1` for forward compatibility
- `FileRunHistoryStore` — JSONL append-only store with `proper-lockfile` for concurrent safety, write queue for sequential appends
- `RunHistoryStore` interface: `record()`, `query()`, `findByRunId()`, `compare()`
- `RunBlueprintCompleteCallback` on `runBlueprint` — called after pipeline completes, errors caught and logged (non-fatal)
- `buildRunRecord` / `buildVerifyRecord` — assemble history records from `PipelineContext` + `RunResult`
- CLI `history` command: `list` (table with filters), `show <id>` (node-by-node detail), `compare <a> <b>` (delta table), `summary` (aggregates with cost trend), `rebuild` (force SQLite rebuild from JSONL)
- `verify` command automatically records `VerifyRecord` after each run
- `run` command automatically records `RunRecord` via `onRunComplete` callback
- `getHeadSha` helper for git SHA capture
- `RunComparison` computes deltas: cost, duration, test count, mutation score, node status changes, scope changes
- **Dependencies:** `proper-lockfile` added to `@bollard/engine` (~12 KB, zero transitive deps)
- **Test count:** 872 passed / 4 skipped (876 total)

### Stage 5a Phase 2 (DONE) — SQLite Query Layer:
- `createSqliteIndex(dbPath)` closure factory in `run-history-db.ts` — WAL mode, synchronous=NORMAL, idempotent schema
- Schema: `runs` table (unified RunRecord + VerifyRecord via `type` discriminant), `nodes`, `scopes`, `metadata` tables + 5 indexes
- `SqliteIndex` interface: `insert`, `query`, `findByRunId`, `summary`, `rebuild`, `recordCount`, `purge`, `close`
- `RunSummary` type: totalRuns, successRate, avgCostUsd, avgDurationMs, avgTestCount, avgMutationScore?, costTrend, byBlueprint
- `computeCostTrend()` exported from `run-history.ts` — split-half average comparison, 10% threshold
- `FileRunHistoryStore` extended: dynamic `import("./run-history-db.js")` with try/catch fallback to JSONL-only mode; `ensureDbCurrent()` auto-rebuilds when stale
- JSONL remains source of truth — SQLite is a derived cache, gitignored, rebuilt on demand
- CLI `history summary` — aggregate stats with cost trend and per-blueprint breakdown
- CLI `history rebuild` — force SQLite rebuild from JSONL
- `bollard doctor --history` — `HistoryHealth` interface (jsonl/db existence, record counts, last run, cost trend, recent failing nodes, mutation score range)
- **Dependencies:** `better-sqlite3` added to `@bollard/engine` (native addon; `pnpm.onlyBuiltDependencies` in root `package.json`)
- **Test count:** 895 passed / 4 skipped (899 total)

### DO NOT build yet:
- **New languages outside the current seven (TS/JS/Python/Go/Rust/Java/Kotlin)** — C#/.NET, Ruby, PHP, and further waves are sequenced (Stage 4c+ → 5+). Full design in [spec/07-adversarial-scopes.md §12.1](../spec/07-adversarial-scopes.md) and [spec/ROADMAP.md](../spec/ROADMAP.md). Do not add language detectors, extractors, or verify images for any of these languages ad-hoc — each wave is coordinated so the dev image, `dev-full` image, mutation testing pattern, and contract graph all land together. Swift, Scala, Elixir, F#, Clojure, Haskell, OCaml, Nim, and Zig are explicit non-goals with no near-term timeline.
- **JavaScript contract graph** — `buildContractContext` does not yet treat plain JS workspaces like TypeScript. Stage 4c+.
- **External observe providers** — Datadog, Flagsmith, LaunchDarkly, Cloud Run, ArgoCD implementations. Interfaces exist in `@bollard/observe`; implementations are 4b+.
- **Advanced fault injection** — network_delay, resource_limit via `tc`/`iptables`. `FaultInjector` interface is extensible; only `service_stop` is implemented.
- **Library-mode behavioral testing** — agent prompt has `{{#if hasPublicApi}}` ready; implementation deferred.
- **CI-aware verification** — `detectCIEnvironment`, JUnit XML reading, `--ci-passed` flag, `last-verified.json` SHA-match skip logic, optional pre-commit hook — Stage 5a Phase 4. See [spec/stage5a-self-hosting.md §12](spec/stage5a-self-hosting.md).
- **Adversarial test promotion** — automatic candidate detection (bug-catcher + repeated-generation fingerprinting), promotion flow at `approve-pr` gate, `rewriteImportsForPromotion`, `.bollard/promoted.json` — Stage 5a Phase 4. See [spec/stage5a-self-hosting.md §13](spec/stage5a-self-hosting.md).
- **Local LLM provider / token economy work** — llama.cpp `LocalProvider` in `@bollard/llm`, deterministic context expansion, verification-feedback patcher, adversarial test scaffolding, embeddings via `fastembed-js`, per-agent model assignment, cost regression CI — Stage 5d. Do not add Ollama, vLLM, or any other inference runtime ad-hoc; the runtime, model defaults, and lazy-pull volume strategy are coordinated in [spec/stage5d-token-economy.md](../spec/stage5d-token-economy.md). The decision rule for which work goes deterministic vs. local vs. frontier is in [ADR-0004](../spec/adr/0004-determinism-local-frontier-tiers.md).
- MCP history tools (5a Phase 3), Bollard-on-Bollard CI (5a Phase 5), protocol compliance CI (5a Phase 6), self-improvement (5b), agent intelligence (5c) — Stage 5 (see [spec/ROADMAP.md](../spec/ROADMAP.md))

### Size (current):
- Run `cloc` or similar inside Docker if you need exact LOC; structure is 9 packages as listed above.

## Design Principles

1. **Deterministic guardrails, agentic creativity.** Anything that CAN be deterministic MUST be deterministic. LLM calls are reserved for genuinely creative work.
2. **Convention over configuration.** Auto-detect → derive → env var → .bollard.yml. Most projects need zero config.
3. **Minimal dependency stack.** Every dep must justify its existence.
4. **Structured errors everywhere.** `BollardError` with codes, not raw strings.
5. **Context is the single source of truth.** `PipelineContext` holds everything for a run. No parallel state tracking.
6. **The runner doesn't know about agents.** Agent logic lives in `@bollard/agents`. The runner calls callbacks (`AgenticHandler`, `HumanGateHandler`). The CLI wires them together.
7. **Tools are sandboxed.** All file tools enforce path-traversal checks. `run_command` uses a whitelist. No shell expansion.
8. **The engine doesn't know about languages.** (from 06-toolchain-profiles) Language-specific logic lives in `ToolchainProfile`. The runner, agents, and blueprints consume the profile.
9. **Independence requires isolation.** (from 06-toolchain-profiles) Adversarial tests in the same process as the code they test share failure modes. Docker is the isolation boundary.
10. **Detection is deterministic.** (from 06-toolchain-profiles) No network calls, no LLM calls. File exists → tool detected.
11. **One agent, one adversarial concern.** (from 07-adversarial-scopes) Each scope gets its own agent. Overloading one prompt with multiple scopes guarantees drift.
12. **Bollard guarantees coverage, not the developer.** (from 07-adversarial-scopes) Missing test infrastructure → Bollard provides its own.
13. **Scope is about the defect class, not the technology.** (from 07-adversarial-scopes) "Boundary" ≠ "unit test." "Behavioral" ≠ "e2e test."
14. **Concerns are lenses, not scopes.** (from 07-adversarial-scopes) Security, performance, resilience don't change what the agent sees — they change what it looks for, with per-scope weights.
15. **Protocols need structure, not emphasis.** (from [ADR-0003](../spec/adr/0003-agent-protocol-compliance.md)) "you MUST" is advisory to LLMs. Any protocol that must be followed needs WHY (motivation), DO NOT (concrete negative examples), and SELF-CHECK (pre-completion checklist). Applies to rules files, MCP tool descriptions, and agent system prompts.
16. **Determinism first, local second, frontier last.** (from [ADR-0004](../spec/adr/0004-determinism-local-frontier-tiers.md)) Any work that can be deterministic must be deterministic. Any LLM work that doesn't need frontier-quality output runs locally (llama.cpp + 1–3B model). Frontier API calls are reserved for genuinely creative, multi-turn work — coder implementation, novel adversarial property bodies. Mechanical patch-apply, context expansion, boilerplate scaffolding, and small classifications never go to a frontier model. Stage 5d ([stage5d-token-economy.md](../spec/stage5d-token-economy.md)) operationalizes this rule.
17. **The token budget is a load-bearing constraint, not a footnote.** Every new node, every prompt change, every additional agent turn has a measurable cost in `CostTracker`. Treat the budget the same way the spec treats the test suite: regressions get caught by CI (Stage 5d Phase 6), not after a quarterly review. New blueprint nodes that call an LLM must justify why the work cannot be done deterministically or locally.

## Git Conventions

- Commit messages: `Stage N: <what changed>` (e.g., "Stage 1: implement planner agent with read-only tools")
- One logical change per commit. Don't mix engine types with CLI config.
- Branch from `main`. PR back to `main`.

## Reference Architecture Docs

If you need deeper context, refer to these (they are the source of truth) in the spec/ folder:

- `01-architecture.md` — Full architecture, type definitions, pipeline layers
- `02-bootstrap.md` — Historical bootstrap roadmap (Stages 0 → 2). Not a living plan — see 07 for forward roadmap.
- `03-providers.md` — Cloud provider abstraction (not needed until Stage 4c+)
- `04-configuration.md` — Config philosophy, auto-detection, .bollard.yml spec
- `05-risk-model.md` — Risk scoring dimensions and gating behavior
- `06-toolchain-profiles.md` — Language-agnostic verification: three-layer model, toolchain detection, Docker isolation, adversarial test lifecycle
- `07-adversarial-scopes.md` — **Multi-scope adversarial verification: boundary/contract/behavioral scopes × correctness/security/performance/resilience concerns. Forward roadmap (Stages 3 → 4 → 5). Source of truth for adversarial testing design.**
- `archive/` — Historical prompts used to drive Cursor during each build stage. Not current guidance.
