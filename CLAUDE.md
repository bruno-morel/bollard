# CLAUDE.md — Bollard

> This file guides AI coding agents (Claude Code, Cursor, Copilot) working on the Bollard codebase. Read it before writing any code.

## What Bollard Is

Bollard is an **artifact integrity framework** for AI-assisted software development. It ensures every artifact (code, tests, docs, infra) is produced, adversarially verified, and mechanically proven sound before shipping. The core innovation: separate the producer from the verifier, then prove the verification itself is meaningful (via mutation testing).

Bollard is currently at **Stage 1** (planner + coder agents). The kernel (Stage 0) executes blueprints — sequences of deterministic and agentic nodes. Stage 1 adds multi-turn agents (planner and coder), filesystem tools, static verification, the `implement-feature` blueprint, and eval sets. Stage 2 will add adversarial testing (independent test agent), Stage 3 adds mutation testing and Docker isolation.

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

### Known limitations at Stage 1

- The coder agent writes its own tests (self-validation trap). Fixed at Stage 2 with the adversarial test agent. Human review compensates for now.
- No Docker isolation — tools run in the host container with path-traversal guards only.
- No MCP server — deferred to Stage 1.5.
- No OpenAI/Google providers — Anthropic only.

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
- **Mutation testing:** Stryker (Stage 3, not yet).
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

## Project Structure (Stage 1)

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
│   ├── engine/                   ← THE KERNEL (Stage 0)
│   │   ├── src/
│   │   │   ├── types.ts          # Barrel re-exports for all engine types
│   │   │   ├── blueprint.ts      # Blueprint, BlueprintNode, NodeResult, NodeResultError
│   │   │   ├── errors.ts         # BollardError class + BollardErrorCode union
│   │   │   ├── context.ts        # PipelineContext, createContext, BollardConfig
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
│   ├── agents/                   ← AGENT INFRASTRUCTURE (Stage 1)
│   │   ├── src/
│   │   │   ├── types.ts          # AgentTool, AgentContext, AgentDefinition, AgentResult
│   │   │   ├── executor.ts       # executeAgent — multi-turn tool-use loop
│   │   │   ├── planner.ts        # createPlannerAgent — read-only tools, structured JSON output
│   │   │   ├── coder.ts          # createCoderAgent — all tools, implements plans
│   │   │   ├── eval-loader.ts    # loadEvalCases, availableAgents
│   │   │   ├── tools/
│   │   │   │   ├── index.ts      # ALL_TOOLS, READ_ONLY_TOOLS
│   │   │   │   ├── read-file.ts  # Read file contents (path-traversal protected)
│   │   │   │   ├── write-file.ts # Write file, create dirs (path-traversal protected)
│   │   │   │   ├── list-dir.ts   # List directory with type indicators
│   │   │   │   ├── search.ts     # Grep-based search with glob filtering
│   │   │   │   └── run-command.ts # Execute whitelisted commands with timeout
│   │   │   └── evals/
│   │   │       ├── planner/cases.ts  # 4 eval cases for planner output quality
│   │   │       └── coder/cases.ts    # 2 eval cases for coder output quality
│   │   ├── prompts/
│   │   │   ├── planner.md        # System prompt for planner agent
│   │   │   └── coder.md          # System prompt for coder agent
│   │   └── tests/
│   │       ├── executor.test.ts  # 7 tests — multi-turn, max turns, errors, cost
│   │       ├── tools.test.ts     # 11 tests — all 5 tools + path traversal guards
│   │       ├── planner.test.ts   # 5 tests — prompt loading, read-only tools, JSON schema
│   │       └── coder.test.ts     # 4 tests — prompt loading, full toolset, turns
│   │
│   ├── verify/                   ← STATIC VERIFICATION (Stage 1)
│   │   ├── src/
│   │   │   └── static.ts         # runStaticChecks (tsc, biome, audit, gitleaks), createStaticCheckNode
│   │   └── tests/
│   │       └── static.test.ts    # 3 tests — structure + live integration against bollard repo
│   │
│   ├── blueprints/               ← BLUEPRINT DEFINITIONS (Stage 1)
│   │   ├── src/
│   │   │   └── implement-feature.ts  # 8-node pipeline: branch → plan → approve → code → verify → test → diff → approve
│   │   └── tests/
│   │       └── implement-feature.test.ts  # 7 tests — node order, types, structure
│   │
│   └── cli/                      ← CLI (Stage 0 + Stage 1 upgrades)
│       ├── src/
│       │   ├── index.ts          # Entry: parse args, route commands, progress output
│       │   ├── config.ts         # Auto-detect + read .bollard.yml overrides
│       │   ├── agent-handler.ts  # Multi-turn agentic handler (wraps planner + coder agents)
│       │   └── human-gate.ts     # Interactive human approval via stdin
│       └── tests/
│           └── config.test.ts
```

## Current Test Stats

- **13 test files, 117 tests passing** (0 skipped, 0 failing)
- **Source:** ~2300 LOC across 6 packages
- **Tests:** ~1600 LOC
- **Prompts:** ~115 LOC (planner.md + coder.md)

## Key Types (Source of Truth)

### BollardErrorCode + BollardError (packages/engine/src/errors.ts)

- `BollardErrorCode` is a string union of all error codes (LLM_TIMEOUT, LLM_RATE_LIMIT, LLM_AUTH, LLM_PROVIDER_ERROR, LLM_INVALID_RESPONSE, COST_LIMIT_EXCEEDED, TIME_LIMIT_EXCEEDED, NODE_EXECUTION_FAILED, POSTCONDITION_FAILED, STATIC_CHECK_FAILED, TEST_FAILED, MUTATION_THRESHOLD_NOT_MET, CONTRACT_VIOLATION, HUMAN_REJECTED, RISK_GATE_BLOCKED, CONFIG_INVALID, PROVIDER_NOT_FOUND, MODEL_NOT_AVAILABLE).
- `BollardError extends Error` with `code`, `context`, `retryable` (getter — true for LLM_TIMEOUT, LLM_RATE_LIMIT, LLM_PROVIDER_ERROR).
- Static methods: `BollardError.is(err)` type guard, `BollardError.hasCode(err, code)`.

### Blueprint types (packages/engine/src/blueprint.ts)

- `NodeType = "deterministic" | "agentic" | "risk_gate" | "human_gate"`
- `NodeResultError { code: string; message: string }` — structured error on node results
- `NodeResult { status: "ok" | "fail" | "block"; data?; cost_usd?; duration_ms?; error?: NodeResultError; probes?: ProbeDefinition[] }`
- `BlueprintNode { id; name; type: NodeType; execute?; agent?; postconditions?; onFailure?: "stop" | "retry" | "skip" | "hand_to_human"; maxRetries? }`
- `Blueprint { id; name; nodes: BlueprintNode[]; maxCostUsd; maxDurationMinutes }`

### PipelineContext (packages/engine/src/context.ts)

- Single source of truth for a run. Flat type with optional fields that grow across stages.
- Fields: `runId, task, blueprintId, config, currentNode, results, changedFiles, gitBranch?, plan?: unknown, mutationScore?, generatedProbes?, deploymentManifest?, costTracker, log, upgradeRunId(taskSlug)`.
- `plan` is typed as `unknown` — the planner agent stores parsed JSON here, the coder agent reads it.

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
| list-dir | `list_dir` | Planner + Coder | List directory contents with type indicators |
| search | `search` | Planner + Coder | Grep-based regex search with glob filter |
| run-command | `run_command` | Coder only | Execute whitelisted commands (pnpm, node, tsc, biome, git, etc.) |

All tools enforce path-traversal protection: resolved path must start with `workDir`.

### Agents

- **Planner** (`createPlannerAgent()`): read-only tools, temperature 0.2, max 15 turns. Produces structured JSON plan with summary, acceptance criteria, affected files, risk assessment, steps.
- **Coder** (`createCoderAgent()`): all 5 tools, temperature 0.3, max 40 turns. Implements plans, writes tests, runs checks.

### Static verification (packages/verify/src/static.ts)

`runStaticChecks(workDir) → { results: StaticCheckResult[]; allPassed: boolean }`

Runs sequentially: `pnpm run typecheck` → `pnpm run lint` → `pnpm audit` → `gitleaks detect` (if installed).

`createStaticCheckNode(workDir)` returns a `BlueprintNode` that wraps `runStaticChecks` as a deterministic node.

### implement-feature blueprint (packages/blueprints/src/implement-feature.ts)

8-node pipeline:

1. **create-branch** (deterministic) — `git checkout -b bollard/{runId}`
2. **generate-plan** (agentic/planner) — planner agent explores codebase, produces JSON plan
3. **approve-plan** (human_gate) — shows plan, waits for human approval
4. **implement** (agentic/coder) — coder agent implements plan with full toolset
5. **static-checks** (deterministic) — typecheck + lint + audit + gitleaks
6. **run-tests** (deterministic) — `pnpm run test`
7. **generate-diff** (deterministic) — `git diff --stat main`
8. **approve-pr** (human_gate) — shows diff summary, waits for human approval

### CLI commands

| Command | Description |
|---------|-------------|
| `run demo --task "..."` | Stage 0 demo blueprint (1 deterministic + 1 agentic node) |
| `run implement-feature --task "..."` | Full Stage 1 pipeline with human gates |
| `plan --task "..."` | Standalone planner agent (no implementation) |
| `verify` | Run static checks against the workspace |
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
- `implement-feature` blueprint (8-node pipeline with human gates)
- CLI commands: `plan`, `verify`, `run implement-feature`, `eval`
- Human gate handler (interactive stdin approval)
- Agent eval sets (planner: 4 cases, coder: 2 cases)
- Progress callbacks for CLI status output
- Runner upgrades: HumanGateHandler, ProgressCallback, structured NodeResult.error

### DO NOT build yet:
- MCP server — Stage 1.5
- Adversarial test generation — Stage 2
- Type extractor — Stage 2
- OpenAI/Google LLM providers — Stage 2
- Mutation testing integration — Stage 3
- Docker isolation for tool execution — Stage 3
- Production probes, drift detection, flag manager — Stage 3
- CI integration, run history, self-improvement — Stage 4

### Size (current):
- Engine: ~650 source LOC, ~600 test LOC (6 packages)
- Total: ~2300 source, ~1600 test, ~115 prompt = ~4000 LOC

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
- `02-bootstrap.md` — Stage-by-stage bootstrap roadmap
- `03-providers.md` — Cloud provider abstraction (not needed until Stage 3)
- `04-configuration.md` — Config philosophy, auto-detection, .bollard.yml spec
- `05-risk-model.md` — Risk scoring dimensions and gating behavior
