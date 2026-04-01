# CLAUDE.md — Bollard

> This file guides AI coding agents (Claude Code, Cursor, Copilot) working on the Bollard codebase. Read it before writing any code.

## What Bollard Is

Bollard is an **artifact integrity framework** for AI-assisted software development. It ensures every artifact (code, tests, docs, infra) is produced, adversarially verified, and mechanically proven sound before shipping. The core innovation: separate the producer from the verifier, then prove the verification itself is meaningful (via mutation testing).

Bollard is currently at **Stage 2** (adversarial verification infrastructure). The kernel (Stage 0) executes blueprints — sequences of deterministic and agentic nodes. Stage 1 added multi-turn agents (planner, coder, tester), filesystem tools, static verification, the `implement-feature` blueprint, eval sets, and adversarial test generation. Stage 1.5 added language-agnostic toolchain detection (`@bollard/detect`, `ToolchainProfile`), templatized agent prompts, and profile-driven verification. Stage 2 fixes critical agent infrastructure issues discovered during bollard-on-bollard pipeline runs: `edit_file` tool for surgical edits, deeper type extraction with reference resolution, correct test placement, markdown fence stripping, and coder turn budget management. The second half of Stage 2 (Docker-isolated verification containers) is a separate effort. Stage 3 adds per-language mutation testing, semantic review, and the production feedback loop.

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
```

### Known limitations at Stage 2

- No Docker isolation — tools run in the host container with path-traversal guards only. Docker-isolated verification containers are the second half of Stage 2.
- Non-TypeScript adversarial tests use blackbox mode only (no in-language mutation yet).
- Test output parsing is Vitest-specific (`parseSummary`) — future work will add parsers for pytest, go test, cargo test.
- Signature extraction only works for TypeScript — `LlmFallbackExtractor` stub exists but is not yet implemented.
- No MCP server yet.
- No OpenAI/Google providers — Anthropic only.
- No rollback on coder max-turns failure — partially-written files remain on disk.

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

## Project Structure (Stage 2)

```
bollard/
├── Dockerfile                    # Node 22 + pnpm dev image
├── compose.yaml                  # Docker Compose for all dev commands
├── .env                          # ANTHROPIC_API_KEY (gitignored)
├── package.json                  # root workspace
├── pnpm-workspace.yaml           # packages: ["packages/*"]
├── tsconfig.json                 # shared strict config (all packages extend this)
├── biome.json                    # shared lint/format config
│
├── packages/
│   ├── detect/                   ← TOOLCHAIN DETECTION (Stage 1.5)
│   │   ├── src/
│   │   │   ├── types.ts          # ToolchainProfile, VerificationCommand, LanguageId, etc.
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
│   ├── llm/                      ← LLM ABSTRACTION (Stage 0)
│   │   ├── src/
│   │   │   ├── types.ts          # LLMProvider, LLMRequest, LLMResponse, LLMMessage, etc.
│   │   │   ├── client.ts         # LLMClient — resolves provider per-agent from config
│   │   │   ├── providers/
│   │   │   │   └── anthropic.ts  # AnthropicProvider (~80 LOC)
│   │   │   └── mock.ts           # MockProvider — deterministic mock for testing
│   │   └── tests/
│   │       └── client.test.ts    # Includes live Anthropic smoke test (skips if no key/credits)
│   │
│   ├── agents/                   ← AGENT INFRASTRUCTURE (Stage 1 + 1.5)
│   │   ├── src/
│   │   │   ├── types.ts          # AgentTool, AgentContext, AgentDefinition, AgentResult
│   │   │   ├── executor.ts       # executeAgent — multi-turn tool-use loop
│   │   │   ├── prompt-template.ts # fillPromptTemplate — {{variable}} replacement from ToolchainProfile
│   │   │   ├── planner.ts        # createPlannerAgent(profile?) — read-only tools, structured JSON output
│   │   │   ├── coder.ts          # createCoderAgent(profile?) — all tools, implements plans
│   │   │   ├── tester.ts         # createTesterAgent(profile?) — adversarial test generation
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
│   │   │       └── coder/cases.ts    # 2 eval cases for coder output quality
│   │   ├── prompts/
│   │   │   ├── planner.md        # System prompt with {{language}}, {{packageManager}}, etc. placeholders
│   │   │   ├── coder.md          # System prompt with {{testFramework}}, {{typecheck}}, {{linter}} placeholders
│   │   │   └── tester.md         # System prompt with {{testFramework}} placeholder
│   │   └── tests/
│   │       ├── executor.test.ts  # 19 tests — multi-turn, max turns, errors, cost, verification
│   │       ├── tools.test.ts     # 17 tests — all 6 tools + path traversal guards
│   │       ├── prompt-template.test.ts  # 9 tests — placeholder replacement, TS/Python profiles
│   │       ├── planner.test.ts   # 5 tests — prompt loading, read-only tools, JSON schema
│   │       ├── coder.test.ts     # 5 tests — prompt loading, full toolset, turns, maxTurns
│   │       └── tester.test.ts    # 5 tests — prompt loading, test generation
│   │
│   ├── verify/                   ← VERIFICATION (Stage 1 + 1.5)
│   │   ├── src/
│   │   │   ├── static.ts         # runStaticChecks(workDir, profile?) — profile-driven or hardcoded fallback
│   │   │   ├── dynamic.ts        # runTests(workDir, testFiles?, profile?) — profile-driven test execution
│   │   │   └── type-extractor.ts # extractSignaturesFromFiles, extractTypeDefinitions, resolveReferencedTypes, SignatureExtractor
│   │   └── tests/
│   │       ├── static.test.ts    # 4 tests — structure + live integration
│   │       ├── dynamic.test.ts   # 2 tests — integration test
│   │       └── type-extractor.test.ts  # 23 tests — signatures, type definitions, reference resolution, extractors
│   │
│   ├── blueprints/               ← BLUEPRINT DEFINITIONS (Stage 1 + 1.5 + 2)
│   │   ├── src/
│   │   │   ├── implement-feature.ts  # 11-node pipeline with profile-driven checks
│   │   │   └── write-tests-helpers.ts  # deriveAdversarialTestPath, stripMarkdownFences (Stage 2)
│   │   └── tests/
│   │       ├── implement-feature.test.ts  # 11 tests — node order, types, structure
│   │       └── write-tests-helpers.test.ts  # 11 tests — test path derivation, fence stripping
│   │
│   └── cli/                      ← CLI (Stage 0 + Stage 1 + Stage 1.5)
│       ├── src/
│       │   ├── index.ts          # Entry: parse args, route commands, progress output
│       │   ├── config.ts         # detectToolchain + .bollard.yml overrides + ToolchainProfile
│       │   ├── agent-handler.ts  # Multi-turn agentic handler (threads profile to agents)
│       │   ├── diff.ts           # diffToolchainProfile — compare profile vs Stage 1 defaults
│       │   └── human-gate.ts     # Interactive human approval via stdin
│       └── tests/
│           ├── config.test.ts    # 10 tests — defaults, detection, YAML, profile
│           ├── profile-flag.test.ts  # 2 tests — verify --profile flag
│           ├── diff.test.ts      # 6 tests — diff helper (unchanged/differ/new/removed scenarios)
│           └── config.adversarial.test.ts  # Adversarial config tests
```

## Current Test Stats

- **24 test files, 269 tests passing** (0 skipped, 0 failing)
- **30 adversarial test files** (separate Vitest config: `vitest.adversarial.config.ts`)
- **Source:** ~5200 LOC across 7 packages
- **Tests:** ~3690 LOC (+ ~7670 LOC adversarial tests)
- **Prompts:** ~238 LOC (planner.md + coder.md + tester.md)

## Key Types (Source of Truth)

### BollardErrorCode + BollardError (packages/engine/src/errors.ts)

- `BollardErrorCode` is a string union of all error codes (LLM_TIMEOUT, LLM_RATE_LIMIT, LLM_AUTH, LLM_PROVIDER_ERROR, LLM_INVALID_RESPONSE, COST_LIMIT_EXCEEDED, TIME_LIMIT_EXCEEDED, NODE_EXECUTION_FAILED, POSTCONDITION_FAILED, STATIC_CHECK_FAILED, TEST_FAILED, MUTATION_THRESHOLD_NOT_MET, CONTRACT_VIOLATION, HUMAN_REJECTED, RISK_GATE_BLOCKED, CONFIG_INVALID, DETECTION_FAILED, PROFILE_INVALID, PROVIDER_NOT_FOUND, MODEL_NOT_AVAILABLE).
- `BollardError extends Error` with `code`, `context`, `retryable` (getter — true for LLM_TIMEOUT, LLM_RATE_LIMIT, LLM_PROVIDER_ERROR).
- Static methods: `BollardError.is(err)` type guard, `BollardError.hasCode(err, code)`.

### ToolchainProfile + VerificationCommand + LanguageId (packages/detect/src/types.ts)

- `LanguageId` is a string union: `"typescript" | "javascript" | "python" | "go" | "rust" | "java" | "kotlin" | "ruby" | "csharp" | "elixir" | "unknown"`.
- `PackageManagerId` is a string union: `"pnpm" | "npm" | "yarn" | "bun" | "poetry" | "pipenv" | "uv" | "pip" | "go" | "cargo" | "bundler" | "gradle" | "maven"`.
- `VerificationCommand { label: string; cmd: string; args: string[]; source: ConfigSource }` — a single executable check.
- `ToolchainProfile { language: LanguageId; packageManager?: PackageManagerId; checks: { typecheck?, lint?, test?, audit?, secretScan? }; mutation?; sourcePatterns: string[]; testPatterns: string[]; ignorePatterns: string[]; allowedCommands: string[]; adversarial: { mode, runtimeImage? } }` — computed on every run from auto-detection + `.bollard.yml` overrides.
- `detectToolchain(cwd): Promise<ToolchainProfile>` — orchestrator that runs per-language detectors (TypeScript → Python → Go → Rust → fallback) and returns the first match.
- `fillPromptTemplate(template, profile): string` — replaces `{{language}}`, `{{packageManager}}`, `{{typecheck}}`, `{{linter}}`, `{{testFramework}}`, `{{auditTool}}`, `{{allowedCommands}}`, `{{sourcePatterns}}`, `{{testPatterns}}` in agent prompts.

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
- **Tester** (`createTesterAgent(profile?)`): no tools, temperature 0.3, max 5 turns. Generates adversarial tests from type signatures and referenced type definitions.

All agent creation functions accept an optional `ToolchainProfile` — when provided, prompt `{{placeholders}}` are filled with detected language/tool values.

### Static verification (packages/verify/src/static.ts)

`runStaticChecks(workDir, profile?) → { results: StaticCheckResult[]; allPassed: boolean }`

When `profile` is provided, runs checks from `profile.checks` (typecheck, lint, audit, secretScan). When omitted, falls back to hardcoded TypeScript defaults (`pnpm run typecheck`, `pnpm run lint`, `pnpm audit`, `gitleaks detect`).

### Dynamic test runner (packages/verify/src/dynamic.ts)

`runTests(workDir, testFiles?, profile?) → TestRunResult`

When `profile?.checks.test` is provided, uses its `cmd`/`args`. When omitted, falls back to `pnpm exec vitest run`.

### implement-feature blueprint (packages/blueprints/src/implement-feature.ts)

11-node pipeline:

1. **create-branch** (deterministic) — `git checkout -b bollard/{runId}`
2. **generate-plan** (agentic/planner) — planner agent explores codebase, produces JSON plan
3. **approve-plan** (human_gate) — shows plan, waits for human approval
4. **implement** (agentic/coder) — coder agent implements plan with full toolset
5. **static-checks** (deterministic) — profile-driven typecheck + lint + audit + secretScan
6. **extract-signatures** (deterministic) — extract function signatures + referenced type definitions from affected files (TS only; other languages return empty via `LlmFallbackExtractor` stub)
7. **generate-tests** (agentic/tester) — adversarial test generation from signatures + type definitions
8. **write-tests** (deterministic) — strip markdown fences, derive test path (src/ → tests/), write test files, check for information leaks
9. **run-tests** (deterministic) — profile-driven test execution
10. **generate-diff** (deterministic) — `git diff --stat main`
11. **approve-pr** (human_gate) — shows diff summary, waits for human approval

### CLI commands

| Command | Description |
|---------|-------------|
| `run demo --task "..."` | Stage 0 demo blueprint (1 deterministic + 1 agentic node) |
| `run implement-feature --task "..."` | Full Stage 1 pipeline with human gates |
| `plan --task "..."` | Standalone planner agent (no implementation) |
| `verify` | Run static checks against the workspace |
| `verify [--profile]` | Run static checks (or show detected profile as JSON) |
| `diff` | Compare detected profile vs hardcoded Stage 1 defaults |
| `eval [agent]` | Run eval sets (planner, coder) |
| `config show [--sources]` | Show resolved configuration |
| `init` | Detect project configuration |

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
  - `@anthropic-ai/sdk` (in @bollard/llm only)
  - `zod` (for config/input validation in @bollard/cli)
  - `yaml` (for .bollard.yml parsing in @bollard/cli)
- Dev deps: `typescript`, `vitest`, `@biomejs/biome`, `tsx`, `fast-check`
- If you're about to add a dependency, think twice. Can it be done in 50 lines of TypeScript instead?
- **Install deps via Docker:** `docker compose run --rm dev add <package>` (then `docker compose build dev` to bake into image).

### Testing

- **Always run tests via Docker:** `docker compose run --rm dev run test`
- Every source file gets a corresponding test file.
- Tests use Vitest (`describe`, `it`, `expect`).
- Use the `MockProvider` (from @bollard/llm) for all engine/agent tests. No real LLM calls in unit tests.
- One live smoke test in `@bollard/llm` that calls Anthropic (gracefully skips if no key or insufficient credits).
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
- `implement-feature` blueprint (11-node pipeline with human gates)
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
- `SignatureExtractor` interface with `TsCompilerExtractor` and `LlmFallbackExtractor` stub
- `write-tests` node: profile-aware test placement (src/ → tests/), markdown fence stripping
- Coder max turns increased to 60 (from 40) with turn budget guidance in prompt
- `skipVerificationAfterTurn` in executor — verification hook skipped above 80% turn budget
- `buildTesterMessage` includes referenced type definitions alongside signatures
- `compactOlderTurns` handles `edit_file` payloads

### DO NOT build yet:
- MCP server — Stage 2 (Docker isolation half)
- Docker-isolated verification containers — Stage 2 (Docker isolation half)
- LLM-based signature extraction for non-TS languages — Stage 2 (Docker isolation half)
- In-language adversarial test generation — Stage 2 (Docker isolation half)
- OpenAI/Google LLM providers — Stage 2 (Docker isolation half)
- Per-language mutation testing (Stryker, mutmut, cargo-mutants, etc.) — Stage 3
- Semantic review agent — Stage 3
- Production probes, drift detection, flag manager — Stage 3
- Git rollback on coder max-turns failure — Stage 3
- Verification summary batching (single feedback message instead of per-check retries) — Stage 3
- CI integration, run history, self-improvement — Stage 4

### Size (current):
- Total: ~5200 source, ~3690 test (+~7670 adversarial), ~238 prompt across 7 packages

## Design Principles

1. **Deterministic guardrails, agentic creativity.** Anything that CAN be deterministic MUST be deterministic. LLM calls are reserved for genuinely creative work.
2. **Convention over configuration.** Auto-detect → derive → env var → .bollard.yml. Most projects need zero config.
3. **Minimal dependency stack.** Every dep must justify its existence.
4. **Structured errors everywhere.** `BollardError` with codes, not raw strings.
5. **Context is the single source of truth.** `PipelineContext` holds everything for a run. No parallel state tracking.
6. **The runner doesn't know about agents.** Agent logic lives in `@bollard/agents`. The runner calls callbacks (`AgenticHandler`, `HumanGateHandler`). The CLI wires them together.
7. **Tools are sandboxed.** All file tools enforce path-traversal checks. `run_command` uses a whitelist. No shell expansion.

## Git Conventions

- Commit messages: `Stage N: <what changed>` (e.g., "Stage 1: implement planner agent with read-only tools")
- One logical change per commit. Don't mix engine types with CLI config.
- Branch from `main`. PR back to `main`.

## Reference Architecture Docs

If you need deeper context, refer to these (they are the source of truth) in the spec/ folder:

- `01-architecture.md` — Full architecture, type definitions, pipeline layers
- `02-bootstrap.md` — Stage-by-stage bootstrap roadmap (Stages 0 → 1 → 1.5 → 2 → 3 → 4)
- `03-providers.md` — Cloud provider abstraction (not needed until Stage 3)
- `04-configuration.md` — Config philosophy, auto-detection, .bollard.yml spec
- `05-risk-model.md` — Risk scoring dimensions and gating behavior
- `06-toolchain-profiles.md` — Language-agnostic verification: three-layer model, toolchain detection, Docker isolation, adversarial test lifecycle
