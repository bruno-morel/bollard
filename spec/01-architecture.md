# Bollard

### The immovable post between your AI agents and production.

*v0.1 — March 2026*

> *"AI was supposed to replace developers. Turns out you need a bollard to stop it from crashing into the dock."*

---

## 1. What Bollard Is

Bollard is an **artifact integrity framework** for AI-assisted software development. It ensures that every artifact in your project — code, tests, documentation, infrastructure config, API schemas, monitoring rules — is produced, verified, and maintained through the same adversarial pipeline.

The core insight: code, tests, and docs all suffer from the same failure modes when AI agents produce them. They can be hallucinated, they can drift from reality, they can be internally consistent but wrong. The solution is the same for all of them: **separate the producer from the verifier, then mechanically prove the verification itself is sound.**

The result: AI writes the code, but nothing ships until Bollard says so.

### The Universal Artifact Pattern

Every artifact type in Bollard follows the same four-stage lifecycle:

```
┌─────────────┐     ┌───────────────┐     ┌──────────────┐     ┌─────────────┐
│  1. PRODUCE  │ ──► │ 2. ADVERSARIAL│ ──► │ 3. MECHANICAL│ ──► │ 4. DETECT   │
│              │     │    VERIFY     │     │    PROOF     │     │    DRIFT    │
│  An agent    │     │  A different  │     │ Deterministic│     │ Staleness   │
│  creates or  │     │  agent checks │     │ checks prove │     │ detection   │
│  updates the │     │  it, using    │     │ the verifi-  │     │ flags when  │
│  artifact    │     │  different    │     │ cation is    │     │ artifacts   │
│              │     │  information  │     │ sound        │     │ go stale    │
└─────────────┘     └───────────────┘     └──────────────┘     └─────────────┘
```

How this applies to each artifact type:

| Artifact | Produce | Adversarial Verify | Mechanical Proof | Detect Drift |
|----------|---------|-------------------|------------------|-------------|
| **Code** | Code agent (sees codebase + plan) | Test agent (sees spec + types only, NOT implementation) | Mutation testing: injects bugs, checks tests catch them | Semantic review: does code match requirement? |
| **Tests** | Test agent (sees spec, not code) | Mutation testing (do tests catch injected bugs?) | Coverage thresholds + property-based invariants | Code changes that invalidate existing tests |
| **Docs** | Doc agent (sees code + diff) | Verification agent (checks docs against actual code behavior) | Link checking, config sync, coverage scan | Orphan detection: docs referencing removed code |
| **IaC** | Code agent | Diff preview + plan verification | `terraform plan` / `pulumi preview` (deterministic) | Drift detection: actual infra vs. declared state |
| **API schemas** | Generated from code/types | Contract tests (consumer expectations vs. provider) | Schema validation (breaking change detection) | Consumer test failures in downstream services |
| **Monitoring** | Agent proposes alerts/SLOs | Review agent (are thresholds sensible?) | Dry-run alert evaluation against historical data | SLO miss rate: are we alerting on the right things? |
| **Probes** | Probe agent (sees spec + contract, NOT implementation) | Review agent (are assertions meaningful? do thresholds match risk tier?) | Dry-run against staging + inject-failure validation | Probe failures in production trigger Bollard tasks |
| **Agent prompts** | Human or agent writes prompt | Eval suite (does the prompt produce good results?) | Statistical quality metrics across N runs | Accuracy regression over time or model changes |

The same engine runs all of these. The blueprint defines which artifact types a given task touches, and the verification pipeline applies the pattern to each one. Code-only changes get code+test+doc+probe verification. Infrastructure changes get IaC+monitoring verification. API changes get code+test+contract+doc+probe verification. Production failures feed back as Bollard tasks — same pipeline, same adversarial verification. Probes measure production impact; the feedback loop (deploy → probe → measure → correct) ties it all together.

### Design Principles

1. **Every Artifact Gets Adversarial Verification.** The producer and the verifier receive different information. This applies to code (the core innovation), but equally to tests, documentation, infrastructure, and everything else Bollard manages.

2. **Deterministic Guardrails, Agentic Creativity.** Anything that *can* be deterministic (git ops, linting, formatting, deployment, link checking, schema validation) *must* be deterministic. LLM calls are reserved for genuinely creative work: understanding requirements, writing implementations, reasoning about edge cases.

3. **Trust But Verify.** Agents are given autonomy proportional to risk. Low-risk changes auto-merge with humans notified via digest. High-risk changes require explicit human approval. All changes — regardless of risk tier — go through the full verification pipeline for every artifact type they touch. Humans are always kept informed; they're only required to act when stakes justify the interruption. See [05-risk-model.md](05-risk-model.md).

4. **Layered Verification, Not Binary CI.** Not "does CI pass?" but "does each independent verification layer pass for each artifact type?" A change must clear all applicable layers regardless of risk tier.

5. **Minimal Dependencies.** Bollard depends on Docker, Node.js, pnpm, and an LLM API key. Everything else is optional. No vendor lock-in, no external infrastructure required to get started.

6. **Economic Viability.** Every verification layer must justify its cost. Target: <$15/PR in total agent compute for most tasks, well under $50 for complex ones.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        TASK INTAKE                              │
│  (CLI, MCP tool call, GitHub Issue — your choice)               │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   LAYER 0: PLANNING AGENT                       │
│                                                                 │
│  Reads requirement + relevant codebase context                  │
│  Produces: task breakdown, acceptance criteria,                 │
│  affected files, risk assessment                                │
│  Output: structured plan (JSON + human-readable)                │
│                                                                 │
│  ┌──────────────┐                                               │
│  │  RISK GATE 1 │ ◄── Bootstrap (Stages 0-3): ALWAYS requires  │
│  └──────────────┘     human plan approval (stress-test the      │
│                       risk model before trusting it).            │
│                       Stage 4+: risk-gated (HIGH+ needs         │
│                       approval, LOW/MEDIUM auto-proceeds).       │
└──────────────────────────┬──────────────────────────────────────┘
                           │ plan (approved or auto-approved)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│              LAYER 1: EXECUTION (Blueprint Engine)              │
│                                                                 │
│  Deterministic nodes:          Agentic nodes:                   │
│  · git branch                  · Code generation                │
│  · pnpm install                · Refactoring                    │
│  · lint + format               · Documentation                  │
│  · schema migrations           · Config changes                 │
│  · build                                                        │
│                                                                 │
│  Runs in isolated Docker container (local or cloud)             │
└──────────────────────────┬──────────────────────────────────────┘
                           │ code changes (no tests yet)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│     LAYER 2: MULTI-SCOPE ADVERSARIAL TEST GENERATION            │
│                                                                 │
│  SEPARATE agents (one per scope) receive different context:     │
│                                                                 │
│  Boundary scope:   signatures + types → edge cases, injection,  │
│                    complexity, resource leaks                    │
│  Contract scope:   dep graph + interface contracts → assumption │
│                    mismatch, privilege escalation, N+1 patterns  │
│  Behavioral scope: topology + endpoints + config → system       │
│                    failure modes, auth bypass, latency under load│
│                                                                 │
│  Each scope probes four concerns (weighted by relevance):       │
│    correctness, security, performance, resilience               │
│                                                                 │
│  None see the implementation body. All test against the SPEC.   │
│  See 07-adversarial-scopes.md for the full scope × concern      │
│  matrix, agent definitions, and lifecycle.                      │
└──────────────────────────┬──────────────────────────────────────┘
                           │ code + independently-written tests
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│            LAYER 3: STATIC VERIFICATION                         │
│                                                                 │
│  All deterministic — zero LLM calls:                            │
│                                                                 │
│  · TypeScript strict mode (noUncheckedIndexedAccess, etc.)      │
│  · Biome lint + format check                                    │
│  · Zod schema validation (runtime type guards)                  │
│  · npm audit (dependency vulnerabilities)                       │
│  · Architecture conformance (circular dep detection)            │
│  · Secret detection (gitleaks)                                  │
│                                                                 │
│  Cost: ~$0. Time: <30 seconds.                                  │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│           LAYER 4: DYNAMIC VERIFICATION                         │
│                                                                 │
│  a) Run ALL tests (existing + newly generated)                  │
│     Failure → code agent gets ONE retry with context            │
│                                                                 │
│  b) Mutation testing (Stryker)                                  │
│     Injects small bugs → checks that tests catch them           │
│     Threshold: ≥80% mutation score on changed files             │
│     THIS VALIDATES THE TESTS THEMSELVES                         │
│                                                                 │
│  c) Contract testing (Pact) — for API changes only              │
│                                                                 │
│  d) Integration smoke tests (Docker Compose)                    │
│                                                                 │
│  Cost: $2-8. Time: 2-5 minutes.                                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│             LAYER 5: SEMANTIC REVIEW AGENT                      │
│                                                                 │
│  A THIRD agent (not the builder, not the tester) reviews:       │
│                                                                 │
│  · Does the diff actually address the requirement?              │
│  · Logic errors the tests might miss                            │
│  · Security: injection, auth bypass, data leaks                 │
│  · Performance: N+1 queries, unbounded loops                    │
│  · Consistency with existing codebase patterns                  │
│                                                                 │
│  Output: PASS / CONCERN / BLOCK                                 │
│  BLOCK → back to code agent with feedback                       │
│  CONCERN → flagged for human attention                          │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                       RISK GATE 2                               │
│                                                                 │
│  PR includes:                                                   │
│  · Original requirement + plan + risk assessment                │
│  · Code diff + doc updates                                      │
│  · Test results + mutation score                                │
│  · Semantic review findings                                     │
│  · Cost breakdown                                               │
│                                                                 │
│  If risk ≥ HIGH: PR requires human review before merge          │
│  If risk = MEDIUM: auto-merge, human notified immediately       │
│  If risk = LOW: auto-merge, human sees daily digest             │
│                                                                 │
│  ALL tiers pass the SAME verification layers.                   │
│  Risk only changes the gating, not the verification depth.      │
└─────────────────────────────────────────────────────────────────┘
```

### Agent Retry Behavior

When an agentic node fails, Bollard retries with feedback — not blindly:

| Failure Type | Retry Strategy | Max Retries | What the Agent Receives |
|-------------|---------------|-------------|------------------------|
| **Tests fail** | Code agent retries with test output + error messages | 1 | "These tests failed: [output]. Fix the code." |
| **Semantic review: BLOCK** | Code agent retries with reviewer findings | 1 | "Reviewer blocked: [findings]. Address these." |
| **LLM timeout / rate limit** | Exponential backoff, same request | 3 | Same prompt (transparent retry) |
| **LLM auth / provider error** | Fail immediately, report to human | 0 | — |
| **Cost limit exceeded** | Fail immediately, report to human | 0 | — |

Each retry is a new LLM call with additional context (the failure output). Cost is tracked per-retry — the total cost of a run includes all retries. If a retry succeeds, the run continues normally. If all retries are exhausted, the run fails with a structured `BollardError` (`NODE_EXECUTION_FAILED` or `TEST_FAILED`) and the human is notified.

Retry counts are hardcoded defaults (1 for test failure, 1 for review block, 3 for LLM timeout). Override in `.bollard.yml` only if you have evidence the defaults don't fit:

```yaml
# .bollard.yml — only if you need to override retry defaults
agent:
  retries_on_test_failure: 2     # default: 1
```

---

## 3. Why Adversarial Testing Matters

### The Self-Validation Trap

Most AI coding agents (including Stripe's Minions) write code and then write their own tests. This is self-validation. When an agent hallucinates, it produces plausible code with tests that confirm the hallucination. CI passes. The bug ships.

Example: Agent is asked to implement compound interest. It implements simple interest but names the function `compoundInterest`. It then writes tests for simple interest (what it actually built), not compound interest (what was requested). Tests pass. Code review might catch it — or might not.

### Bollard's Solution

```
                    Requirement: "compound interest calculator"
                                    │
                    ┌───────────────┼───────────────┐
                    ▼                               ▼
            ┌──────────────┐               ┌──────────────┐
            │  CODE AGENT  │               │  TEST AGENT  │
            │              │               │              │
            │  Sees: req + │               │  Sees: req + │
            │  codebase    │               │  function    │
            │  context     │               │  signatures  │
            │              │               │  ONLY (types,│
            │  Produces:   │               │  no bodies)  │
            │  implementa- │               │              │
            │  tion code   │               │  Produces:   │
            │              │               │  tests from  │
            │              │               │  the SPEC    │
            └──────┬───────┘               └──────┬───────┘
                   │                               │
                   └───────────┬───────────────────┘
                               ▼
                    ┌─────────────────────┐
                    │  RUN TESTS          │
                    │  against code       │
                    │                     │
                    │  Then MUTATE code   │
                    │  and run again      │
                    │  (Stryker)          │
                    └─────────────────────┘
```

The test agent writes expectations from the **requirement**, not the **implementation**. If the code agent hallucinated simple interest, the test agent — which only saw the spec asking for compound interest — writes tests for compound interest. The tests fail. The hallucination is caught.

Mutation testing (Stryker) then validates the tests themselves: it injects small bugs and checks that the tests catch them. If your tests pass even when the code is mutated, the tests are weak — regardless of who wrote them.

---

## 4. Minimal Dependency Stack

Bollard is opinionated about minimizing what you depend on. Here's the full stack, divided into what's truly required vs. what's optional.

### Required (to run Bollard at all)

| Dependency | Why | Notes |
|-----------|-----|-------|
| **Docker** | Agent isolation. Every agent run happens in a container. | You already have this. |
| **Node.js 22+** | Runtime. `tsx` for development, Node.js SEA (`--build-sea`) for distribution. | No experimental flags needed. |
| **pnpm** | Package manager + workspace support. | Replaces npm + Turborepo. `pnpm -r run test` runs tests across all packages. No remote service, no cloud caching dependency. |
| **TypeScript 5.x** | Type system IS a verification layer. Strict mode on. | Dev dependency only. |
| **An LLM API key** | Anthropic Claude or equivalent. | The only recurring cost besides compute. |

That's it. Five things. A developer can `git clone`, `pnpm install`, and run the full pipeline on their laptop.

### Distribution

Bollard is distributed two ways:

| Channel | How | Who it's for |
|---------|-----|-------------|
| **npm** | `npx bollard run ...` or `pnpm add -D @bollard/cli` | Developers who already have Node.js |
| **Standalone binary** | Single executable via Node.js SEA (`--build-sea`). Pre-built for macOS (arm64, x64), Linux (x64), Windows (x64). | Everyone else. Install via Homebrew (macOS), Scoop (Windows), or GitHub Releases (all platforms). |

The standalone binary embeds Node.js + the entire Bollard CLI into a single file (~40-50MB). No runtime needed — download and run. This uses Node.js SEA (Single Executable Applications), which is built into Node.js itself — no third-party packaging tool, no second runtime to trust.

```bash
# macOS
brew install bollard

# Windows
scoop install bollard

# Linux (or any platform)
# Download from GitHub Releases
curl -fsSL https://github.com/your-org/bollard/releases/latest/download/bollard-linux-x64 -o bollard
chmod +x bollard
./bollard run implement-feature --task "..."
```

Development uses `tsx` (fast TS execution, zero config, handles all TS features). Release builds use `tsc` for compilation + `--build-sea` for binary packaging. CI produces binaries for all three platforms on every release.

### Included (dev dependencies, no external services)

| Tool | Role | Why this one |
|------|------|-------------|
| **tsx** | Dev runner | Runs TypeScript directly, no build step during development. Fast (esbuild-based). |
| **Vitest** | Test runner | Fast, TS-native, zero config. |
| **fast-check** | Property-based testing | Finds edge cases humans miss. Used by the adversarial test agent. |
| **Biome** | Lint + format | Single tool replaces ESLint + Prettier. Fast (Rust-based). Zero plugins needed. |
| **Zod** | Runtime schema validation | Bridges compile-time types to runtime checks. Agents generate Zod schemas for all boundaries. |
| **Stryker** | Mutation testing | Validates test quality mechanically. The "proof the tests work" layer. |
| **gitleaks** | Secret detection | Catches accidentally committed credentials. Single binary, no service. |

### Optional (add when you need them)

| Tool | When to add | Why optional |
|------|------------|-------------|
| **Pact** | When you have multiple services with API contracts | Overkill for a monolith or single-service setup. |
| **Playwright** | When you have a UI | Not needed for backend-only projects. |
| **OpenTelemetry** | When you deploy to production and want agent-run tracing | Can start with simple JSON logging first. |
| **Sentry** | When you need production error tracking | Cloud Logging works fine initially. |

### Explicitly NOT included

| What | Why not |
|------|---------|
| **Turborepo** | Depends on Vercel for remote caching. pnpm workspaces + `--filter` handles everything a small team needs. Add it later if build caching becomes a bottleneck. |
| **ESLint + Prettier** | Biome replaces both in a single, faster tool. Fewer configs, fewer dependencies. |
| **Jest** | Vitest is faster, TS-native, and API-compatible. No reason to use Jest in a new project. |
| **Any agent framework (LangChain, CrewAI, etc.)** | Bollard IS the framework. The blueprint engine is ~500 lines of TypeScript you own completely. No framework lock-in, no magic, no dependency on someone else's abstraction. |
| **Remote caching / build services** | Everything runs locally or in your own Docker containers. No phoning home. |

---

## 5. Project Structure

```
bollard/
├── package.json              # root — pnpm workspace config
├── pnpm-workspace.yaml       # defines workspace packages
├── tsconfig.json              # shared strict TS config
├── biome.json                 # shared lint/format config
├── docker/
│   ├── Dockerfile.agent       # the container agents run in
│   └── compose.yml            # local dev: spin up agent + deps
│
├── packages/
│   ├── engine/                # the blueprint engine (core)
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── blueprint.ts       # Blueprint and Node types
│   │   │   ├── errors.ts          # BollardError class + BollardErrorCode union
│   │   │   ├── context.ts         # PipelineContext (single source of truth):
│   │   │   │                      #   run ID generation, structured logger,
│   │   │   │                      #   state management, cost tracking ref
│   │   │   ├── runner.ts          # executes a blueprint (reads everything from ctx)
│   │   │   └── cost-tracker.ts    # tracks LLM spend per run
│   │   └── tests/
│   │
│   ├── llm/                   # thin LLM abstraction
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── types.ts           # LLMProvider interface, Message, Tool, Response types
│   │   │   ├── client.ts          # resolves provider per-agent from config
│   │   │   ├── providers/
│   │   │   │   ├── anthropic.ts   # Anthropic Claude adapter (Stage 0)
│   │   │   │   ├── openai.ts      # OpenAI adapter (Stage 1)
│   │   │   │   └── google.ts      # Google Gemini adapter (Stage 1)
│   │   │   └── mock.ts            # deterministic mock for testing
│   │   └── tests/
│   │       └── client.test.ts     # tests using mock + one live smoke test
│   │
│   ├── agents/                # agent definitions (prompts + tool configs)
│   │   ├── package.json       # depends on @bollard/llm
│   │   ├── src/
│   │   │   ├── planner.ts         # planning agent
│   │   │   ├── coder.ts           # code generation agent
│   │   │   ├── boundary-tester.ts # boundary-scope adversarial agent (Stage 2, was tester.ts)
│   │   │   ├── contract-tester.ts # contract-scope adversarial agent (Stage 3)
│   │   │   ├── behavioral-tester.ts # behavioral-scope adversarial agent (Stage 4)
│   │   │   └── reviewer.ts        # semantic review agent (Stage 3)
│   │   └── prompts/
│   │       ├── planner.md
│   │       ├── coder.md
│   │       ├── boundary-tester.md # scope 1: signatures + types + 4 concern lenses
│   │       ├── contract-tester.md # scope 2: dep graph + contracts + 4 concern lenses
│   │       ├── behavioral-tester.md # scope 3: topology + endpoints + 4 concern lenses
│   │       └── reviewer.md
│   │
│   ├── verify/                # verification layers (all deterministic)
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── static.ts          # tsc + biome + gitleaks + npm audit
│   │   │   ├── dynamic.ts         # vitest + stryker runner
│   │   │   ├── contracts.ts       # pact (optional)
│   │   │   └── smoke.ts           # docker compose integration tests
│   │   └── tests/
│   │
│   ├── cli/                   # the `bollard` CLI
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts           # entry point
│   │   │   ├── commands/
│   │   │   │   ├── run.ts         # bollard run <blueprint> --task "..."
│   │   │   │   ├── plan.ts        # bollard plan --task "..." (plan only)
│   │   │   │   ├── verify.ts      # bollard verify (run checks on current branch)
│   │   │   │   └── status.ts      # bollard status (show run history)
│   │   │   └── config.ts          # reads .bollard.yml
│   │   └── tests/
│   │
│   ├── mcp/                   # MCP server (Stage 1)
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── server.ts         # Expose engine as MCP tools (~200 LOC)
│   │   │   ├── manifest.ts       # Generate .bollard/mcp.json for discovery (~50 LOC)
│   │   │   └── transport.ts      # stdio transport (~80 LOC)
│   │   └── tests/
│   │
│   ├── blueprints/            # built-in blueprint definitions
│   │   ├── package.json
│   │   └── src/
│   │       ├── implement-feature.ts
│   │       ├── fix-bug.ts
│   │       └── refactor.ts
│   │
│   └── observe/               # production feedback loop (Stage 4)
│       ├── package.json
│       └── src/
│           ├── probe-runner.ts        # execute probes: fetch() + assertions
│           ├── probe-scheduler.ts     # cron-based probe watch
│           ├── deployment-registry.ts # record/query deployments
│           ├── drift-checker.ts       # compare deployed vs. verified state
│           └── flag-manager.ts        # read/write minimal flag state
│
└── .bollard.yml               # project-level overrides (most projects: 5 lines)
```

### `.bollard.yml` (project config)

Most configuration is auto-detected from project files (tsconfig, vitest, biome, Docker), derived from the risk model (probe frequency, remediation gating), or set via env vars (`ANTHROPIC_API_KEY`, `BOLLARD_MODEL`, `BOLLARD_PROVIDER`). The `.bollard.yml` file is only for things Bollard can't figure out on its own. See [04-configuration.md](04-configuration.md) for the full auto-detection and derivation model.

```yaml
# .bollard.yml — only what Bollard can't auto-detect or derive.
# Most projects need nothing more than this.

risk:
  sensitive_paths:
    critical: ["src/auth/**", "src/payments/**", "migrations/**"]
    high: ["src/api/public/**", "src/models/**"]
```

Extended example for teams with specific overrides:

```yaml
# .bollard.yml — extended (only add sections you need to override)

risk:
  thresholds:
    low_max: 8                   # override default of 5
  sensitive_paths:
    critical: ["src/auth/**", "src/payments/**", "migrations/**"]

llm:
  agents:
    planner:
      provider: openai
      model: gpt-4o-mini          # cheaper for planning
```

### `pnpm-workspace.yaml`

```yaml
packages:
  - 'packages/*'
```

That's the entire workspace config. No build orchestration service. pnpm handles dependency hoisting, cross-package references, and parallel script execution natively.

Common operations:

```bash
# Install everything
pnpm install

# Run tests across all packages
pnpm -r run test

# Run tests in a specific package
pnpm --filter @bollard/engine run test

# Build all packages
pnpm -r run build

# Run the CLI
pnpm --filter @bollard/cli run start -- run implement-feature --task "..."
```

---

## 6. Blueprint Engine (Core)

The engine is deliberately small (~500 lines). It runs a sequence of nodes, tracks state, and enforces guardrails. No magic.

```typescript
// packages/engine/src/errors.ts

// All error codes in one place — easy to grep, easy to extend.
// Follows the tRPC pattern: single class, discriminated by code string.
// Inspired by Node.js ERR_* conventions, Anthropic SDK's contextual metadata,
// and Zod's multi-issue accumulation.

export type BollardErrorCode =
  // LLM provider errors
  | "LLM_TIMEOUT"
  | "LLM_RATE_LIMIT"
  | "LLM_AUTH"
  | "LLM_PROVIDER_ERROR"
  | "LLM_INVALID_RESPONSE"
  // Pipeline execution errors
  | "COST_LIMIT_EXCEEDED"
  | "TIME_LIMIT_EXCEEDED"
  | "NODE_EXECUTION_FAILED"
  | "POSTCONDITION_FAILED"
  // Verification errors
  | "STATIC_CHECK_FAILED"
  | "TEST_FAILED"
  | "MUTATION_THRESHOLD_NOT_MET"
  | "CONTRACT_VIOLATION"
  // Gating errors
  | "HUMAN_REJECTED"
  | "RISK_GATE_BLOCKED"
  // Configuration errors
  | "CONFIG_INVALID"
  | "PROVIDER_NOT_FOUND"
  | "MODEL_NOT_AVAILABLE";

export class BollardError extends Error {
  readonly code: BollardErrorCode;
  readonly context: Record<string, unknown>;

  constructor(options: {
    code: BollardErrorCode;
    message: string;
    cause?: Error;
    context?: Record<string, unknown>;   // node ID, run ID, cost so far, etc.
  }) {
    super(options.message, { cause: options.cause });
    this.code = options.code;
    this.context = options.context ?? {};
    // Ensure instanceof works correctly in transpiled code
    Object.setPrototypeOf(this, BollardError.prototype);
  }

  // Static type guard — cleaner than instanceof for consumers
  static is(err: unknown): err is BollardError {
    return err instanceof BollardError;
  }

  // Check if error matches a specific code
  static hasCode(err: unknown, code: BollardErrorCode): boolean {
    return BollardError.is(err) && err.code === code;
  }

  // Is this a retryable error? (LLM transient failures, rate limits)
  get retryable(): boolean {
    return (["LLM_TIMEOUT", "LLM_RATE_LIMIT", "LLM_PROVIDER_ERROR"] as string[])
      .includes(this.code);
  }
}
```

```typescript
// packages/engine/src/context.ts
//
// PipelineContext is the single source of truth for a run.
// Everything — run ID, logger, cost tracking, node results —
// lives here. No separate state objects, no parallel tracking.
//
// The context is created at run start (with a temp ID), then
// upgraded after planning produces a permanent ID. The logger
// reads ctx.runId at log time, so the upgrade is automatic.

import { randomBytes } from "node:crypto";

// ─── Run ID Generation ──────────────────────────────────────
//
// Format: {timestamp}-{blueprint-short}-{task-slug}-{rand}
// Examples:
//   20260326-1430-feat-auth-retry-a7f3
//   20260326-1512-fix-llm-timeout-b2e1
//
// Timestamp-first → lexicographic sort = chronological sort.
// 4-char hex suffix (16 bits) → 65k unique per second.

function timestampPrefix(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toISOString().slice(11, 16).replace(":", "");
  return `${date}-${time}`;
}

function shortRand(): string {
  return randomBytes(2).toString("hex");
}

function slugify(text: string, maxLen = 30): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, maxLen);
}

const BLUEPRINT_PREFIX: Record<string, string> = {
  "implement-feature": "feat",
  "fix-bug": "fix",
  "refactor": "refactor",
  "verify-docs": "docs",
};

// ─── Logger ──────────────────────────────────────────────────
//
// Zero-dependency structured logging. One JSON line per event.
// stdout for info/debug, stderr for warn/error.
// Reads runId and currentNode from context at log time —
// no need to pass them explicitly.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  runId: string;
  nodeId?: string;
  event: string;                  // "node.start", "node.complete", "llm.call",
                                  // "gate.waiting", "cost.update", "run.complete"
  message: string;
  data?: Record<string, unknown>;
  error?: { code: BollardErrorCode; message: string };
  durationMs?: number;
  costUsd?: number;
}

// ─── Pipeline Context ────────────────────────────────────────
// Design decision: flat type with optional fields. Grows as stages add
// features (e.g., mutationScore at Stage 3, probes at Stage 3).
// We prefer simple + centralized over type-safe stage-specific interfaces.
// Optional fields are never read before they're written — the runner
// guarantees execution order via the blueprint's node sequence.

export interface PipelineContext {
  // Identity — set at creation, runId upgraded after planning
  runId: string;
  task: string;
  blueprintId: string;
  config: BollardConfig;

  // State — mutated during run
  currentNode: string;
  results: Record<string, NodeResult>;
  changedFiles: string[];
  gitBranch?: string;
  plan?: Plan;
  mutationScore?: number;            // set by mutation testing node (Stage 3)
  generatedProbes?: ProbeDefinition[]; // collected from node results (Stage 3)
  deploymentManifest?: DeploymentMetadata; // set when recording a deployment (Stage 3)

  // Infrastructure — created from context, reads from it
  // Cost tracking: LLM cost = (input_tokens × price/token + output_tokens × price/token) per call.
  // max_cost_usd applies to LLM cost only. Cloud compute costs are external.
  // Each retry counts as a separate LLM call and is tracked.
  costTracker: CostTracker;

  // Logging — reads runId and currentNode at log time
  log: {
    debug(event: string, message: string, data?: Record<string, unknown>): void;
    info(event: string, message: string, data?: Record<string, unknown>): void;
    warn(event: string, message: string, data?: Record<string, unknown>): void;
    error(event: string, message: string, error?: { code: BollardErrorCode; message: string }): void;
  };

  // Upgrade run ID after planning produces a task slug
  upgradeRunId(taskSlug: string): void;
}

// ─── Production Feedback Loop Types (Stage 3) ───────────────
//
// Probes are artifacts — they follow the Universal Artifact Pattern.
// When a probe fails, it becomes a Bollard task: same adversarial
// pipeline, same risk gating. The loop: deploy → probe → measure → correct.
// See Section 11 for full loop design (canary rollout, fix-forward, drift detection).
// See ROADMAP.md for future extensions (SLO tracking, advanced rollout automation).

export interface ProbeResult {
  probeId: string;
  timestamp: number;
  status: "pass" | "fail";
  assertions: { assertion: ProbeAssertion; passed: boolean; actual?: unknown }[];
  latencyMs: number;

  // Attribution — added automatically by the probe runner
  deploymentId?: string;           // which deployment was live when probe ran
  sourceRunId?: string;            // traced back to the Bollard run that produced this code
}

export interface DeploymentMetadata {
  deploymentId: string;            // git SHA or deployment UUID
  timestamp: number;               // when the deployment went live
  sourceRunIds: string[];          // which Bollard runs produced this deploy
  relatedCommits: string[];        // git SHAs included in this deploy
  baselineMetrics?: Record<string, number>; // snapshot of key metrics pre-deploy
}

export function createContext(
  task: string,
  blueprintId: string,
  config: BollardConfig,
): PipelineContext {
  const rand = shortRand();
  const tempRunId = `${timestampPrefix()}-run-${rand}`;

  const ctx: PipelineContext = {
    runId: tempRunId,
    task,
    blueprintId,
    config,
    currentNode: "",
    results: {},
    changedFiles: [],
    costTracker: new CostTracker(config.agent.max_cost_usd),

    log: {
      debug(event, message, data?) {
        writeLog(ctx, "debug", event, message, { data });
      },
      info(event, message, data?) {
        writeLog(ctx, "info", event, message, { data });
      },
      warn(event, message, data?) {
        writeLog(ctx, "warn", event, message, { data });
      },
      error(event, message, error?) {
        writeLog(ctx, "error", event, message, { error });
      },
    },

    upgradeRunId(taskSlug: string) {
      const prefix = BLUEPRINT_PREFIX[ctx.blueprintId] ?? slugify(ctx.blueprintId, 10);
      ctx.runId = `${timestampPrefix()}-${prefix}-${slugify(taskSlug)}-${rand}`;
      ctx.log.info("run.id_upgraded", `Run ID upgraded to ${ctx.runId}`);
    },
  };

  return ctx;
}

function writeLog(
  ctx: PipelineContext,
  level: LogLevel,
  event: string,
  message: string,
  extra?: Partial<LogEntry>,
) {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    runId: ctx.runId,             // always reads current runId
    nodeId: ctx.currentNode || undefined,
    event,
    message,
    ...extra,
  };
  const line = JSON.stringify(entry) + "\n";
  if (level === "warn" || level === "error") {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}
```

```typescript
// packages/engine/src/blueprint.ts

export type NodeType = "deterministic" | "agentic" | "risk_gate" | "human_gate";

export interface NodeResult {
  status: "ok" | "fail" | "block";
  data?: Record<string, unknown>;
  cost_usd?: number;
  duration_ms?: number;
  error?: {
    code: BollardErrorCode;
    message: string;
    context?: Record<string, unknown>;  // nodeId, runId, cost, provider, etc.
  };
  probes?: ProbeDefinition[];           // nodes can output production probe definitions
}

export interface BlueprintNode {
  id: string;
  name: string;
  type: NodeType;

  // Deterministic nodes: run a function
  execute?: (ctx: PipelineContext) => Promise<NodeResult>;

  // Agentic nodes: describe the LLM task
  agent?: {
    prompt: string;            // path to prompt template
    tools: string[];           // tool names available to the agent
    maxTokens: number;
    temperature: number;
  };

  // What must be true after this node completes
  postconditions?: ((ctx: PipelineContext) => Promise<boolean>)[];

  // If this node fails, what happens?
  onFailure?: "stop" | "retry" | "skip" | "hand_to_human";
  maxRetries?: number;
}

export interface Blueprint {
  id: string;
  name: string;
  nodes: BlueprintNode[];

  // Guardrails
  maxCostUsd: number;
  maxDurationMinutes: number;
}
```

```typescript
// packages/engine/src/runner.ts
//
// The runner reads everything from PipelineContext.
// No standalone state — context is the single source of truth.

export async function runBlueprint(
  blueprint: Blueprint,
  task: string,
  config: BollardConfig
): Promise<RunResult> {
  const ctx = createContext(task, blueprint.id, config);
  const startTime = Date.now();

  ctx.log.info("run.start", `Starting blueprint: ${blueprint.name}`, {
    blueprintId: blueprint.id, task,
  });

  for (const node of blueprint.nodes) {
    // Time guard
    const elapsed = (Date.now() - startTime) / 60_000;
    if (elapsed > blueprint.maxDurationMinutes) {
      return failRun(ctx, new BollardError({
        code: "TIME_LIMIT_EXCEEDED",
        message: `Exceeded ${blueprint.maxDurationMinutes}min limit`,
        context: { nodeId: node.id, elapsedMinutes: elapsed },
      }));
    }

    // Cost guard
    if (ctx.costTracker.exceeded()) {
      return failRun(ctx, new BollardError({
        code: "COST_LIMIT_EXCEEDED",
        message: `Exceeded $${config.agent.max_cost_usd} cost limit`,
        context: { nodeId: node.id, totalCostUsd: ctx.costTracker.total() },
      }));
    }

    ctx.currentNode = node.id;
    ctx.log.info("node.start", `Executing: ${node.name}`, { type: node.type });

    let result: NodeResult;
    let attempts = 0;
    const maxAttempts = (node.maxRetries ?? 0) + 1;

    while (attempts < maxAttempts) {
      attempts++;

      if (node.type === "deterministic") {
        result = await node.execute!(ctx);
      } else if (node.type === "agentic") {
        result = await runAgentNode(node, ctx);
      } else if (node.type === "human_gate") {
        result = await waitForHuman(node, ctx);
      } else if (node.type === "risk_gate") {
        result = await evaluateRiskGate(node, ctx);
      }

      ctx.costTracker.add(result!.cost_usd ?? 0);
      ctx.results[node.id] = result!;

      if (result!.status === "ok") {
        ctx.log.info("node.complete", `Completed: ${node.name}`, {
          durationMs: result!.duration_ms, costUsd: result!.cost_usd,
        });
        break;
      }
      if (result!.status !== "ok" && attempts >= maxAttempts) {
        ctx.log.error("node.failed", `Failed: ${node.name}`, result!.error);
        const action = node.onFailure ?? "stop";
        if (action === "stop") return failRun(ctx, result!.error);
        if (action === "hand_to_human") return handToHuman(ctx, result!);
        if (action === "skip") break;
      }
    }

    // Postcondition checks
    if (node.postconditions) {
      for (const check of node.postconditions) {
        if (!(await check(ctx))) {
          return failRun(ctx, new BollardError({
            code: "POSTCONDITION_FAILED",
            message: `Postcondition failed on node: ${node.name}`,
            context: { nodeId: node.id },
          }));
        }
      }
    }
  }

  ctx.log.info("run.complete", "Blueprint completed successfully", {
    totalCostUsd: ctx.costTracker.total(),
    totalDurationMs: Date.now() - startTime,
  });
  return successRun(ctx);
}
```

---

## 7. LLM Abstraction Layer

The `@bollard/llm` package provides a thin interface that decouples agents from any specific LLM provider. Stage 0 ships with Anthropic only; Stage 1 adds OpenAI and Google adapters. The interface is designed so that adding a provider is a single file — no changes to the engine, agents, or runner.

```typescript
// packages/llm/src/types.ts

// The interface every LLM provider implements.
// Stage 0: Anthropic. Stage 1: OpenAI, Google. Later: local models.

export interface LLMProvider {
  readonly name: string;          // "anthropic", "openai", "google", "mock"

  chat(request: LLMRequest): Promise<LLMResponse>;
}

export interface LLMRequest {
  system: string;                 // system prompt
  messages: LLMMessage[];         // conversation history
  tools?: LLMTool[];             // tool definitions (optional)
  maxTokens: number;
  temperature: number;
  model: string;                  // model name (e.g. "claude-sonnet-4-20250514")
}

export interface LLMMessage {
  role: "user" | "assistant";
  content: string | LLMContentBlock[];
}

export interface LLMContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
}

export interface LLMResponse {
  content: LLMContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  costUsd: number;               // estimated cost for this call
}

export interface LLMTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;  // JSON Schema
}
```

```typescript
// packages/llm/src/client.ts
//
// Resolves the right LLMProvider for a given agent based on config.
// Agents call `llmClient.forAgent("coder").chat(...)` — they don't
// know or care which provider is behind it.

export class LLMClient {
  private providers: Map<string, LLMProvider>;
  private agentConfig: Record<string, { provider: string; model: string }>;
  private defaultConfig: { provider: string; model: string };

  constructor(config: BollardConfig["llm"]) {
    this.defaultConfig = config.default;
    this.agentConfig = config.agents ?? {};
    this.providers = new Map();
  }

  // Resolve the provider+model for a specific agent role.
  // Falls back to default if no per-agent override exists.
  forAgent(agentRole: string): { provider: LLMProvider; model: string } {
    const agentCfg = this.agentConfig[agentRole] ?? this.defaultConfig;
    const provider = this.resolveProvider(agentCfg.provider);
    return { provider, model: agentCfg.model };
  }

  private resolveProvider(name: string): LLMProvider {
    if (this.providers.has(name)) return this.providers.get(name)!;

    // Stage 0: only Anthropic is built-in.
    // Stage 1+: dynamic import for openai, google, etc.
    let provider: LLMProvider;
    switch (name) {
      case "anthropic":
        provider = new AnthropicProvider();
        break;
      case "mock":
        provider = new MockProvider();
        break;
      default:
        throw new BollardError({
          code: "PROVIDER_NOT_FOUND",
          message: `LLM provider "${name}" is not available. Stage 0 supports: anthropic, mock.`,
        });
    }

    this.providers.set(name, provider);
    return provider;
  }
}
```

```typescript
// packages/llm/src/providers/anthropic.ts (Stage 0)
//
// Thin wrapper around the Anthropic SDK. Maps our LLMProvider
// interface to the Anthropic API. ~80 lines.

import Anthropic from "@anthropic-ai/sdk";

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic();  // reads ANTHROPIC_API_KEY from env
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const response = await this.client.messages.create({
      model: request.model,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      system: request.system,
      messages: mapMessages(request.messages),
      tools: request.tools ? mapTools(request.tools) : undefined,
    });

    return {
      content: mapResponseContent(response.content),
      stopReason: mapStopReason(response.stop_reason),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      costUsd: estimateCost(request.model, response.usage),
    };
  }
}

// Cost estimation based on published pricing.
// Updated as models/pricing change.
function estimateCost(model: string, usage: { input_tokens: number; output_tokens: number }): number {
  // Pricing per 1M tokens (as of March 2026)
  const pricing: Record<string, { input: number; output: number }> = {
    "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
    // Add models as needed
  };
  const p = pricing[model] ?? { input: 3.0, output: 15.0 };
  return (usage.input_tokens * p.input + usage.output_tokens * p.output) / 1_000_000;
}
```

---

## 8. The Adversarial Test Prompt

This is the most important prompt in the system. The test agent must be explicitly prevented from seeing implementation details.

```markdown
<!-- packages/agents/prompts/tester.md -->

# Role

You are a test engineer. Your job is to write thorough tests for a
feature based ONLY on its specification and public API surface.

# Rules

1. You have NOT seen the implementation code. Do not guess at
   implementation details. Test BEHAVIOR, not INTERNALS.

2. Write tests that verify the ACCEPTANCE CRITERIA. Each criterion
   must have at least one test.

3. Write property-based tests (using fast-check) for any function
   that takes numeric, string, or collection inputs. Properties should
   express INVARIANTS — things that must always be true regardless of
   input.

4. Write negative tests: invalid inputs, boundary values, null/undefined,
   empty collections, MAX_SAFE_INTEGER, concurrent calls if applicable.

5. Write tests that a human domain expert would write — not tests that
   a code-reading AI would write. You are testing against the SPEC,
   not against an implementation you haven't seen.

6. Use Vitest. Use fast-check for property-based tests. Use Zod for
   input validation testing.

# You Receive

- The original requirement / user story
- Acceptance criteria (from the approved plan)
- Function signatures with full TypeScript types (NO function bodies)
- Any relevant Zod schemas for input/output

# You Do NOT Receive

- Implementation source code
- Internal helper functions
- Database queries or infrastructure code
- Other agents' outputs

# Output

Write test files that can be placed alongside the implementation.
Use `describe` blocks organized by acceptance criterion.
```

---

## 9. Getting Started (Zero to First Run)

### Prerequisites

```bash
# You need:
docker --version     # Docker 24+
node --version       # Node 22+
pnpm --version       # pnpm 9+

# And an API key:
export ANTHROPIC_API_KEY=sk-ant-...
```

### Bootstrap

```bash
# Clone bollard
git clone https://github.com/your-org/bollard.git
cd bollard

# Install everything
pnpm install

# Build
pnpm -r run build

# Run your first blueprint (on Bollard's own codebase, as a demo)
pnpm --filter @bollard/cli run start -- \
  run implement-feature \
  --task "Add a health check endpoint to the CLI that returns version info" \
  --mode local   # run in local mode (no Docker) for first try
```

### Add Bollard to an Existing Project

```bash
# From your project root
pnpm add -D @bollard/cli @bollard/engine @bollard/agents @bollard/verify

# Initialize — auto-detects project setup, no config file needed
npx bollard init

# Set your LLM key
export ANTHROPIC_API_KEY=sk-ant-...

# Run
npx bollard run implement-feature --task "your task here"
```

No cloud account needed. No remote services. No sign-up. Just Docker, Node, and an LLM key.

---

## 10. Interface Architecture: Engine → API → Clients

Bollard is not a CLI tool that happens to have an API. It's a verification engine with a programmatic API, and the CLI is one client. This matters because the natural adoption path isn't "learn a new CLI" — it's "use Bollard through the tool you already work in."

### The Principle: Library First

```
┌──────────────────────────────────────────────────────────┐
│                   @bollard/engine                          │
│              (library — the verification engine)           │
│                                                           │
│  runBlueprint()  assessRisk()  runProbes()  setFlag()    │
│  getRunStatus()  listRuns()    getRollout()  ...          │
└────────────┬────────────────────┬────────────────────┬────┘
             │                    │                    │
     ┌───────▼──────┐    ┌───────▼──────┐    ┌───────▼──────┐
     │  @bollard/cli │    │ @bollard/mcp │    │  HTTP API    │
     │  (terminal)   │    │ (MCP server) │    │  (future)    │
     └──────────────┘    └──────────────┘    └──────────────┘
```

Every operation Bollard supports is a function call on the engine. The CLI translates terminal commands into engine calls. The MCP server exposes engine calls as tools. A future HTTP API (if needed) would do the same. No client has special access — they all go through the same public API surface.

### CLI: The Human Interface

The CLI is optimized for two things: developer ergonomics and CI scripting. Every command outputs human-readable text by default, machine-readable JSON with `--json`.

```bash
# ─── The commands a developer uses daily ───────────────

bollard run <task>                    # full pipeline: plan → code → test → verify → PR
bollard run <task> --plan-only        # generate plan, stop for review
bollard run <task> --emergency        # skip risk gates, audit trail created, retroactive verification queued
bollard verify                        # run all verification layers on current branch (no LLM)
bollard status                        # show active/recent runs, rollout state, probe health

# ─── Production Feedback (Stage 3+) ────────────────────

bollard probe run [probeId]           # execute probes (all or specific)
bollard probe watch                   # continuous probe monitoring
bollard deploy record                 # register a deployment with Bollard
bollard flag set <flagId> <on|off>    # set a feature flag

# ─── Utilities ─────────────────────────────────────────

bollard init                          # auto-detect project, create minimal .bollard.yml if needed
bollard history [runId]               # show run history or details of a specific run
bollard cost [--since 7d]             # LLM spend summary
bollard eval [agent]                  # run prompt eval suite (all or specific agent)
bollard doctor                        # check prerequisites (Docker, Node, API key, etc.)
bollard mcp serve                     # start MCP server (usually auto-discovered, not manual)
```

Design rules for the CLI:

- **Battery-included defaults.** `bollard run "add user authentication"` does the entire pipeline with zero flags. No `--blueprint`, no `--provider`, no `--model`. Everything is auto-detected.
- **Progressive disclosure.** `bollard status` shows a one-line summary per run. `bollard status <runId>` shows the full detail. `bollard status <runId> --json` gives machine-parseable output.
- **Exit codes matter.** `0` = success, `1` = verification failed (expected — pipeline caught a problem), `2` = Bollard itself failed (unexpected — report to human), `3` = human action needed (gate waiting for approval).
- **Streaming output.** Long-running pipelines stream progress to stderr (what's happening now) and final results to stdout (what to act on). CI captures stdout; developers watch stderr.
- **`--json` everywhere.** Every command supports `--json` for CI integration, scripting, and piping into other tools.

### MCP Server: The Agent Interface

Bollard exposes itself as an MCP (Model Context Protocol) server. Any MCP-compatible client — Claude Code, Claude Desktop, Cursor, or any custom agent — can invoke Bollard as a tool. This is the zero-friction adoption path: developers don't learn new commands, they use Bollard through the AI assistant they already have.

```typescript
// packages/mcp/src/server.ts — Bollard as MCP server
//
// Exposes engine operations as MCP tools.
// Launched via: bollard mcp serve
// Or auto-discovered via .bollard/mcp.json manifest.

const BOLLARD_MCP_TOOLS = [
  // ─── Core pipeline ──────────────────────────────────
  {
    name: "bollard_run",
    description: "Run the full Bollard verification pipeline for a task",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "What to implement/fix/refactor" },
        planOnly: { type: "boolean", description: "Stop after planning for review" },
      },
      required: ["task"],
    },
  },
  {
    name: "bollard_verify",
    description: "Run all verification layers on the current branch (no LLM calls)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bollard_status",
    description: "Show active runs, rollout state, and probe health",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Optional: specific run to inspect" },
      },
    },
  },

  // ─── Risk assessment ────────────────────────────────
  {
    name: "bollard_assess_risk",
    description: "Assess the risk tier of a set of file changes",
    inputSchema: {
      type: "object",
      properties: {
        files: { type: "array", items: { type: "string" }, description: "Changed file paths" },
      },
      required: ["files"],
    },
  },

  // ─── Observability (Stage 3+) ───────────────────────
  {
    name: "bollard_probe_run",
    description: "Execute production probes and return results",
    inputSchema: {
      type: "object",
      properties: {
        probeId: { type: "string", description: "Optional: specific probe to run" },
      },
    },
  },
  {
    name: "bollard_history",
    description: "Show recent Bollard run history with results and costs",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: "Time window, e.g., '7d', '24h'" },
      },
    },
  },
] as const;
```

MCP discovery: Bollard writes a `.bollard/mcp.json` manifest during `bollard init`. MCP-compatible editors (Claude Code, Cursor) auto-discover it:

```json
{
  "mcpServers": {
    "bollard": {
      "command": "npx",
      "args": ["bollard", "mcp", "serve"],
      "env": {}
    }
  }
}
```

A developer using Claude Code types "verify this change" and Claude calls `bollard_verify`. They say "what happened on the last run?" and Claude calls `bollard_history`. No CLI learning curve. No context switching.

### MCP Client: Agents Consume External Context (Stage 2+)

Bollard's agents can act as MCP clients, consuming tools from external MCP servers (GitHub, Slack, Jira, etc.). This is deferred to Stage 2+ — agents need to exist first. See [ROADMAP.md](ROADMAP.md).

Bootstrap staging: the MCP server lands at **Stage 1** (alongside agents). It exposes whatever engine capabilities exist at each stage — it grows automatically as the engine grows.

---

## 11. Production Feedback Loop

Verification doesn't stop at deploy. Bollard already knows what "correct" looks like — acceptance criteria, API contracts, test assertions, risk scores. Production monitoring should be *derived* from that, not built from scratch.

### The Loop: Deploy → Probe → Measure → Correct

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│ 1. DEPLOY │ ──► │ 2. PROBE │ ──► │3. MEASURE│ ──► │4. CORRECT│
│           │     │          │     │          │     │          │
│ Record    │     │ Run      │     │ Compare  │     │ Create   │
│ deployment│     │ probes   │     │ results  │     │ Bollard  │
│ manifest  │     │ against  │     │ against  │     │ task if  │
│           │     │ prod     │     │ expected │     │ failing  │
└──────────┘     └──────────┘     └──────────┘     └─────┬────┘
      ▲                                                   │
      └───────────────────────────────────────────────────┘
                     fix goes through full adversarial pipeline
```

**Probes are artifacts.** They follow the Universal Artifact Pattern: a probe agent generates probes from acceptance criteria (not implementation), a reviewer checks them, dry-run validates them, and in production they detect drift. Probes live in `.bollard/probes/` and are version-controlled.

```typescript
export interface ProbeDefinition {
  id: string;                          // e.g., "probe-auth-login-200"
  name: string;
  endpoint: string;                    // "/api/auth/login"
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  schedule: string;                    // cron, e.g., "*/5 * * * *"
  request?: { headers?: Record<string, string>; body?: unknown };
  assertions: ProbeAssertion[];
  riskTier: "low" | "medium" | "high" | "critical";
  sourceRunId: string;
  sourceBlueprint: string;
  relatedFiles: string[];
}

export interface ProbeAssertion {
  type: "status" | "body_shape" | "latency" | "header" | "body_contains" | "body_matches";
  expected: unknown;
  description: string;
}
```

**Minimal feature flags.** Bollard provides a simple flag system for teams that don't have one. A flag is a JSON entry in `.bollard/flags/flags.json` with `enabled: boolean` and `percent: number` (0-100). The application reads the flag state and routes traffic — Bollard doesn't intercept requests. No flag serving endpoint, no audience targeting. `percent` enables canary rollouts: 5% means 5% of traffic sees the new code. Teams with LaunchDarkly or similar keep using their system. See [ROADMAP.md](ROADMAP.md) for future flag-as-artifact design.

**Progressive rollout by risk tier.** The pipeline proves code is correct against the spec. Canary rollout proves the spec is correct against reality — real users, real data, real edge cases that no probe anticipates. This is defense in depth, not a vote of no confidence in verification.

| Risk Tier | Rollout | Probe Window | Advance |
|-----------|---------|-------------|---------|
| **Low** | Immediate (100%) | — | Automatic |
| **Medium** | 5% → 25% → 100% | 30 min per step | Automatic if probes pass |
| **High** | 5% → 25% → 50% → 100% | 60 min per step | Human approves each step |
| **Critical** | 5% → 10% → 25% → 50% → 100% | 120 min per step | Human approves each step |

Rollout uses the minimal flag system (on/off per-flag, with a percentage field for canary splits). The application reads the flag state and routes traffic accordingly. No external flag service required — but teams with LaunchDarkly or similar can use their system via the provider abstraction.

**Fix forward when issues are found.** When a probe fails during canary or at full rollout, the response is fix-forward: diagnose the issue, produce a fix through the full adversarial pipeline, deploy the fix. The fix itself gets adversarially tested, mutation-tested, and reviewed — each production failure makes the system stronger rather than just restoring a previous state.

```
Probe fails → canary halted → Bollard creates task (risk-scored) → same pipeline:
  LOW/MEDIUM:  Agent investigates, proposes fix, auto-merges if pipeline passes
  HIGH:        Agent investigates, human approves fix
  CRITICAL:    Human paged, agent prepares diagnosis, human decides
```

The fix gets its own probes — preventing the same regression from recurring. Emergency kill (`bollard flag set <flagId> off`) exists as an escape hatch when fix-forward latency is too slow for the severity.

**Drift detection.** Drift is when production diverges from verified state — manual hotfixes, emergency deploys, config changes that bypass Bollard. Left undetected, drift silently erodes every guarantee the pipeline provides. Bollard detects drift by comparing deployed state (from the deployment registry) against the last verified run:

```
Drift checker runs periodically:
  1. Query deployment registry for current deployed state
  2. Compare against last verified run artifacts (commit, config, schemas)
  3. Any divergence → create Bollard task to reconcile
  4. Reconciliation goes through full adversarial pipeline
```

This is how the system converges: every unverified change in production is eventually pulled back through verification. Emergency deploys create a drift trail that the drift checker picks up within hours and queues for retroactive verification.

**Resilience: when Bollard itself fails.**

| Mode | When | What works | What doesn't |
|------|------|-----------|-------------|
| **Full** | Everything healthy | All layers | — |
| **Mechanical-only** | LLM API unreachable | Static checks, tests, lint, probes | Agentic nodes |
| **Passthrough** | Bollard itself is broken | Nothing — Bollard is out of the path | Everything |

Bollard never silently blocks a deploy. LLM down = `bollard run` fails immediately with exit code 2. `bollard verify` (mechanical-only) still works. Run artifacts are written locally first, synced to provider later. Probe timeouts (can't reach target) are tracked separately from probe failures (assertion failed) — timeouts don't trigger fix-forward. Drift detection continues working in Mechanical-only mode (no LLM needed for state comparison).

---

## 12. Comparison with Stripe's Minions

| Dimension | Stripe Minions | Bollard |
|-----------|---------------|---------|
| **Agent writes its own tests** | Yes | No — adversarial: separate test agent from spec |
| **Test quality validation** | CI pass/fail | Mutation testing (mechanical proof) |
| **Gating model** | No gates — one-shot to PR | Risk-based: auto-merge (low) to human approval (critical) |
| **Verification layers** | 1 (CI) | 6 (static, dynamic, mutation, contract, semantic review, risk gate) |
| **Infrastructure required** | Stripe's internal devbox fleet | Docker + Node + pnpm |
| **Open source** | No (internal) | Yes |
| **Dependencies** | Internal tooling (Toolshed, ~500 tools) | 6 dev dependencies, zero services |
| **Cost per PR** | Unknown (internal) | $3-14 estimated |
| **Team size** | 1000+ engineers | Designed for 2-50 |
| **Agent framework** | Custom (Goose fork) | Custom (~500 LOC you own) |

---

## 13. Scaling Path

### Phase 1: Local (month 1-2)
Set up the monorepo. Build the engine. Run blueprints locally in `--mode local`. No Docker required yet. Get adversarial testing working on one real feature. Measure: do the adversarial tests catch bugs that self-written tests miss?

### Phase 2: Containerized (month 2-4)
Dockerize agent execution. Build `Dockerfile.agent` with your full toolchain. Run blueprints in isolated containers. Add Docker Compose smoke tests. This is where you can safely give agents write access to the filesystem.

### Phase 3: Cloud (month 4-6, when you need it)
Deploy agent execution to your cloud of choice via the provider interface (see [03-providers.md](03-providers.md)). GitHub Actions for most teams; GCP Cloud Run Jobs for high-volume teams. Additional providers (AWS, Azure, GitLab CI) ship later per demand — see [ROADMAP.md](ROADMAP.md). This is optional — many teams never need to leave local Docker.

### Phase 4: Trust But Verify (month 6+)
Enable risk-based auto-merge for low/medium tier changes. Agents act autonomously, humans stay informed via digests and notifications. Production feedback loop: probe failures create fix-forward tasks, agent investigates and proposes fix (risk-gated). Drift detection catches unverified changes and queues retroactive verification. Blueprint evolution based on historical success data. See [05-risk-model.md](05-risk-model.md) for the graduated trust framework and [ROADMAP.md](ROADMAP.md) for future extensions (SLO tracking, full flag system).

---

## 14. Risks and Honest Limitations

**The adversarial test agent can also hallucinate.** It might write incorrect test expectations. Mitigation: mutation testing validates the tests mechanically. If mutated code still passes the tests, the tests are provably weak — regardless of who wrote them. This is a belt-and-suspenders approach.

**Risk-gated plan approval adds latency for high-risk changes.** A Minion-style one-shot agent can produce a PR in minutes. Bollard waits for human plan approval on high/critical-risk changes. Mitigation: risk-based gating means low/medium-risk changes (the majority) proceed automatically. Only high-risk changes (auth, payments, DB migrations) block on human approval — and those are exactly the changes where 2 minutes of plan review prevents the most expensive failures.

**Mutation testing is slow.** Stryker can take minutes even on a small codebase. Mitigation: scope mutations to changed files only. Run mutation testing in parallel with other checks where possible. For time-sensitive work, make it optional per-run.

**This is more complex than "just use Copilot."** Bollard is not a code completion tool. It's a code production pipeline. If you want autocomplete, use Copilot. If you want to hand a task to an AI and trust the output, use Bollard.

---

*Bollard: because nothing ships until the bollard says so.*
