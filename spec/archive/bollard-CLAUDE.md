# CLAUDE.md — Bollard

> This file guides AI coding agents (Claude Code, Cursor, Copilot) working on the Bollard codebase. Read it before writing any code.

## What Bollard Is

Bollard is an **artifact integrity framework** for AI-assisted software development. It ensures every artifact (code, tests, docs, infra) is produced, adversarially verified, and mechanically proven sound before shipping. The core innovation: separate the producer from the verifier, then prove the verification itself is meaningful (via mutation testing).

Bollard is currently at **Stage 0** (the kernel). We are building the minimum pieces by hand so Bollard can start executing blueprints. No agents, no adversarial testing, no Docker isolation yet — just a runner that can call functions and LLMs in sequence.

## Tech Stack (Non-Negotiable)

- **Runtime:** Node.js 22+ (no experimental flags)
- **Language:** TypeScript 5.x, strict mode ON (`strict: true` in tsconfig). Every `noUnchecked*` flag enabled.
- **Package manager:** pnpm with workspaces. No npm, no yarn.
- **Test runner:** Vitest. No Jest.
- **Linter/formatter:** Biome. No ESLint, no Prettier.
- **Property-based testing:** fast-check (used by adversarial test agent later, but available now).
- **Runtime validation:** Zod at all boundaries.
- **Dev runner:** tsx (esbuild-based, runs TS directly — no build step during development).
- **Mutation testing:** Stryker (Stage 3, not yet).
- **Secret scanning:** gitleaks.

### Explicitly NOT used

- No Turborepo (pnpm workspaces + `--filter` is sufficient)
- No ESLint + Prettier (Biome replaces both)
- No Jest (Vitest is faster and TS-native)
- No agent frameworks (LangChain, CrewAI, etc.) — Bollard IS the framework
- No remote caching or build services

## Project Structure (Stage 0)

```
bollard/
├── package.json                  # root workspace
├── pnpm-workspace.yaml           # packages: ["packages/*"]
├── tsconfig.json                 # shared strict config (all packages extend this)
├── biome.json                    # shared lint/format config
│
├── packages/
│   ├── engine/                   ← THE KERNEL
│   │   ├── package.json          # @bollard/engine
│   │   ├── src/
│   │   │   ├── types.ts          # Re-exports from blueprint.ts, context.ts, errors.ts
│   │   │   ├── blueprint.ts      # Blueprint, BlueprintNode, NodeResult, NodeType
│   │   │   ├── errors.ts         # BollardError class + BollardErrorCode union
│   │   │   ├── context.ts        # PipelineContext, createContext, LogEntry, LogLevel
│   │   │   ├── runner.ts         # runBlueprint — sequential node executor
│   │   │   └── cost-tracker.ts   # CostTracker class — tracks LLM spend, enforces limits
│   │   └── tests/
│   │       ├── runner.test.ts
│   │       ├── errors.test.ts
│   │       └── cost-tracker.test.ts
│   │
│   ├── llm/                      ← LLM ABSTRACTION
│   │   ├── package.json          # @bollard/llm, depends on @anthropic-ai/sdk
│   │   ├── src/
│   │   │   ├── types.ts          # LLMProvider, LLMRequest, LLMResponse, LLMMessage, etc.
│   │   │   ├── client.ts         # LLMClient — resolves provider per-agent from config
│   │   │   ├── providers/
│   │   │   │   └── anthropic.ts  # AnthropicProvider (~80 LOC) — the ONLY provider at Stage 0
│   │   │   └── mock.ts           # MockProvider — deterministic mock for testing
│   │   └── tests/
│   │       └── client.test.ts
│   │
│   └── cli/                      ← MINIMAL CLI
│       ├── package.json          # @bollard/cli, depends on @bollard/engine + @bollard/llm
│       ├── src/
│       │   ├── index.ts          # Entry: parse args, load blueprint, run
│       │   └── config.ts         # Auto-detect + read .bollard.yml overrides
│       └── tests/
│           └── config.test.ts
```

## Key Types (Source of Truth)

The architecture spec defines these types exactly. Implement them as specified — don't reinvent.

### BollardErrorCode + BollardError (packages/engine/src/errors.ts)

- `BollardErrorCode` is a string union of all error codes (LLM_TIMEOUT, LLM_RATE_LIMIT, LLM_AUTH, LLM_PROVIDER_ERROR, LLM_INVALID_RESPONSE, COST_LIMIT_EXCEEDED, TIME_LIMIT_EXCEEDED, NODE_EXECUTION_FAILED, POSTCONDITION_FAILED, STATIC_CHECK_FAILED, TEST_FAILED, MUTATION_THRESHOLD_NOT_MET, CONTRACT_VIOLATION, HUMAN_REJECTED, RISK_GATE_BLOCKED, CONFIG_INVALID, PROVIDER_NOT_FOUND, MODEL_NOT_AVAILABLE).
- `BollardError extends Error` with `code`, `context`, `retryable` (getter — true for LLM_TIMEOUT, LLM_RATE_LIMIT, LLM_PROVIDER_ERROR).
- Static methods: `BollardError.is(err)` type guard, `BollardError.hasCode(err, code)`.
- Constructor takes `{ code, message, cause?, context? }`.
- Must call `Object.setPrototypeOf(this, BollardError.prototype)` for transpiled instanceof.

### Blueprint types (packages/engine/src/blueprint.ts)

- `NodeType = "deterministic" | "agentic" | "risk_gate" | "human_gate"`
- `NodeResult { status: "ok" | "fail" | "block"; data?; cost_usd?; duration_ms?; error?; probes?: ProbeDefinition[] }`
- `BlueprintNode { id; name; type: NodeType; execute?; agent?; postconditions?; onFailure?: "stop" | "retry" | "skip" | "hand_to_human"; maxRetries? }`
- `Blueprint { id; name; nodes: BlueprintNode[]; maxCostUsd; maxDurationMinutes }`

### PipelineContext (packages/engine/src/context.ts)

- Single source of truth for a run. Flat type with optional fields that grow across stages.
- Fields: `runId, task, blueprintId, config, currentNode, results, changedFiles, gitBranch?, plan?, mutationScore?, generatedProbes?, deploymentManifest?, costTracker, log, upgradeRunId(taskSlug)`.
- Run ID format: `{YYYYMMDD}-{HHMM}-{blueprint-short}-{task-slug}-{rand4hex}`. Starts with a temp ID, upgraded after planning.
- Logger: zero-dependency structured JSON logging. stdout for info/debug, stderr for warn/error. Reads runId and currentNode from ctx at log time.
- `createContext(task, blueprintId, config)` factory function.

### LLM types (packages/llm/src/types.ts)

- `LLMProvider { name: string; chat(request: LLMRequest): Promise<LLMResponse> }`
- `LLMRequest { system; messages: LLMMessage[]; tools?: LLMTool[]; maxTokens; temperature; model }`
- `LLMMessage { role: "user" | "assistant"; content: string | LLMContentBlock[] }`
- `LLMContentBlock { type: "text" | "tool_use" | "tool_result"; text?; toolName?; toolInput?; toolUseId? }`
- `LLMResponse { content: LLMContentBlock[]; stopReason: "end_turn" | "tool_use" | "max_tokens"; usage: { inputTokens; outputTokens }; costUsd }`
- `LLMTool { name; description; inputSchema: Record<string, unknown> }`

### LLMClient (packages/llm/src/client.ts)

- `forAgent(agentRole: string): { provider: LLMProvider; model: string }` — resolves per-agent overrides from config, falls back to default.
- Stage 0 supports: "anthropic" and "mock" providers only.

### CostTracker (packages/engine/src/cost-tracker.ts)

- Tracks cumulative LLM spend for a run.
- `add(costUsd: number)`, `total(): number`, `exceeded(): boolean` (compares against limit).
- `remaining(): number` — limit minus total, clamped to 0.
- Immutable limit set at construction via `new CostTracker(limitUsd)`.

### BollardConfig (packages/engine or cli — shared type)

Minimal at Stage 0, grows in later stages:

```typescript
interface BollardConfig {
  llm: {
    default: { provider: string; model: string };
    agents?: Record<string, { provider: string; model: string }>;
  };
  agent: {
    max_cost_usd: number;
    max_duration_minutes: number;
  };
}
```

### RunResult (packages/engine/src/runner.ts)

Returned by `runBlueprint`:

```typescript
interface RunResult {
  status: "success" | "failure" | "handed_to_human";
  runId: string;
  totalCostUsd: number;
  totalDurationMs: number;
  nodeResults: Record<string, NodeResult>;
  error?: { code: BollardErrorCode; message: string };
}
```

### ProbeDefinition (packages/engine/src/blueprint.ts)

Defined at Stage 0 so blueprints can declare probe outputs from day one, even though the probe *runner* isn't built until Stage 3:

```typescript
interface ProbeAssertion {
  type: "status" | "latency" | "json_field";
  expected: unknown;
  path?: string;        // for json_field assertions
  maxMs?: number;       // for latency assertions
}

interface ProbeDefinition {
  id: string;
  name: string;
  endpoint: string;     // URL to probe
  method: "GET" | "POST";
  assertions: ProbeAssertion[];
  intervalSeconds: number;
}
```

## Runner Logic (packages/engine/src/runner.ts)

`runBlueprint(blueprint, task, config) → Promise<RunResult>`:

1. Create context via `createContext`.
2. Iterate nodes sequentially.
3. Before each node: check time guard, check cost guard.
4. Execute node based on type (deterministic → `node.execute(ctx)`, agentic → `runAgentNode`, human_gate → `waitForHuman`, risk_gate → `evaluateRiskGate`).
5. Track cost via `ctx.costTracker.add(result.cost_usd)`.
6. On failure: retry up to `maxRetries`, then apply `onFailure` policy (stop/retry/skip/hand_to_human).
7. After each node: check postconditions.
8. Return success or failure result.

## Coding Conventions

### Style

- **No default exports.** Use named exports only.
- **No classes unless necessary.** Prefer functions + interfaces. Exceptions: `BollardError`, `CostTracker`, `LLMClient`, provider implementations.
- **No `any`.** Use `unknown` and narrow. TypeScript strict mode catches the rest.
- **No barrel files** that re-export everything. Each package has a `types.ts` that re-exports public types, but implementation files import directly.
- **Naming:** camelCase for functions/variables, PascalCase for types/classes, UPPER_SNAKE for constants. File names: kebab-case.
- **Error handling:** Always use `BollardError` with appropriate code. Never throw raw `Error`. Attach context (nodeId, runId, cost) to every error.
- **Logging:** Use `ctx.log.*` for all logging during pipeline execution. Never use `console.log`.

### Dependencies

- Minimize external dependencies. At Stage 0, the only runtime deps should be:
  - `@anthropic-ai/sdk` (in @bollard/llm only)
  - `zod` (for config/input validation at boundaries)
- Dev deps: `typescript`, `vitest`, `@biomejs/biome`, `tsx`, `fast-check`
- If you're about to add a dependency, think twice. Can it be done in 50 lines of TypeScript instead?

### Testing

- Every source file gets a corresponding test file.
- Tests use Vitest (`describe`, `it`, `expect`).
- Use the `MockProvider` (from @bollard/llm) for all engine tests. No real LLM calls in unit tests.
- One live smoke test in `@bollard/llm` that actually calls Anthropic (skipped if no API key).
- Property-based tests with fast-check where applicable (especially for cost-tracker arithmetic, error type guards).
- Test names should describe behavior, not implementation: "returns compound interest for valid inputs" not "calls Math.pow correctly".
- Aim for ~1:1 source-to-test LOC ratio.

### Config Resolution (packages/cli/src/config.ts)

Priority: CLI flags → env vars → .bollard.yml → auto-detected → hardcoded defaults.

Every resolved value has a `source` annotation: `"auto-detected"`, `"env:BOLLARD_MODEL"`, `"file:.bollard.yml"`, or `"default"`.

Auto-detection: tsconfig.json → TS. biome.json → Biome. vitest.config.* → Vitest. pnpm-lock.yaml → pnpm. docker --version → Docker. .github/workflows/ → github-actions provider.

## Scope Control (Critical)

### DO build at Stage 0:
- Engine types (Blueprint, BlueprintNode, NodeResult, PipelineContext, BollardError)
- Sequential runner (iterate nodes, track cost, enforce time/cost limits, check postconditions)
- CostTracker
- LLM types (LLMProvider, LLMRequest, LLMResponse)
- LLMClient (resolves provider per-agent)
- AnthropicProvider (~80 LOC wrapper)
- MockProvider (deterministic, for testing)
- CLI skeleton (parse args, load config, run a blueprint)
- Config auto-detection + .bollard.yml reading
- All corresponding tests

### DO NOT build at Stage 0:
- Agents (planner, coder, tester, reviewer) — Stage 1-2
- Tool implementations (read-file, write-file, search, run-command) — Stage 1
- MCP server — Stage 1
- Adversarial test generation — Stage 2
- Type extractor — Stage 2
- Mutation testing integration — Stage 3
- Docker isolation — Stage 3
- Production probes, drift detection, flag manager — Stage 3
- CI integration, run history, self-improvement — Stage 4
- OpenAI/Google LLM providers — Stage 1

### Size targets:
- Engine: ~400 source LOC, ~300 test LOC
- LLM: ~200 source LOC, ~150 test LOC
- CLI: ~100 source LOC, ~100 test LOC
- Total: ~700 source, ~550 test = ~1250 LOC

If you find yourself writing significantly more, you're probably over-engineering or building Stage 1 stuff.

## Stage 0 Milestone

Stage 0 is done when this works:

```bash
pnpm --filter @bollard/cli run start -- run demo --task "Say hello"
```

This executes a trivial blueprint with one deterministic node and one agentic node (that calls Claude and gets a response). Tests pass. TypeScript compiles. Biome is clean. That's it.

## Design Principles

1. **Deterministic guardrails, agentic creativity.** Anything that CAN be deterministic MUST be deterministic. LLM calls are reserved for genuinely creative work.
2. **Convention over configuration.** Auto-detect → derive → env var → .bollard.yml. Most projects need zero config.
3. **Minimal dependency stack.** Every dep must justify its existence.
4. **Structured errors everywhere.** `BollardError` with codes, not raw strings.
5. **Context is the single source of truth.** `PipelineContext` holds everything for a run. No parallel state tracking.
6. **Keep Stage 0 tiny.** Resist scope creep. The kernel's only job is to execute nodes in sequence and call an LLM. Everything else comes later, built by Bollard.

## Git Conventions

- Commit messages: `Stage 0: <what changed>` (e.g., "Stage 0: implement BollardError and error codes")
- One logical change per commit. Don't mix engine types with CLI config.
- Branch from `main`. PR back to `main`.

## Reference Architecture Docs

If you need deeper context, refer to these (they are the source of truth):

- `01-architecture.md` — Full architecture, type definitions, pipeline layers
- `02-bootstrap.md` — Stage-by-stage bootstrap roadmap
- `03-providers.md` — Cloud provider abstraction (not needed at Stage 0)
- `04-configuration.md` — Config philosophy, auto-detection, .bollard.yml spec
- `05-risk-model.md` — Risk scoring dimensions and gating behavior
