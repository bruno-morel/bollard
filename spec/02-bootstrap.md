# Bollard Bootstrap Roadmap
## Building Bollard with Bollard

*v0.1 — March 2026*

> *A compiler written in its own language must first be compiled by something else. Bollard, a verification system for AI-generated code, must first be verified by something else. This document describes how we get from nothing to self-hosting.*

---

## The Bootstrap Principle

At each stage, we build using **all the verification we have so far**. Stage 0 has only TypeScript strict mode and hand-written tests. Stage 1 adds the blueprint engine. Stage 2 adds adversarial testing. Stage 3 adds mutation testing. By Stage 4, Bollard is building itself through its own full pipeline.

The rule: **never ship a stage without the verification from all previous stages confirming it works.** The verification surface grows monotonically.

```
Stage 0  ──────────────────────────────────────────────────────
  Built by: humans + AI assistant (Claude Code, Copilot, etc.)
  Verified by: TypeScript strict + hand-written Vitest tests
  Produces: the kernel (engine types, runner, LLM client, CLI skeleton)

Stage 1  ──────────────────────────────────────────────────────
  Built by: Bollard kernel (manual blueprints, no adversarial tests yet)
  Verified by: kernel + Biome + static checks
  Produces: agent definitions (planner, coder), basic blueprint execution

Stage 2  ──────────────────────────────────────────────────────
  Built by: Bollard with planning + code agents
  Verified by: all of Stage 1 + adversarial test agent
  Produces: adversarial test agent, verification layers

Stage 3  ──────────────────────────────────────────────────────
  Built by: Bollard with adversarial testing
  Verified by: all of Stage 2 + mutation testing + semantic review
  Produces: mutation testing integration, semantic review agent, Docker isolation

Stage 4  ──────────────────────────────────────────────────────
  Built by: Bollard full pipeline
  Verified by: ALL layers (the complete system)
  Produces: Bollard building Bollard — self-hosting achieved
```

---

## Stage 0: The Kernel

**Goal:** Build the minimum viable pieces by hand so Bollard can start executing blueprints, even simple ones.

**Built by:** Humans with AI assistance (Claude Code, Copilot — whatever you use today). No Bollard yet.

**Verified by:** TypeScript strict mode + hand-written Vitest tests. This is the weakest verification we'll ever have, which is why we keep this stage as small as possible.

### What to build

```
bollard/
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.json
├── biome.json
│
├── packages/
│   ├── engine/                    ← THE KERNEL
│   │   ├── src/
│   │   │   ├── types.ts           # Blueprint, Node, Context, ProbeDefinition types
│   │   │   ├── errors.ts          # BollardError class + BollardErrorCode union
│   │   │   ├── context.ts         # PipelineContext: run ID, logger, state (single source of truth)
│   │   │   ├── runner.ts          # Sequential node executor (reads everything from ctx)
│   │   │   └── cost-tracker.ts    # Tracks LLM spend, enforces limits
│   │   └── tests/
│   │       ├── runner.test.ts     # Test with mock nodes (no LLM)
│   │       ├── errors.test.ts     # Error creation, type guards, retryable logic
│   │       └── cost-tracker.test.ts
│   │
│   ├── llm/                       ← LLM ABSTRACTION (Anthropic-only at Stage 0)
│   │   ├── src/
│   │   │   ├── types.ts           # LLMProvider interface + Message/Tool/Response types
│   │   │   ├── client.ts          # LLMClient: resolves provider per-agent from config
│   │   │   ├── providers/
│   │   │   │   └── anthropic.ts   # Anthropic adapter (~80 LOC) — the only one at Stage 0
│   │   │   └── mock.ts            # Deterministic mock for testing (implements LLMProvider)
│   │   └── tests/
│   │       └── client.test.ts     # Tests using mock, one live smoke test
│   │
│   └── cli/                       ← MINIMAL CLI
│       ├── src/
│       │   ├── index.ts           # Entry: parse args, load blueprint, run
│       │   └── config.ts          # Auto-detect + read .bollard.yml overrides
│       └── tests/
│           └── config.test.ts
```

### Size estimate

| Package | Source LOC | Test LOC | Files |
|---------|-----------|----------|-------|
| engine  | ~400 (types 200, runner 100, errors 50, cost-tracker 50) | ~300 (runner 150, errors 80, cost 70) | 4 src + 3 test |
| llm     | ~200 (types 60, client 80, mock 60) | ~150 (client + mock tests) | 4 src + 1 test |
| cli     | ~100 (entry + config) | ~100 (config tests) | 2 src + 1 test |
| **Total** | **~700 source** | **~550 test** | **10 src + 5 test** |

~1250 LOC total including tests. This is intentionally tiny. The kernel's only job is to execute a sequence of nodes, track cost, and report structured errors. No agents, no verification layers, no Docker — just a runner that can call functions and LLMs in sequence.

### Milestone check

You know Stage 0 is done when you can run:

```bash
pnpm --filter @bollard/cli run start -- \
  run demo \
  --task "Say hello"
```

...and it executes a trivial blueprint with one deterministic node and one agentic node (that calls Claude and gets a response). Tests pass. TypeScript compiles. That's it.

### Key decisions at Stage 0

**Decision: How does the runner call LLMs?**
The `@bollard/llm` package defines an `LLMProvider` interface and an `LLMClient` that resolves the right provider per-agent from config. Stage 0 ships with Anthropic-only + a deterministic mock for testing. The interface is designed so Stage 1 adds OpenAI/Google adapters as single files — no engine or agent changes. Agents call `llmClient.forAgent("coder").provider.chat(...)` and get back a structured `LLMResponse` with content, usage, and estimated cost. The runner doesn't know or care which provider is behind it.

**Decision: How are blueprints defined?**
As TypeScript objects, not YAML or JSON. This means blueprints have full type safety, can use functions for deterministic nodes, and can import shared utilities. The `.bollard.yml` file is for project-level *overrides* (sensitive paths, per-agent model choices), not blueprint definitions. Most config is auto-detected or derived (see [04-configuration.md](04-configuration.md)).

**Decision: Where does state live during a run?**
In a `PipelineContext` object — basically a typed key-value store that nodes read from and write to. The context is created at the start of a run and discarded at the end. No persistence, no database. State between runs (history, metrics) comes later.

---

## Stage 1: Basic Agent Execution

**Goal:** Bollard can plan and implement code changes. No adversarial testing yet — the code agent writes its own tests (yes, this is the weakness we'll fix in Stage 2).

**Built by:** Bollard kernel. We write blueprints that use Stage 0's runner to generate code. But since we don't have adversarial testing yet, we supplement with extra human review.

**Verified by:** Everything from Stage 0 (TS strict + hand-written tests) PLUS Biome lint/format checks and `npm audit`.

### What to build

```
packages/
├── agents/                        ← AGENT DEFINITIONS
│   ├── src/
│   │   ├── planner.ts             # Planning agent: reads task → outputs plan
│   │   ├── coder.ts               # Code agent: reads plan → writes code + tests
│   │   └── tools/
│   │       ├── read-file.ts       # Tool: read a file from the repo
│   │       ├── write-file.ts      # Tool: write a file to the repo
│   │       ├── search.ts          # Tool: grep/search the codebase
│   │       ├── run-command.ts     # Tool: execute a shell command (sandboxed)
│   │       └── list-dir.ts        # Tool: list directory contents
│   ├── prompts/
│   │   ├── planner.md
│   │   └── coder.md
│   └── tests/
│
├── verify/                        ← STATIC CHECKS (DETERMINISTIC ONLY)
│   ├── src/
│   │   └── static.ts              # Run: tsc, biome, gitleaks, npm audit
│   └── tests/
│
├── mcp/                          ← MCP SERVER
│   ├── src/
│   │   ├── server.ts             # Expose engine as MCP tools (~200 LOC)
│   │   ├── manifest.ts           # Generate .bollard/mcp.json (~50 LOC)
│   │   └── transport.ts          # stdio transport (~80 LOC)
│   └── tests/
│
└── blueprints/                    ← FIRST REAL BLUEPRINTS
    └── src/
        ├── implement-feature.ts   # Plan → approve → implement → lint → test
        └── _demo.ts               # The trivial demo from Stage 0
```

### How Stage 1 builds itself

Here's the key self-referential moment. Once the planner and coder agents exist, we can use them to build the *rest of Stage 1*. The workflow:

1. **Manually** write `planner.ts` and `coder.ts` with their prompts. These are the first two agents. Hand-write tests for them.
2. **Use Bollard** (with these new agents) to build the tool implementations (`read-file.ts`, `write-file.ts`, etc.). The coder agent writes the code; we review it manually (Human Gate 2 only — no adversarial tests yet).
3. **Use Bollard** to build the `implement-feature` blueprint itself. Yes, Bollard writes its own first production blueprint.
4. **Use Bollard** to build the static verification layer (`verify/static.ts`). Now future runs benefit from automatic static checks.

Each piece is verified by everything that came before it. The planner and coder are human-verified. The tools are verified by (TS + tests + human review). The blueprint is verified by (TS + tests + static checks + human review).

### Milestone check

You know Stage 1 is done when you can run:

```bash
npx bollard plan --task "Add a retry mechanism to the LLM client"
# → outputs a structured plan
# → you review and approve it

npx bollard run implement-feature --task "Add a retry mechanism to the LLM client"
# → creates a branch
# → writes code + tests
# → runs static checks
# → runs tests
# → presents you with a diff to review
```

### What's still missing (and we know it)

The coder agent writes its own tests. This is the self-validation trap we identified in the architecture doc. We accept this risk at Stage 1 because: (a) we're supplementing with extra human review, (b) the tasks we're running are on Bollard's own codebase, which we know intimately, and (c) we're about to fix it in Stage 2.

---

## Stage 2: Adversarial Verification

**Goal:** The test agent is born. Code and tests are now written by different agents with different information. This is the stage where Bollard becomes fundamentally more trustworthy than Stripe's Minions.

**Built by:** Bollard Stage 1 (planner + coder agents + static checks).

**Verified by:** Everything from Stage 1 PLUS the new adversarial test agent (once it's built, it verifies everything after it).

### What to build

```
packages/
├── agents/
│   └── src/
│       └── tester.ts              # THE adversarial test agent
│   └── prompts/
│       └── tester.md              # The prompt that enforces information isolation
│
├── verify/
│   └── src/
│       ├── static.ts              # (exists from Stage 1)
│       ├── dynamic.ts             # Run vitest, collect results
│       └── type-extractor.ts      # Extract function signatures WITHOUT bodies
│
└── blueprints/
    └── src/
        ├── implement-feature.ts   # UPDATED: now includes adversarial test step
        └── fix-bug.ts             # New blueprint
```

### The critical new piece: `type-extractor.ts`

The adversarial test agent needs to see function signatures *without* implementation bodies. This is a deterministic tool — no LLM involved:

```typescript
// Input: a TypeScript source file
// Output: all exported function/class/interface signatures with bodies replaced by "..."

// Example:
// Input:
//   export function compoundInterest(input: CompoundInterestInput): number {
//     const { principal, annualRate, compoundsPerYear, years } = input;
//     return principal * Math.pow(1 + annualRate / compoundsPerYear, compoundsPerYear * years);
//   }
//
// Output:
//   export function compoundInterest(input: CompoundInterestInput): number { ... }
```

This is what the test agent sees. It knows the function exists, what it accepts, what it returns — but not *how* it works. Combined with the acceptance criteria from the plan, this is enough to write spec-based tests.

This extractor uses the TypeScript Compiler API (`ts.createSourceFile`, walk the AST, strip function bodies). It's ~100 lines and fully deterministic.

### The bootstrap moment

Here's the beautiful part: the adversarial test agent is itself built using Bollard Stage 1 (which doesn't have adversarial testing yet). But the *moment* `tester.ts` is written and working, we can retroactively generate adversarial tests for everything built in Stage 1.

We should do this. It's our first real self-verification pass:

1. Build `tester.ts` using Stage 1's pipeline (coder writes code + its own tests, human reviews).
2. Once `tester.ts` works, run it against every package from Stage 0 and Stage 1.
3. Compare the adversarial tests to the hand-written tests. Where do they diverge? Those divergence points are potential bugs or spec gaps.
4. Fix anything the adversarial tests catch.

This is the "compiler compiling itself" moment: the output verifies the inputs that produced it.

### Updated blueprint flow

The `implement-feature` blueprint now looks like:

```
1.  [deterministic] Create branch
2.  [agentic]       Generate plan
3.  [human_gate]    Approve plan (always-on during bootstrap; risk-gated at Stage 4)
4.  [agentic]       Write implementation (code agent — sees full codebase)
5.  [deterministic] Lint + format
6.  [deterministic] Extract type signatures (strip function bodies)
7.  [agentic]       Generate tests (test agent — sees spec + signatures ONLY)
8.  [deterministic] Run static checks
9.  [deterministic] Run all tests
10. [deterministic] Present diff for review
11. [human_gate]    Approve PR
```

Steps 4 and 7 use different agents with different prompts and different information. That's the adversarial split.

> **Canonical full pipeline (Stage 3+):** This blueprint evolves as stages add layers. See the table below — it's the single source of truth for what the pipeline looks like at each stage.

| Step | Node Type | Added at | Description |
|------|-----------|----------|-------------|
| 1 | deterministic | Stage 1 | Create branch |
| 2 | agentic | Stage 1 | Generate plan (includes risk assessment) |
| 3 | human_gate | Stage 1 | Approve plan (always-on until Stage 4) |
| 4 | agentic | Stage 1 | Write implementation |
| 5 | deterministic | Stage 1 | Lint + format |
| 6 | deterministic | Stage 2 | Extract type signatures |
| 7 | agentic | Stage 2 | Generate adversarial tests |
| 8 | deterministic | Stage 1 | Run static checks |
| 9 | deterministic | Stage 1 | Run all tests |
| 10 | deterministic | Stage 3 | Mutation testing (Stryker, changed files only) |
| 11 | agentic | Stage 3 | Semantic review |
| 12 | agentic | Stage 3 | Generate production probes (see [01-architecture.md](01-architecture.md) Section 11) |
| 13 | risk_gate | Stage 1 | Create PR + gate (risk-tier determines merge behavior) |

### Milestone check

You know Stage 2 is done when:

```bash
npx bollard run implement-feature --task "Add request timeout to the LLM client"
```

...produces a PR where the tests were written by a separate agent that never saw the implementation. You can verify this by checking the agent run log — it shows what each agent received as context.

Bonus milestone: run the adversarial test agent against Stage 0's engine package. It should produce tests that are meaningfully different from the hand-written ones. If they're identical (or trivial), the test agent prompt needs tuning.

---

## Stage 3: Mechanical Verification

**Goal:** Add mutation testing (Stryker), the semantic review agent, and the production feedback loop (probe runner, drift detection, fix-forward remediation). After this stage, Bollard has all verification layers — build-time and runtime — and the system converges: unverified changes are detected and corrected.

**Built by:** Bollard Stage 2 (with adversarial testing).

**Verified by:** Everything from Stage 2 PLUS mutation testing + semantic review (once built).

### What to build

```
packages/
├── agents/
│   └── src/
│       └── reviewer.ts            # Semantic review agent
│   └── prompts/
│       └── reviewer.md
│
├── verify/
│   └── src/
│       ├── static.ts              # (exists)
│       ├── dynamic.ts             # UPDATED: adds Stryker mutation testing
│       ├── type-extractor.ts      # (exists)
│       └── contracts.ts           # Pact contract testing (optional, scaffolded)
│
├── observe/                        ← PRODUCTION FEEDBACK LOOP
│   └── src/
│       ├── probe-runner.ts        # Execute probes: fetch() + assertions (~150 LOC)
│       ├── probe-scheduler.ts     # Cron-based probe watch (~80 LOC)
│       ├── deployment-registry.ts # Record/query deployments via BollardProvider (~80 LOC)
│       ├── drift-checker.ts       # Compare deployed vs. verified state (~100 LOC)
│       └── flag-manager.ts        # Read/write minimal flag state, zero deps (~60 LOC)
│   └── tests/
│       ├── probe-runner.test.ts
│       ├── deployment-registry.test.ts
│       ├── drift-checker.test.ts
│       └── flag-manager.test.ts
│
├── blueprints/
│   └── src/
│       ├── implement-feature.ts   # UPDATED: adds mutation testing + review + probe gen
│       ├── fix-bug.ts             # (exists)
│       └── refactor.ts            # New blueprint
│
└── docker/
    ├── Dockerfile.agent           # Agent execution container
    └── compose.yml                # Local agent isolation
```

See [01-architecture.md](01-architecture.md) Section 11 for the Production Feedback Loop design (probes, fix-forward remediation, drift detection). The `ProbeDefinition` type is defined in Stage 0's `types.ts` so blueprints can output probes from the start — but the probe runner, flag manager, drift checker, and deployment registry are Stage 3 concerns. `ProbeResult` and `DeploymentMetadata` types are defined in [01-architecture.md](01-architecture.md).

### Mutation testing integration

Stryker runs after tests pass. It modifies the source code (inserts bugs) and re-runs tests. If tests still pass with a bug injected, those tests are weak.

Key design decisions:

**Scope to changed files only.** Running Stryker on the whole codebase would take forever. We only mutate files that the code agent touched in this run. This keeps mutation testing under 3 minutes for most changes.

**Threshold is configurable, default 80%.** An 80% mutation score means 80% of injected bugs were caught by the tests. This is a reasonable bar — 100% is often impossible (some mutations produce equivalent programs).

**Mutation testing runs AFTER adversarial tests pass.** This is intentional: first check that tests exist and pass (Layer 4a), then check that they're actually meaningful (Layer 4b).

### Semantic review agent

The reviewer is the third independent perspective. It sees:
- The original requirement
- The approved plan
- The full diff (code + tests)
- The test results and mutation score

It does NOT see the intermediate agent reasoning (what the code agent "thought" while writing). This prevents it from being biased by the code agent's justifications.

The reviewer outputs a structured verdict:

```typescript
interface ReviewResult {
  verdict: "pass" | "concern" | "block";
  findings: {
    category: "logic" | "security" | "performance" | "consistency" | "correctness";
    severity: "info" | "warning" | "blocker";
    location: string;       // file:line
    description: string;
    suggestion?: string;
  }[];
}
```

### Docker isolation

Stage 3 also introduces Docker isolation for agent execution. Up to this point, agents run in `--mode local` (directly on the host). Now we add `--mode docker`:

```bash
# Agent runs inside a container with:
# - The repo mounted read-write
# - Node/pnpm/tools pre-installed
# - No network access (except LLM API)
# - Filesystem destroyed after run

npx bollard run implement-feature \
  --task "Add structured logging" \
  --mode docker
```

The `Dockerfile.agent` is simple: Node 22, pnpm, the project's dependencies, and Bollard's packages. Nothing else.

### Milestone check

You know Stage 3 is done when:

```bash
npx bollard run implement-feature \
  --task "Add a rate limiter to the LLM client" \
  --mode docker
```

...runs the full pipeline: plan → approve → code → adversarial tests → static checks → test execution → mutation testing → semantic review → present PR. The PR body includes the mutation score and any review concerns.

### The retroactive pass

Just like in Stage 2, once mutation testing works, run it retroactively on all existing packages. The question to answer: **are our existing tests (both hand-written and adversarial) actually catching mutations?** Any package with a mutation score below 80% gets a ticket for test improvement — generated by Bollard itself.

---

## Stage 4: Self-Hosting

**Goal:** Bollard builds Bollard through its own full pipeline. Every change to Bollard is planned, implemented, adversarially tested, mutation-tested, semantically reviewed, and human-approved by Bollard itself.

**Built by:** Bollard full pipeline.

**Verified by:** Bollard full pipeline.

### What this looks like in practice

A developer wants to add a feature to Bollard (say, "add support for parallel node execution in blueprints"). They:

```bash
# 1. Tell Bollard what they want
npx bollard run implement-feature \
  --task "Add parallel node execution: allow blueprint nodes to declare \
          dependencies, and run independent nodes concurrently" \
  --mode docker

# 2. Bollard plans the change
#    → Planning agent reads the engine code, proposes adding a DAG scheduler
#    → Developer reviews plan: "looks good, but cap max parallelism at 4"
#    → Developer approves amended plan

# 3. Bollard implements
#    → Code agent writes the DAG scheduler, modifies runner.ts
#    → Deterministic: lint, format, type-check
#    → Type extractor strips new function bodies
#    → Test agent writes tests from spec (doesn't know it's a DAG scheduler)
#    → All tests pass
#    → Stryker mutation score: 87%
#    → Reviewer: PASS with one CONCERN ("consider what happens if a node
#      throws during parallel execution — add a test for cancellation")

# 4. Developer reviews the PR
#    → Full context: plan, diff, test results, mutation score, review
#    → Adds one more test based on the reviewer's concern
#    → Merges
```

Bollard just built a core improvement to its own engine, verified by its own pipeline.

### What to build at Stage 4

Honestly, not much *new code*. Stage 4 is mostly about:

1. **CI integration.** Wire Bollard into GitHub Actions so every push to `main` runs `npx bollard verify` (the static + dynamic checks without the agent steps).

2. **Run history.** Store results of Bollard runs (task, plan, outcome, cost, duration, mutation score) in a local SQLite database or JSON file. This lets you track trends.

3. **Blueprint for self-improvement.** A meta-blueprint: "given the run history, identify the most common failure modes and propose prompt improvements." This is the feedback loop that makes Bollard get better over time.

4. **Documentation.** Bollard writes its own docs (README, getting started, API reference) using its own pipeline. The reviewer agent checks docs against the actual code.

### Milestone check

You know Stage 4 is done when:

1. Every PR to the Bollard repo was generated by a Bollard run.
2. The Bollard CI pipeline uses Bollard's own verification layers.
3. Run history shows improving mutation scores and decreasing cost per run over time.

---

## Stage Summary

| Stage | You Build | Bollard Builds | Verified By | New Capability |
|-------|-----------|---------------|-------------|----------------|
| **0** | Engine, LLM client, CLI, eval runner | — | TS strict + hand-written tests | Can execute blueprints, run prompt evals |
| **1** | Planner + Coder agents (manually) | Tools, static checks, MCP server, first blueprint | Stage 0 + Biome + human review + evals | Can plan and implement features; usable from Claude Code/Cursor via MCP |
| **2** | — | Adversarial test agent, type extractor | Stage 1 + adversarial tests | Code and tests are independent |
| **3** | — | Mutation testing, reviewer, Docker, probe runner, flag manager, drift checker, deployment registry | Stage 2 + mutation + review + probes + drift detection | Tests proven meaningful, production feedback loop operational, drift detected and corrected |
| **4** | — | CI, history, self-improvement, GCP provider, auto-remediation | Full pipeline + production observability | Self-hosting achieved, production feeds back into pipeline |

### Time estimates (solo developer or pair)

| Stage | Estimated Time | Risk Level |
|-------|---------------|------------|
| **0** | 1-2 weeks | Low — straightforward TS, well-defined scope |
| **1** | 1-2 weeks | Medium — prompt engineering is iterative |
| **2** | 1 week | Medium — type extractor is the fiddly bit |
| **3** | 1-2 weeks | Low — Stryker/Docker are well-documented |
| **4** | 1 week | Low — mostly wiring, not invention |
| **Total** | **5-8 weeks** | — |

---

## Dependency Graph

To make the build order crystal clear, here's what depends on what:

```
                          ┌─────────────┐
                          │ tsconfig +  │
                          │ biome.json  │
                          │ (manual)    │
                          └──────┬──────┘
                                 │
                          ┌──────▼──────┐
                          │   engine    │ ◄── Stage 0
                          │ (types +   │     (manual)
                          │  runner)   │
                          └──────┬──────┘
                                 │
                    ┌────────────┼────────────┐
                    │            │            │
             ┌──────▼──────┐   ┌▼─────┐   ┌──▼───┐
             │   llm       │   │ cli  │   │verify│ ◄── Stage 0-1
             │ (client +   │   │      │   │static│     (manual → bollard)
             │  mock)      │   └──┬───┘   └──┬───┘
             └──────┬──────┘      │          │
                    │             │          │
             ┌──────▼──────┐     │          │
             │   agents    │ ◄───┘──────────┘  ◄── Stage 1
             │ (planner,   │                       (manual agents,
             │  coder)     │                        bollard for tools)
             └──────┬──────┘
                    │
          ┌─────────┼─────────┐
          │         │         │
   ┌──────▼───┐  ┌──▼────┐  ┌▼──────────┐
   │ tester   │  │verify │  │type       │ ◄── Stage 2
   │ agent    │  │dynamic│  │extractor  │     (built by bollard)
   └──────┬───┘  └──┬────┘  └───────────┘
          │         │
   ┌──────▼───┐  ┌──▼────────┐
   │ reviewer │  │ mutation   │ ◄── Stage 3
   │ agent    │  │ testing    │     (built by bollard)
   └──────────┘  └────────────┘
          │         │
          └────┬────┘
               │
        ┌──────▼──────┐
        │   Docker     │ ◄── Stage 3
        │   isolation  │
        └──────┬──────┘
               │
        ┌──────▼──────┐
        │  CI + self-  │ ◄── Stage 4
        │  hosting     │     (built by bollard, verified by bollard)
        └─────────────┘
```

---

## Guiding Principles for the Bootstrap

**1. Smallest possible manual surface.** Every line of hand-written code is a line that hasn't been adversarially tested. Keep Stage 0 tiny (~550 LOC). Get to Stage 2 as fast as possible — that's where real verification begins.

**2. Retroactive verification.** When a new verification layer comes online, run it against everything built before it. Stage 2's adversarial tests should cover Stage 0's engine. Stage 3's mutation testing should validate Stage 1's agent tests. Every layer pays dividends backward.

**3. All gates on during bootstrap.** During Stages 0-3, every plan and every PR requires human approval — regardless of what the risk model scores it. This is how we stress-test the risk model: compare the model's scores against your own judgment on hundreds of changes. At Stage 4, when you have data showing the model is reliable, transition to risk-based gating (see [05-risk-model.md](05-risk-model.md)): low-risk changes auto-merge, high-risk changes stay human-gated.

**4. Track metrics from day one.** Even at Stage 0, record: time per run, LLM cost per run, tests passed/failed, and (from Stage 2 onward) which agent caught which bugs. This data is how you prove the system works — and how you improve it.

**5. One blueprint at a time.** Don't try to build `implement-feature`, `fix-bug`, and `refactor` simultaneously. Get `implement-feature` working end-to-end first. The others are variations — easier once the pattern is established.

---

## Prompt Evaluation Framework

Agent prompts are Bollard's most important artifacts. A bad prompt in the planning agent silently degrades every downstream gate. We need a mechanical answer to: **"Is this prompt good enough?"**

Each agent prompt ships with an **eval set**: (input, expected behavior) pairs stored in `packages/agents/evals/{agent}/`. Evals run the prompt N times (default: 3) to account for LLM non-determinism, and check assertions like `contains`, `risk_tier`, `review_verdict`, `test_catches_bug`, and `no_implementation_leak`. An eval passes if assertions hold on ≥ 2/3 runs.

```bash
bollard eval [agent]                   # run all evals (or for one agent)
bollard eval --prompt path/to/new.md   # test a prompt change before committing
bollard eval --compare HEAD~1          # compare current prompt against previous version
```

When a prompt file changes, Bollard runs evals as a postcondition: fewer evals passing → `BLOCK`, same evals but higher cost → `CONCERN`, more evals passing → `PASS` (update baseline). This makes prompts a row in the Universal Artifact Pattern: produce → eval → mechanical proof → regression detection.

**Bootstrap timing:** Stage 0 builds the eval infrastructure (~200 LOC). Stage 1 adds planner/coder eval sets. Stage 2 adds tester/reviewer evals. Stage 3+ grows organically — every prompt fix adds the triggering case as a new eval. See [ROADMAP.md](ROADMAP.md) for the full prompt evaluation framework design.

---

## What Could Go Wrong

**Stage 0 takes too long because of scope creep.** The kernel wants to be perfect. Resist. It needs to execute nodes in sequence and call an LLM. That's it. Everything else comes later, built by Bollard.

**Stage 1's agent prompts are bad.** The planner plans poorly, the coder writes bad code. This is expected. Prompt engineering is iterative. Budget for 3-5 iterations of each prompt. Use the hand-written tests as your quality signal.

**Stage 2's type extractor doesn't handle all TS patterns.** TypeScript's type system is complex. The extractor doesn't need to handle everything — just exported functions, classes, and interfaces. Skip generics-heavy edge cases in v0. Handle them when you hit them.

**Stage 3's mutation testing is too slow.** Stryker on a full package can take 10+ minutes. Scope aggressively: only mutate files changed in the current run, only run relevant tests. If it's still too slow, make it optional and run it as a nightly job.

**The adversarial test agent writes trivial tests.** "Does the function exist? Does it not throw on empty input?" These pass mutation testing but don't prove correctness. This is a prompt quality issue. The tester prompt needs explicit instructions to write *domain-meaningful* assertions, not just smoke tests. Include examples of good vs. bad tests in the prompt.

---

## First Commit

When you're ready to start, the very first thing to create is:

```bash
mkdir bollard && cd bollard
git init
pnpm init

# Create the workspace
echo 'packages:\n  - "packages/*"' > pnpm-workspace.yaml

# Create the strictest possible tsconfig
# Create biome.json
# Create packages/engine/package.json
# Write types.ts — the Blueprint and Node interfaces

git add -A
git commit -m "Stage 0: initial project structure and engine types"
```

Start with the types. They're the contract everything else builds on. Get them right, and the rest follows. The eval runner (`bollard eval`) lands at Stage 0 alongside the CLI — it's infrastructure, not a feature.
