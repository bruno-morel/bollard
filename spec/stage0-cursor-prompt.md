# Stage 0 — First Cursor Prompt

> Paste this into Cursor's Composer to kick off the Stage 0 build. The CLAUDE.md file should already be at the repo root — Cursor will read it automatically for ongoing guidance.

---

## Prompt

I'm building **Bollard**, an artifact integrity framework for AI-assisted software development. Read the `CLAUDE.md` at the repo root — it has all the context, types, and constraints.

We're starting from an empty repo. I need you to scaffold and implement **Stage 0: the kernel**. Here's the build order — complete each step fully before moving to the next:

### Step 1: Project scaffolding

Set up the monorepo structure:

- `pnpm init` at root, then create `pnpm-workspace.yaml` pointing to `packages/*`
- Create the strictest possible `tsconfig.json` (strict: true, every `noUnchecked*` flag, `moduleResolution: "bundler"`, `module: "ESNext"`, `target: "ES2022"`)
- Create `biome.json` with recommended rules + formatting (tabs → spaces, 2-space indent, double quotes for consistency with JSON)
- Create `packages/engine/`, `packages/llm/`, `packages/cli/` each with their own `package.json` (scoped as `@bollard/engine`, `@bollard/llm`, `@bollard/cli`) and a `tsconfig.json` that extends the root
- Add dev dependencies to root: `typescript`, `vitest`, `@biomejs/biome`, `tsx`, `fast-check`
- Add `@anthropic-ai/sdk` and `zod` as dependencies where needed (llm package for Anthropic, engine for Zod)
- Set up Vitest config at root (workspace-aware)
- Add scripts: `test`, `lint`, `format`, `typecheck` at root level

Run `pnpm install` after. Make sure `pnpm run typecheck` and `pnpm run lint` pass on the empty project.

### Step 2: @bollard/engine — errors.ts

Implement `BollardErrorCode` (string union of all error codes) and `BollardError` class exactly as specified in CLAUDE.md:

- Constructor takes `{ code, message, cause?, context? }`
- `Object.setPrototypeOf` for safe instanceof
- `retryable` getter (true for LLM_TIMEOUT, LLM_RATE_LIMIT, LLM_PROVIDER_ERROR)
- Static `is()` type guard and `hasCode()` helper
- Write `errors.test.ts`: test construction, type guards, retryable logic, cause chaining. Use fast-check to property-test that all retryable codes are exactly the 3 expected ones.

### Step 3: @bollard/engine — cost-tracker.ts

Implement `CostTracker`:

- Constructor takes `limitUsd: number`
- `add(costUsd: number): void` — accumulates
- `total(): number` — returns cumulative
- `exceeded(): boolean` — total > limit
- `remaining(): number` — limit - total (clamped to 0)
- Write `cost-tracker.test.ts`: test accumulation, limit checking, edge cases (0 limit, negative cost rejection, floating-point precision). Use fast-check for arithmetic properties.

### Step 4: @bollard/engine — context.ts and blueprint.ts

Implement `blueprint.ts` with all types: `NodeType`, `NodeResult`, `BlueprintNode`, `Blueprint`, `ProbeDefinition`, `ProbeAssertion`. Note: `NodeResult` has a `probes?: ProbeDefinition[]` field — the type is defined now so blueprints can output probe definitions, but the probe *runner* is Stage 3. See CLAUDE.md for the full type definitions.

Implement `context.ts`:

- `LogLevel`, `LogEntry` types
- `PipelineContext` interface
- `createContext(task, blueprintId, config)` factory
- Run ID generation: `{YYYYMMDD}-{HHMM}-run-{rand4hex}` initially, then `upgradeRunId(taskSlug)` changes to `{YYYYMMDD}-{HHMM}-{blueprint-prefix}-{slug}-{rand}`
- Structured JSON logger (reads ctx.runId and ctx.currentNode at log time)

For `BollardConfig`, define a minimal type that covers Stage 0 needs:

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
  // ... extend in later stages
}
```

No tests needed for blueprint.ts (it's pure types). Test context.ts: run ID generation/upgrade, logger output format, createContext initialization.

### Step 5: @bollard/engine — runner.ts

Implement `runBlueprint(blueprint, task, config) → Promise<RunResult>`:

- Create context via `createContext`
- Sequential node iteration
- Time guard and cost guard before each node
- Execute by node type: `deterministic` → call `node.execute(ctx)`, `agentic`/`human_gate`/`risk_gate` → stub implementations for now (agentic returns a placeholder, gates auto-approve at Stage 0)
- Retry logic: retry up to `maxRetries` on failure, then apply `onFailure` policy
- Postcondition checking after each node
- Return `RunResult` with status, context snapshot, total cost, total duration

Define `RunResult`:

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

Write `runner.test.ts`:

- Test with mock deterministic nodes (functions that return ok/fail)
- Test time limit enforcement (mock a slow node)
- Test cost limit enforcement
- Test retry behavior (node fails once then succeeds)
- Test postcondition checking
- Test onFailure policies (stop, skip, hand_to_human)
- Test node execution order (nodes run in sequence)

### Step 6: @bollard/llm — types and providers

Implement `types.ts` with all LLM types as specified in CLAUDE.md.

Implement `mock.ts` — a `MockProvider` that:

- Implements `LLMProvider`
- Takes a list of canned responses at construction
- Returns them in order on successive `chat()` calls
- Throws if called more times than canned responses exist
- Reports zero cost and predictable usage

Implement `providers/anthropic.ts` — `AnthropicProvider`:

- Wraps `@anthropic-ai/sdk`
- Maps our types to/from Anthropic's API types
- `estimateCost()` function based on model pricing
- ~80 LOC

Implement `client.ts` — `LLMClient`:

- `forAgent(agentRole)` resolves per-agent config, falls back to default
- Lazy provider instantiation (create on first use, cache)
- Stage 0: supports "anthropic" and "mock" only, throws `PROVIDER_NOT_FOUND` for others

Write `client.test.ts`:

- Test with MockProvider: forAgent resolution, default fallback, caching
- Test PROVIDER_NOT_FOUND for unknown providers
- One smoke test that calls Anthropic for real (skip if no ANTHROPIC_API_KEY — use `describe.skipIf(!process.env.ANTHROPIC_API_KEY)`)

### Step 7: @bollard/cli — config and entry

Implement `config.ts`:

- `resolveConfig()` function that follows the priority chain: CLI flags → env vars → .bollard.yml → auto-detected → defaults
- Auto-detect: check for tsconfig.json, biome.json, vitest.config.*, pnpm-lock.yaml, docker, .github/workflows/
- Read `.bollard.yml` if it exists (use Zod schema for validation)
- Every resolved value gets a `source` annotation
- Return a fully resolved `BollardConfig`

Implement `index.ts`:

- Minimal CLI using just `process.argv` parsing (no commander/yargs — too early for deps)
- Commands: `bollard run <blueprint> --task "..."`, `bollard config show [--sources]`, `bollard init`
- `run` command: resolve config → load blueprint → call `runBlueprint` → print result
- Include a hardcoded `_demo` blueprint: one deterministic node (that logs "Hello from deterministic node") and one agentic node (that calls the LLM with "Say hello in a creative way")

Write `config.test.ts`: test env var override, default fallback, auto-detection of tsconfig/biome, .bollard.yml parsing with Zod validation, source annotations.

### Step 8: Wire it all up and verify

- Make sure all cross-package imports work (`@bollard/engine` → `@bollard/llm` etc.)
- Run `pnpm run typecheck` — must pass with zero errors
- Run `pnpm run lint` — must pass with zero warnings
- Run `pnpm run test` — all tests pass
- Run the demo: `pnpm --filter @bollard/cli run start -- run demo --task "Say hello"` — executes the demo blueprint
- Print the total source LOC and test LOC (target: ~700 source, ~550 test)

### Important reminders

- Read CLAUDE.md thoroughly before starting. It has the exact type definitions.
- Don't build anything from Stage 1+ (no agents, no tools, no MCP, no Docker, no adversarial testing).
- Keep it small. ~1250 total LOC. If you're over 1500, you're overbuilding.
- Use named exports only. No default exports.
- All errors must be `BollardError` instances with appropriate codes and context.
- All logging must go through `ctx.log.*`, never `console.log`.
- Test behavior, not implementation. "Returns correct result for valid input" not "calls internal helper correctly".
- Commit after each step with message format: `Stage 0: <what>`
