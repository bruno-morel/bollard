# CLAUDE.md — Bollard

> This file guides AI coding agents (Claude Code, Cursor, Copilot) working on the Bollard codebase. Read it before writing any code.

## What Bollard Is

Bollard is an **artifact integrity framework** for AI-assisted software development. It ensures every artifact (code, tests, docs, infra) is produced, adversarially verified, and mechanically proven sound before shipping. The core innovation: separate the producer from the verifier, then prove the verification itself is meaningful (via mutation testing).

Bollard has completed **Stage 2** (adversarial verification infrastructure) and **Stage 3a** (contract-scope adversarial testing — first slice of Stage 3). The kernel (Stage 0) executes blueprints — sequences of deterministic and agentic nodes. Stage 1 added multi-turn agents (planner, coder, boundary tester), filesystem tools, static verification, the `implement-feature` blueprint, eval sets, and adversarial test generation. Stage 1.5 added language-agnostic toolchain detection (`@bollard/detect`, `ToolchainProfile`), templatized agent prompts, and profile-driven verification. Stage 2 (first half) fixed critical agent infrastructure issues: `edit_file` tool for surgical edits, deeper type extraction with reference resolution, correct test placement, markdown fence stripping, and coder turn budget management. Stage 2 (second half) added Docker-isolated verification containers, LLM fallback signature extraction for edge languages, in-language adversarial test generation, adversarial test lifecycle (ephemeral + persistent-native), MCP server (`@bollard/mcp`), and OpenAI + Google LLM providers. **Stage 3a** adds per-scope `AdversarialConfig` with concern weights, `boundary-tester` + `contract-tester` agents, deterministic extractors for Python/Go/Rust, TypeScript contract graph (`buildContractContext`), four contract blueprint nodes, and `bollard contract` / MCP `bollard_contract`.

The forward roadmap (see [07-adversarial-scopes.md](../spec/07-adversarial-scopes.md)):
- **Stage 3 (remaining):** Mutation testing + semantic review; contract graph beyond TypeScript
- **Stage 4:** Behavioral-scope adversarial testing + production feedback loop
- **Stage 5:** Self-hosting + self-improvement

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
```

### Known limitations (post Stage 3a)

- Docker-isolated verification requires Docker-in-Docker (`docker.sock` mount) — degrades gracefully when unavailable.
- Behavioral-scope adversarial testing and extractor — Stage 4.
- Contract graph (`buildContractContext`) is **TypeScript / pnpm-workspace monorepos** in Stage 3a; other languages return an empty graph with a warning.
- Per-language mutation testing not yet implemented — Stage 3 remainder.
- Test output parsing is Vitest-specific (`parseSummary`) — non-Vitest runners work via profile-driven execution but parsed summary falls back to zero/error detection. Stage 3 adds deterministic parsers for pytest, go test, cargo test.
- Unknown languages still need an LLM provider for signature extraction (`getExtractor` throws `PROVIDER_NOT_FOUND` without one).
- No behavioral extractor (topology, endpoints, failure modes) — Stage 4.
- No rollback on coder max-turns failure — partially-written files remain on disk.
- No semantic review agent — Stage 3.
- No production feedback loop (probes, drift detection) — Stage 4.

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
- **Mutation testing:** Per-language (Stryker for JS/TS, mutmut for Python, cargo-mutants for Rust, etc.) — Stage 3, not yet.
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

## Project Structure (Stage 3a)

```
bollard/
├── Dockerfile                    # Node 22 + pnpm dev image
├── compose.yaml                  # Docker Compose for all dev commands
├── docker/
│   ├── Dockerfile.verify         # Black-box adversarial test container (Node 22 + vitest)
│   ├── Dockerfile.verify-python  # Node + Python 3 runtime
│   ├── Dockerfile.verify-go      # Node + Go 1.22
│   └── Dockerfile.verify-rust    # Node + Rust toolchain
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
│   │   │       ├── go.ts         # Detect go.mod, golangci-lint, go vet/test
│   │   │       ├── rust.ts       # Detect Cargo.toml, clippy, cargo test/audit
│   │   │       ├── javascript.ts # Detect package.json w/o tsconfig, ESLint/Biome, Jest/Vitest/Mocha
│   │   │       └── fallback.ts   # Returns null; buildManualProfile for interactive init
│   │   └── tests/
│   │       ├── detect.test.ts    # 26 tests — all detectors + orchestrator
│   │       └── fixtures/         # ts-project/, js-project/, py-project/, go-project/, rust-project/, empty-project/
│   │
│   ├── engine/                   ← THE KERNEL (Stage 0)
│   │   ├── src/
│   │   │   ├── types.ts          # Barrel re-exports for all engine types
│   │   │   ├── blueprint.ts      # Blueprint, BlueprintNode, NodeResult, NodeResultError
│   │   │   ├── errors.ts         # BollardError class + BollardErrorCode union
│   │   │   ├── context.ts        # PipelineContext (includes toolchainProfile?), createContext, BollardConfig
│   │   │   ├── runner.ts         # runBlueprint, AgenticHandler, HumanGateHandler, ProgressCallback
│   │   │   ├── cost-tracker.ts   # CostTracker class
│   │   │   └── eval-runner.ts    # runEvals — eval case runner for agent prompts
│   │   └── tests/
│   │       ├── runner.test.ts
│   │       ├── errors.test.ts
│   │       ├── context.test.ts
│   │       ├── cost-tracker.test.ts
│   │       └── eval-runner.test.ts
│   │
│   ├── llm/                      ← LLM ABSTRACTION (Stage 0 + Stage 2)
│   │   ├── src/
│   │   │   ├── types.ts          # LLMProvider, LLMRequest, LLMResponse, LLMMessage, etc.
│   │   │   ├── client.ts         # LLMClient — resolves provider per-agent from config
│   │   │   ├── providers/
│   │   │   │   ├── anthropic.ts  # AnthropicProvider (~80 LOC)
│   │   │   │   ├── openai.ts     # OpenAIProvider — maps to Chat Completions API
│   │   │   │   └── google.ts     # GoogleProvider — maps to Generative AI API
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
│   │   │   ├── eval-loader.ts    # loadEvalCases, availableAgents
│   │   │   ├── tools/
│   │   │   │   ├── index.ts      # ALL_TOOLS, READ_ONLY_TOOLS
│   │   │   │   ├── read-file.ts  # Read file contents (path-traversal protected)
│   │   │   │   ├── write-file.ts # Write file, create dirs (path-traversal protected)
│   │   │   │   ├── edit-file.ts  # Surgical string replacement in files (Stage 2)
│   │   │   │   ├── list-dir.ts   # List directory with type indicators
│   │   │   │   ├── search.ts     # Grep-based search with glob filtering
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
│   │   │   └── contract-tester.md
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
│   │   │   ├── contract-extractor.ts # buildContractContext (TS workspace graph)
│   │   │   ├── extractors/       # python.ts, go.ts, rust.ts — deterministic SignatureExtractor
│   │   │   ├── compose-generator.ts  # generateVerifyCompose — dynamic compose.verify.yml from ToolchainProfile
│   │   │   └── test-lifecycle.ts # resolveTestOutputDir, resolveContractTestOutputRel, writeTestMetadata, …
│   │   └── tests/
│   │       ├── static.test.ts    # 4 tests — structure + live integration
│   │       ├── dynamic.test.ts   # 2 tests — integration test
│   │       ├── type-extractor.test.ts  # signatures, types, extractors
│   │       ├── contract-extractor.test.ts
│   │       ├── compose-generator.test.ts  # 6 tests — YAML generation per language/mode
│   │       └── test-lifecycle.test.ts  # lifecycle resolution, output dirs, metadata
│   │
│   ├── blueprints/               ← BLUEPRINT DEFINITIONS (Stage 1 + 1.5 + 2)
│   │   ├── src/
│   │   │   ├── implement-feature.ts  # 16-node pipeline: boundary + contract + docker-verify
│   │   │   └── write-tests-helpers.ts  # deriveAdversarialTestPath (scope: boundary | contract), stripMarkdownFences
│   │   └── tests/
│   │       ├── implement-feature.test.ts  # node order, types, structure
│   │       └── write-tests-helpers.test.ts  # test path derivation, fence stripping
│   │
│   ├── cli/                      ← CLI (Stage 0 + Stage 1 + Stage 1.5 + Stage 2)
│   │   ├── src/
│   │   │   ├── index.ts          # Entry: parse args, route commands, progress output
│   │   │   ├── config.ts         # detectToolchain + .bollard.yml overrides + ToolchainProfile
│   │   │   ├── adversarial-yaml.ts
│   │   │   ├── contract-plan.ts # collectAffectedPathsFromPlan
│   │   │   ├── agent-handler.ts  # Multi-turn agentic handler (threads profile to agents)
│   │   │   ├── diff.ts           # diffToolchainProfile — compare profile vs Stage 1 defaults
│   │   │   └── human-gate.ts     # Interactive human approval via stdin
│   │   └── tests/
│   │       ├── config.test.ts    # 10 tests — defaults, detection, YAML, profile
│   │       ├── profile-flag.test.ts  # 2 tests — verify --profile flag
│   │       ├── diff.test.ts      # 6 tests — diff helper
│   │       └── config.adversarial.test.ts
│   │
│   └── mcp/                      ← MCP SERVER (Stage 2)
│       ├── src/
│       │   ├── server.ts         # MCP server entry point (stdio transport)
│       │   └── tools.ts          # 7 MCP tools: verify, plan, implement, eval, config, profile, contract
│       └── tests/
│           └── tools.test.ts     # tool definitions, schemas, handlers
```

## Current Test Stats

- **Run `docker compose run --rm dev run test` for authoritative counts** (Stage 3a added contract/boundary tests and contract extractor coverage).
- **Adversarial suite:** `vitest.adversarial.config.ts` — `packages/*/tests/**/*.adversarial.test.ts`
- **Source:** ~8 packages; prompts include `planner.md`, `coder.md`, `boundary-tester.md`, `contract-tester.md`
- **Latest count (authoritative):** `402` passed, `2` skipped — includes executor progress telemetry tests and CLI `AgentSpinner` tests.

### Stage 3a follow-ups (agent UX)

Long LLM waits no longer look frozen: `executeAgent` emits optional `AgentProgressEvent`s (`turn_start` / `turn_end` / `tool_call_start` / `tool_call_end`) via `AgentContext.progress`. The CLI wires them to `createAgentSpinner()` — TTY sessions get an in-place braille spinner with elapsed time and per-tool hints; non-TTY (CI, pipes) gets one line per milestone with no ANSI escapes. See `packages/cli/src/spinner.ts` and `packages/agents/tests/executor.progress.test.ts`.

### Stage 3a validation (maintainers)

```bash
docker compose build dev
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
docker compose run --rm dev --filter @bollard/cli run start -- verify --profile
docker compose run --rm dev --filter @bollard/cli run start -- contract
```

## Stage 2 Validation (2026-04-02)

- **Test suite:** 344/344 pass, typecheck clean, lint clean
- **Milestone (TS):** Pipeline ran nodes 1–5 (create-branch → generate-plan → approve-plan → implement → static-checks). Coder correctly used `edit_file` for existing files. Failed at static-checks (Biome lint formatting) due to `skipVerificationAfterTurn` skipping lint after turn 48/60.
- **Milestone (Python):** `--work-dir` flag validated. `detectToolchain` correctly identified Python/pytest/ruff. Planner produced Python-specific plan. Coder exhausted 60 turns because `python`/`pytest` were not in `allowedCommands` — **fixed in post-validation cleanup** (test.cmd and pip-audit now whitelisted).
- **Retro-adversarial:** Tester generated tests for 5 packages ($0.34 total). Information barrier held (no private identifiers leaked). All outputs include property-based tests. Key issue: tester constructs invalid ToolchainProfile stubs (uses wrong field names). See `.bollard/retro-adversarial/SUMMARY.md`.
- **Bug fixed:** `eval-runner.ts` regex validation — invalid regex in `matches_regex` assertion now returns `passed: false` instead of crashing.
- **Post-validation cleanup (2026-04-02):** Fixed Python `allowedCommands` gap, added `LlmFallbackExtractor` warn logging, renamed `integrateWithTestRunner` → `checkTestRunnerIntegration` with corrected return semantics, hardened `promote-test` CLI command, aligned MCP `tsconfig.json`, archived 12 historical spec prompts.

## Key Types (Source of Truth)

### BollardErrorCode + BollardError (packages/engine/src/errors.ts)

- `BollardErrorCode` is a string union of all error codes (LLM_TIMEOUT, LLM_RATE_LIMIT, LLM_AUTH, LLM_PROVIDER_ERROR, LLM_INVALID_RESPONSE, COST_LIMIT_EXCEEDED, TIME_LIMIT_EXCEEDED, NODE_EXECUTION_FAILED, POSTCONDITION_FAILED, STATIC_CHECK_FAILED, TEST_FAILED, MUTATION_THRESHOLD_NOT_MET, CONTRACT_VIOLATION, HUMAN_REJECTED, RISK_GATE_BLOCKED, CONFIG_INVALID, DETECTION_FAILED, PROFILE_INVALID, PROVIDER_NOT_FOUND, MODEL_NOT_AVAILABLE, CONCERN_CONFIG_INVALID).
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
- Fields: `runId, task, blueprintId, config, currentNode, results, changedFiles, gitBranch?, plan?: unknown, mutationScore?, generatedProbes?, deploymentManifest?, toolchainProfile?: ToolchainProfile, costTracker, log, upgradeRunId(taskSlug)`.
- `plan` is typed as `unknown` — the planner agent stores parsed JSON here, the coder agent reads it.
- `toolchainProfile` is set by the CLI from auto-detection; used by blueprint nodes for profile-driven verification.

### Runner (packages/engine/src/runner.ts)

`runBlueprint(blueprint, task, config, agenticHandler?, humanGateHandler?, onProgress?) → Promise<RunResult>`

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
1. Send messages to LLM with tools
2. If `stopReason === "tool_use"`, execute each tool, collect results
3. Append assistant message + tool results, loop back to step 1
4. If `stopReason !== "tool_use"`, extract text response and return
5. Throws `NODE_EXECUTION_FAILED` if `maxTurns` exceeded

### Agent tools (packages/agents/src/tools/)

| Tool | Name | Access | Description |
|------|------|--------|-------------|
| read-file | `read_file` | Planner + Coder | Read file contents, path-traversal protected |
| write-file | `write_file` | Coder only | Write/overwrite files, creates parent dirs |
| edit-file | `edit_file` | Coder only | Surgical string replacement (unique match required), path-traversal protected |
| list-dir | `list_dir` | Planner + Coder | List directory contents with type indicators |
| search | `search` | Planner + Coder | Grep-based regex search with glob filter |
| run-command | `run_command` | Coder only | Execute whitelisted commands (pnpm, node, tsc, biome, git, etc.) |

All tools enforce path-traversal protection: resolved path must start with `workDir`.

### Agents

- **Planner** (`createPlannerAgent(profile?)`): read-only tools, temperature 0.2, max 25 turns. Produces structured JSON plan with summary, acceptance criteria, affected files, risk assessment, steps.
- **Coder** (`createCoderAgent(profile?)`): all 6 tools, temperature 0.3, max 60 turns. Implements plans, writes tests. Prefers `edit_file` for existing files, `write_file` for new files. Verification hook skipped after 80% of turns to prevent budget exhaustion.
- **Boundary tester** (`createBoundaryTesterAgent(profile?)`): no tools, temperature 0.3, max 5 turns. Generates boundary-scope adversarial tests from type signatures and referenced type definitions; prompt includes four concern lenses when weights are not `off`.
- **Contract tester** (`createContractTesterAgent(profile?)`): no tools, temperature 0.4, max 10 turns. Generates contract-scope tests from `ContractContext` (module graph + edges); language/framework via profile.

All agent creation functions accept an optional `ToolchainProfile` — when provided, prompt `{{placeholders}}` and `{{#if}}` conditionals are filled with detected language/tool values.

### Static verification (packages/verify/src/static.ts)

`runStaticChecks(workDir, profile?) → { results: StaticCheckResult[]; allPassed: boolean }`

When `profile` is provided, runs checks from `profile.checks` (typecheck, lint, audit, secretScan). When omitted, falls back to hardcoded TypeScript defaults (`pnpm run typecheck`, `pnpm run lint`, `pnpm audit`, `gitleaks detect`).

### Dynamic test runner (packages/verify/src/dynamic.ts)

`runTests(workDir, testFiles?, profile?) → TestRunResult`

When `profile?.checks.test` is provided, uses its `cmd`/`args`. When omitted, falls back to `pnpm exec vitest run`.

### implement-feature blueprint (packages/blueprints/src/implement-feature.ts)

16-node pipeline:

1. **create-branch** (deterministic) — `git checkout -b bollard/{runId}`
2. **generate-plan** (agentic/planner) — planner agent explores codebase, produces JSON plan
3. **approve-plan** (human_gate) — shows plan, waits for human approval
4. **implement** (agentic/coder) — coder agent implements plan with full toolset
5. **static-checks** (deterministic) — profile-driven typecheck + lint + audit + secretScan
6. **extract-signatures** (deterministic) — extract signatures + types (TS + deterministic Python/Go/Rust extractors; LLM fallback only for unknown languages when a provider is configured)
7. **generate-tests** (agentic/boundary-tester) — boundary-scope adversarial tests
8. **write-tests** (deterministic) — strip fences, `deriveAdversarialTestPath(..., "boundary")`, leak scan
9. **run-tests** (deterministic) — profile-driven test execution
10. **extract-contracts** (deterministic) — `buildContractContext` (skipped when `!profile.adversarial.contract.enabled`)
11. **generate-contract-tests** (agentic/contract-tester) — skipped in agent-handler when contract disabled
12. **write-contract-tests** (deterministic) — fences, `resolveContractTestOutputRel` + contract path basename, TS leak scan
13. **run-contract-tests** (deterministic) — `runTests` with only the new contract test file path
14. **docker-verify** (deterministic) — Docker-isolated adversarial test execution (gracefully degrades without Docker)
15. **generate-diff** (deterministic) — `git diff --stat main`
16. **approve-pr** (human_gate) — shows diff summary, waits for human approval

### CLI commands

| Command | Description |
|---------|-------------|
| `run demo --task "..."` | Stage 0 demo blueprint (1 deterministic + 1 agentic node) |
| `run implement-feature --task "..." [--work-dir <path>]` | Full Stage 1 pipeline with human gates (optional work dir override) |
| `plan --task "..." [--work-dir <path>]` | Standalone planner agent (no implementation) |
| `verify [--profile] [--work-dir <path>]` | Run static checks (or show detected profile as JSON) |
| `contract [--plan <file>] [--work-dir <path>]` | Print `ContractContext` JSON (optional planner JSON for affected paths) |
| `diff` | Compare detected profile vs hardcoded Stage 1 defaults |
| `eval [agent]` | Run eval sets (planner, coder, boundary-tester, contract-tester; `tester` aliases boundary) |
| `config show [--sources]` | Show resolved configuration |
| `init [--mode=...] [--persist]` | Detect project configuration, generate .bollard.yml |
| `promote-test <path>` | Promote adversarial test to project test directory |

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
- Coder max turns increased to 60 (from 40) with turn budget guidance in prompt
- `skipVerificationAfterTurn` in executor — verification hook skipped above 80% turn budget
- `buildTesterMessage` includes referenced type definitions alongside signatures
- `compactOlderTurns` handles `edit_file` payloads

### Stage 2 — Docker Isolation & Multi-Provider (DONE):
- Docker-isolated verification containers: `Dockerfile.verify`, `Dockerfile.verify-python`, `Dockerfile.verify-go`, `Dockerfile.verify-rust`
- `compose-generator.ts` generates `compose.verify.yml` from `ToolchainProfile`
- `docker-verify` blueprint node (after contract nodes) with graceful Docker-unavailable degradation
- `LlmFallbackExtractor` — LLM-based signature extraction for unknown languages when a provider is supplied
- `getExtractor(lang, provider?, model?)` routes TS/Python/Go/Rust to deterministic extractors; unknown without provider throws `PROVIDER_NOT_FOUND`
- In-language adversarial test generation: conditional `{{#if}}` blocks in `fillPromptTemplate`, boundary-tester prompt outputs Python/Go/Rust test templates
- `deriveAdversarialTestPath` supports Python, Go, Rust naming conventions and `scope: "boundary" | "contract"`
- Adversarial test lifecycle: `TestLifecycle` type, `resolveTestOutputDir`, `resolveContractTestOutputRel`, `writeTestMetadata`, `checkTestRunnerIntegration`
- `ToolchainProfile.adversarial.boundary.lifecycle` — maps from legacy `toolchain.adversarial.persist` when root `adversarial:` is absent
- `@bollard/mcp` package — MCP server with 7 tools (verify, plan, implement, eval, config, profile, contract)
- `OpenAIProvider` — maps `LLMRequest` to OpenAI Chat Completions API with function calling
- `GoogleProvider` — maps `LLMRequest` to Google Generative AI API with function declarations
- `LLMClient` resolves `"openai"` and `"google"` providers via env vars
- `promote-test` CLI command — copy adversarial tests to project test directory
- `bollard init` generates `.bollard.yml` and `.bollard/mcp.json`
- Blueprint now has **16 nodes** (contract nodes between `run-tests` and `docker-verify`)

### Stage 3a (DONE) — Contract scope bundle
- `AdversarialConfig` per scope + `concerns.ts` defaults and YAML merge (`CONCERN_CONFIG_INVALID` on bad config)
- `boundary-tester` + `{{#concern}}` templating; `contract-tester` + `buildContractContext` (TypeScript monorepo)
- CLI `contract`, MCP `bollard_contract`, `examples/bollard.yml`
- Dev image includes `python3` for the Python extractor script

### DO NOT build yet:
- **Streaming LLM responses (Stage 3c / 4 follow-up)** — `LLMProvider.chat_stream`, incremental delta events from `executeAgent`, CLI rendering of model output as it arrives (Option B in `spec/stage3a-progress-ux-prompt.md` §1). Deferred because it requires provider-specific streaming implementations (Anthropic, OpenAI, Google) and partial-response error handling; Option A (spinner + turn/tool telemetry without streaming) covers basic “feels alive” UX.
- Per-language mutation testing (Stryker, mutmut, cargo-mutants, etc.) — Stage 3 remainder
- Semantic review agent — Stage 3 remainder
- Contract graph for Python/Go/Rust workspaces — Stage 3b+
- Behavioral-scope adversarial tester (behavioral-tester.ts, behavioral extractor) — Stage 4
- Behavioral context builder (topology, endpoints, config schema, failure modes) — Stage 4
- Fault injector (Docker-level network delays, connection drops, resource limits) — Stage 4
- Production probes, drift detection, flag manager — Stage 4
- Git rollback on coder max-turns failure — Stage 4
- Verification summary batching (single feedback message instead of per-check retries) — Stage 4
- CI integration, run history, self-improvement — Stage 5

### Size (current):
- Run `cloc` or similar inside Docker if you need exact LOC; structure is 8 packages as listed above.

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

## Git Conventions

- Commit messages: `Stage N: <what changed>` (e.g., "Stage 1: implement planner agent with read-only tools")
- One logical change per commit. Don't mix engine types with CLI config.
- Branch from `main`. PR back to `main`.

## Reference Architecture Docs

If you need deeper context, refer to these (they are the source of truth) in the spec/ folder:

- `01-architecture.md` — Full architecture, type definitions, pipeline layers
- `02-bootstrap.md` — Historical bootstrap roadmap (Stages 0 → 2). Not a living plan — see 07 for forward roadmap.
- `03-providers.md` — Cloud provider abstraction (not needed until Stage 4)
- `04-configuration.md` — Config philosophy, auto-detection, .bollard.yml spec
- `05-risk-model.md` — Risk scoring dimensions and gating behavior
- `06-toolchain-profiles.md` — Language-agnostic verification: three-layer model, toolchain detection, Docker isolation, adversarial test lifecycle
- `07-adversarial-scopes.md` — **Multi-scope adversarial verification: boundary/contract/behavioral scopes × correctness/security/performance/resilience concerns. Forward roadmap (Stages 3 → 4 → 5). Source of truth for adversarial testing design.**
- `archive/` — Historical prompts used to drive Cursor during each build stage. Not current guidance.
