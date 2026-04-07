# Bollard: Multi-Scope Adversarial Verification
## Beyond Unit Tests — Adversarial Concerns at Every Scale

*v0.1 — April 2026*

> *"A function that validates its inputs perfectly can still participate in a system that fails catastrophically. Adversarial verification must match the scale of the concern."*

---

## 1. The Problem

Bollard's current adversarial tester operates at a single scope: it sees function signatures and type definitions, and generates tests that probe boundary conditions — null inputs, off-by-one values, malformed data. This is valuable, but it only catches one class of defect.

The bugs that bring down production rarely live inside a single function. They live at the seams: module A assumes the error will be a string, but module B throws a typed error object. Service X retries on failure, but service Y isn't idempotent. The config loader silently swallows a parse error and falls back to defaults that break downstream consumers.

A developer who writes thorough unit tests may never write integration or system tests — not because they're lazy, but because their test framework makes it painful, their CI doesn't support it, or they simply don't think to test the composition. Bollard should guarantee adversarial verification at every scale of concern, regardless of what the developer's own test infrastructure supports.

This spec introduces **adversarial scopes** — distinct scales of adversarial concern, each with its own agent, its own context strategy, its own execution mode, and its own lifecycle.

---

## 2. Why New Vocabulary

The standard testing hierarchy — unit, integration, system, end-to-end — carries decades of conflicting definitions. "Integration test" means something different to a Go developer (who thinks `TestMain` with a real database), a React developer (who thinks `render()` with mocked API calls), and an SRE (who thinks staging environment with traffic replay). These terms also imply a technology-specific hierarchy that varies by language and framework.

More importantly, Bollard isn't generating "tests" in the traditional sense. It's generating **adversarial probes** — deliberate attempts to find defects that the producer agent missed. The scope of the probe determines what context the adversarial agent needs, what it's looking for, and how it executes. The scope is about **what class of defect we're hunting**, not what testing framework we're using.

---

## 3. The Three Adversarial Scopes

### Scope 1: Boundary

> "Does this function handle inputs the developer didn't think about?"

**What it probes:** Individual function and type boundaries. Edge cases in input validation, type coercion, error handling, arithmetic overflow, empty collections, null/undefined paths, off-by-one errors.

**What the agent sees:**
- Function signatures (from type extractor)
- Type definitions and referenced types
- Acceptance criteria from the plan
- The project's test patterns (to match conventions, when integrating)

**What the agent does NOT see:**
- Implementation bodies
- The coder agent's reasoning
- Existing test implementations (to avoid anchoring)

**Execution mode:** Always in-language when possible (tests import the function directly), with blackbox fallback for unsupported languages.

**This is what the current tester agent does.** Boundary scope is Stage 2's adversarial test generation, formalized as one scope among several.

---

### Scope 2: Contract

> "Do these components honor each other's assumptions when composed?"

**What it probes:** Cross-module assumptions, interface compliance, error propagation chains, data transformation pipelines, state machine transitions across boundaries, implicit ordering dependencies, shared resource contention between components.

**What the agent sees:**
- Module dependency graph (which modules import which)
- Interface definitions at module boundaries (exported types, public APIs)
- Data flow paths: how data transforms as it crosses module boundaries
- Error handling contracts: what errors each module throws vs. what its consumers catch
- The plan's "affected files" list and the relationships between them

**What the agent does NOT see:**
- Internal implementation details of any module
- The coder agent's reasoning
- Existing integration tests

**Why this scope matters:** A boundary-scope test proves that `parseConfig()` rejects malformed YAML. A contract-scope test proves that when `parseConfig()` returns a partial result (which its type signature allows), the downstream `initializeService()` doesn't silently use defaults that violate the caller's expectations. The defect lives in the space *between* two correct functions.

**Execution mode:** Language-dependent. Some frameworks (Vitest, pytest, Go's `testing` package) can compose modules in a single process. Others may require Bollard to spin up a lightweight harness. The contract scope agent must be aware of what the project's test framework can support — and when it can't, Bollard provides its own execution environment.

---

### Scope 3: Behavioral

> "Does this system behave correctly under conditions that are realistic but never tested in isolation?"

**What it probes:** System-wide invariants under concurrent access, failure injection (network errors, timeouts, disk full, OOM), resource exhaustion, configuration drift, deployment ordering, race conditions, retry storms, cascading failures, clock skew, partial availability.

**What the agent sees:**
- System topology: services, dependencies, external integrations, message queues, databases
- Public interface surface: HTTP endpoints, CLI commands, gRPC services, event consumers
- Configuration schema: what's configurable, what the defaults are, what combinations are valid
- Deployment constraints: ordering, health checks, rollback triggers
- SLA definitions (if they exist): latency budgets, error rate thresholds
- Failure mode catalog: what can go wrong at each external boundary

**What the agent does NOT see:**
- Internal implementation details
- The coder agent's reasoning
- Source code (in blackbox mode)

**Execution mode:** Primarily blackbox — tests interact through the system's public interfaces. This is the only viable mode for behavioral scope because the concerns being tested (concurrency, failure injection, resource limits) can't be meaningfully reproduced by importing functions in a test file. Requires Docker-isolated execution with the ability to inject faults (network delays, process kills, resource limits).

**Why this scope matters:** The boundary tests prove functions handle edge cases. The contract tests prove modules compose correctly. The behavioral tests prove the *system* works under conditions that only exist in production — but are reproduced in a controlled environment. A developer who writes perfect unit and integration tests may never test what happens when two requests hit the same endpoint concurrently with different auth tokens while the database is running at 95% connection pool capacity. Bollard does.

---

## 4. Cross-Cutting Concerns — The Second Dimension

Scopes define the **scale** of the adversarial probe. But scale alone doesn't capture *what class of defect* we're hunting. A boundary-scope test might probe for a null pointer (correctness), an SQL injection vector (security), or an O(n²) algorithm (performance). These are different adversarial concerns applied at the same scope.

Concerns are **orthogonal to scope**. They are not additional scopes — they don't change what the agent sees or how the test executes. They change **what the agent looks for** within the context it already has.

### The Four Concerns

#### Correctness

> "Does this code produce the right output for all valid (and invalid) inputs?"

The default lens. Every adversarial probe implicitly includes correctness — edge cases, off-by-one errors, type mismatches, logic errors, missing error handling. This is what the current tester agent already focuses on.

#### Security

> "Can this code be exploited, bypassed, or manipulated by a hostile actor?"

At each scope, security probes look for different vulnerability classes:

| Scope | Security probes |
|-------|----------------|
| Boundary | Input validation bypasses (SQL injection, XSS, path traversal, command injection), buffer overflows, unsafe deserialization, type confusion attacks, integer overflow leading to privilege changes |
| Contract | Privilege escalation through module composition, auth token handling across module boundaries (passed without re-validation, leaked in error messages, stored in logs), TOCTOU races between authorization check and resource access, implicit trust between modules that should verify independently |
| Behavioral | Auth bypass through concurrent requests, session fixation under load, CSRF across full request flows, timing side-channels, rate limit bypass through distributed requests, TLS downgrade, credential stuffing resilience, API key/secret exposure in error responses under stress |

#### Performance

> "Does this code degrade unacceptably under realistic load or input sizes?"

| Scope | Performance probes |
|-------|-------------------|
| Boundary | Algorithmic complexity with large inputs (O(n²) hidden in a loop, regex catastrophic backtracking, unbounded recursion depth), excessive memory allocation for edge-case inputs, blocking operations in hot paths |
| Contract | N+1 query patterns emerging from module composition, unnecessary serialization/deserialization at boundaries, chatty inter-module communication (10 calls where 1 batch call would suffice), lock contention between modules sharing resources, memory leaks from circular references across module boundaries |
| Behavioral | Latency degradation under concurrent load, connection pool exhaustion, memory growth over sustained traffic, GC pressure from allocation patterns that only surface at scale, cache stampede on expiry, slow query accumulation, thread/goroutine/fiber starvation |

#### Resilience

> "Does this code behave predictably when dependencies fail, resources are exhausted, or conditions are degraded?"

| Scope | Resilience probes |
|-------|------------------|
| Boundary | Graceful handling of I/O errors (disk full, permission denied, file not found), timeout handling in individual functions, resource cleanup on exception (file handles, connections, locks), behavior when optional dependencies return undefined/null |
| Contract | Error propagation fidelity (does the error message survive module boundaries, or does it get swallowed/transformed into something misleading?), retry behavior in calling modules vs. idempotency in called modules, cascade failure when one module in a chain fails (does the whole chain fail, or does it degrade gracefully?), circuit breaker patterns at module boundaries |
| Behavioral | System behavior during partial outages (database down, cache unavailable, third-party API timing out), graceful degradation under resource exhaustion (connection pool full, disk 95%, memory pressure), recovery behavior after failures resolve (does the system resume, or does it stay in a degraded state?), retry storm behavior (does exponential backoff actually work across the system?), data consistency after split-brain or network partition scenarios |

### Why Concerns Are Prompt Guidance, Not Separate Agents

At boundary and contract scope, the context and execution mode are identical regardless of which concern the agent is probing. A boundary-scope agent looking at a function signature uses the same information to ask "does this handle null?" (correctness), "can this input bypass validation?" (security), "is this O(n²)?" (performance), and "does this clean up resources on error?" (resilience). Splitting into four agents per scope would quadruple cost without meaningfully improving probe quality — the reasoning is similar, just viewed through a different lens.

The agent prompts for boundary and contract scopes include all enabled concern lenses as structured guidance sections. Each concern section provides the agent with specific probe patterns to look for at that scope. This keeps the prompt focused (the scope constrains what the agent sees) while broadening what it looks for (the concerns expand what it probes).

**The behavioral scope exception:** At behavioral scope, security testing and performance testing may diverge significantly in tooling requirements. Security behavioral tests may need specialized tools (fuzzing frameworks, auth bypass scripts, TLS inspection). Performance behavioral tests need load generators, latency measurement, and resource monitoring. If empirical runs show that a single behavioral agent produces shallow security or performance probes, the behavioral scope can split into sub-agents:

```
Behavioral scope:
  behavioral-tester         (correctness + resilience — fault injection, failure modes)
  behavioral-security       (security — pen-test patterns, auth flows, injection at scale)
  behavioral-performance    (performance — load generation, latency profiling, resource monitoring)
```

This split is not mandated by the spec — it's a recognized escape hatch for when empirical evidence shows the single-agent approach is insufficient. Start with one behavioral agent that includes all concern lenses; split only when probe quality degrades.

### Concern Weights — Not All Concerns Matter Equally at Every Scope

Not every concern deserves the same attention at every scope. Security is critical at boundary scope (that's where injection happens) but less frequent at contract scope. Performance is noise at boundary scope for a config parser called once at startup, but it dominates at behavioral scope under load. Resilience barely matters for pure functions but is the primary concern when a system is under partial outage.

Concerns carry a **weight** per scope: `high`, `medium`, `low`, or `off`. The weight tells the agent how much of its probe budget to allocate — a high-weight concern gets more test cases and deeper reasoning; a low-weight concern gets a quick check; `off` removes the concern section from the prompt entirely.

#### Default Weight Matrix

| Concern | Boundary | Contract | Behavioral |
|---------|----------|----------|------------|
| Correctness | **high** | **high** | medium |
| Security | **high** | medium | **high** |
| Performance | low | medium | **high** |
| Resilience | low | medium | **high** |

**Why these defaults:**

**Correctness** is high at boundary and contract — that's where logic errors and assumption mismatches live. At behavioral scope it drops to medium because the individual functions and module compositions are already proven correct by the lower scopes; behavioral correctness is about system-level invariants, which are fewer in number.

**Security** is high at the edges — boundary (where untrusted input enters the system) and behavioral (where an attacker interacts with the running system through its public interfaces). At contract scope it's medium — privilege escalation through module composition is real but less common than direct injection.

**Performance** inverts the boundary pattern. A single function's algorithmic complexity rarely matters unless it's on a hot path (which the agent can't always know without runtime context). But at system scale, latency accumulation, connection pool exhaustion, and memory growth under load are dominant failure modes. Low at boundary, medium at contract (N+1 queries emerge from composition), high at behavioral.

**Resilience** follows the same gradient. A pure function doesn't need resilience probes — it either works or throws. But a chain of modules needs error propagation fidelity and retry/idempotency alignment. And a running system under partial outage needs graceful degradation and recovery behavior.

### Concern Configuration

Concerns are configured globally (with weights) and overridable per scope. The default weight matrix (above) applies when no overrides are specified.

```yaml
# .bollard.yml — concern overrides
adversarial:
  concerns:
    correctness: high             # default: high (always recommended)
    security: high                # default: high
    performance: medium           # default: varies by scope (see matrix)
    resilience: medium            # default: varies by scope (see matrix)

  # Per-scope concern weight overrides
  boundary:
    concerns:
      security: off               # this is a pure computation library, no untrusted input
  behavioral:
    concerns:
      performance: off            # CLI tool, no sustained load scenario
```

Setting a concern to `off` removes its guidance section from the agent prompt entirely. Setting it to `low` keeps the section but tells the agent to do a quick check rather than deep probing. The global setting provides a baseline; per-scope overrides let the developer tune where attention goes.

**Auto-detection can influence weights.** If Bollard detects no HTTP endpoints and no CLI commands (pure library), it can automatically lower behavioral security weight. If it detects no external dependencies (no database, no network calls), it can lower resilience at all scopes. These are suggestions in `bollard init` output, not silent overrides — the developer always sees and can change them.

### How Concerns Flow Into Agent Prompts

Each scope's prompt template includes weighted concern blocks. The weight controls both inclusion and the agent's attention allocation:

```markdown
# Boundary Tester System Prompt

You are an adversarial tester. Your job is to find defects in the code
that the implementing agent missed.

## What you see
{{signatures}}
{{typeDefinitions}}
{{acceptanceCriteria}}

## What to probe

Allocate your test budget according to the priorities below.
HIGH = primary focus, generate multiple targeted probes.
MEDIUM = meaningful coverage, at least 1-2 probes.
LOW = quick check only, probe if something obvious stands out.

### Correctness [{{concerns.correctness.weight}}]
{{#if concerns.correctness}}
- Edge cases in input validation: null, undefined, empty, boundary values
- Type coercion traps: string "0" vs number 0, empty array vs null
- Off-by-one errors in ranges, indices, pagination
- Error handling paths: does every throwable path have a handler?
{{/if}}

### Security [{{concerns.security.weight}}]
{{#if concerns.security}}
- Input validation bypasses: can crafted input reach unsafe operations?
- Injection vectors: SQL, command, path traversal through string inputs
- Type confusion: can a crafted type bypass validation logic?
- Unsafe deserialization: does the function accept untrusted serialized data?
{{/if}}

### Performance [{{concerns.performance.weight}}]
{{#if concerns.performance}}
- Algorithmic complexity: what happens with 10x, 100x, 1000x input size?
- Regex patterns: any risk of catastrophic backtracking?
- Memory allocation: does the function allocate proportional to input size?
- Blocking operations: any I/O or sleep in a potentially hot path?
{{/if}}

### Resilience [{{concerns.resilience.weight}}]
{{#if concerns.resilience}}
- Resource cleanup: are file handles, connections, locks released on error?
- Timeout handling: do external calls have timeouts?
- Graceful degradation: what happens when optional dependencies are missing?
- Partial failure: if this function is called in a batch, does one failure poison the batch?
{{/if}}
```

The weight tag (`[HIGH]`, `[MEDIUM]`, `[LOW]`) is visible to the agent in the rendered prompt, guiding how it allocates its probe budget across concerns. A concern set to `off` is omitted entirely — the agent never sees it. The prompt stays focused (the scope constrains context) while the weights tell the agent *where to invest its reasoning effort*.

### The Scope × Concern Matrix (with Default Weights)

This is the complete adversarial surface Bollard covers. The weight in each cell indicates default probe budget allocation:

```
                 Correctness       Security          Performance       Resilience
               ┌─────────────────┬─────────────────┬─────────────────┬─────────────────┐
  Boundary     │ HIGH             │ HIGH             │ LOW              │ LOW              │
  (function)   │ Edge cases,     │ Injection,      │ Complexity,     │ Cleanup,        │
               │ type errors,    │ validation      │ backtracking,   │ timeouts,       │
               │ off-by-one      │ bypass          │ allocation      │ degradation     │
               ├─────────────────┼─────────────────┼─────────────────┼─────────────────┤
  Contract     │ HIGH             │ MEDIUM           │ MEDIUM           │ MEDIUM           │
  (module)     │ Assumption      │ Privilege       │ N+1 queries,    │ Error prop,     │
               │ mismatch,       │ escalation,     │ chatty calls,   │ retry vs        │
               │ data flow       │ auth leak       │ lock contend    │ idempotency     │
               ├─────────────────┼─────────────────┼─────────────────┼─────────────────┤
  Behavioral   │ MEDIUM           │ HIGH             │ HIGH             │ HIGH             │
  (system)     │ System          │ Auth bypass,    │ Latency         │ Partial         │
               │ invariants,     │ CSRF, timing    │ under load,     │ outage,         │
               │ concurrency     │ attacks         │ pool exhaust    │ recovery        │
               └─────────────────┴─────────────────┴─────────────────┴─────────────────┘
```

Each cell is not a separate agent — it's a weighted section in the relevant scope agent's prompt. Three agents (one per scope), each covering all enabled concerns with probe budgets guided by weight. The weights are overridable per project and per scope in `.bollard.yml`.

---

## 5. Scope / Agent / Context Matrix (Updated)

| Dimension | Boundary | Contract | Behavioral |
|-----------|----------|----------|------------|
| **Defect classes** | Input edge cases, type violations, injection vectors, complexity traps, resource leaks | Cross-module assumption mismatch, privilege escalation, N+1 patterns, error propagation | System-wide failure modes, auth bypass at scale, latency degradation, partial outage recovery |
| **Concern lenses** | Correctness + Security + Performance + Resilience (all in one prompt) | Correctness + Security + Performance + Resilience (all in one prompt) | All four (may split into sub-agents if probe quality degrades) |
| **Agent prompt** | `boundary-tester.md` | `contract-tester.md` | `behavioral-tester.md` |
| **Context builder** | Type extractor (signatures + referenced types) | Dependency graph + interface extraction | Topology map + interface surface + config schema |
| **Primary execution** | In-language (import + call) | In-language or harness | Blackbox (HTTP/CLI/gRPC) + fault injection |
| **Fallback execution** | Blackbox via public API | Bollard harness (TypeScript) | Bollard harness (TypeScript) |
| **Docker isolation** | Optional (same container OK) | Recommended (separate container) | Required (fault injection needs container control) |
| **Typical test count** | 5–20 per changed function | 3–10 per module boundary | 5–15 per system behavior |
| **Cost estimate** | $0.50–2.00 per run | $1.00–4.00 per run | $2.00–8.00 per run |
| **Stage introduced** | Stage 2 (exists) | Stage 3 | Stage 4 |

---

## 6. Separate Agents Per Scope, Shared Concerns Per Prompt

Each scope gets its own `AgentDefinition` with its own system prompt, context-building pipeline, tool set, and temperature. This is a deliberate architectural choice, not a convenience.

**Why not one agent with a "scope" parameter?**

A single prompt that says "generate boundary tests, contract tests, and behavioral tests" would need to:
1. Switch reasoning strategies mid-generation (type-level reasoning vs. data-flow reasoning vs. system-level reasoning)
2. Maintain context for all three scopes simultaneously (signatures + dependency graphs + topology maps)
3. Produce outputs in potentially three different formats (in-language unit tests, integration harnesses, blackbox HTTP tests)

This is the recipe for drift and hallucination. The agent would anchor on whichever scope it understands best (typically boundary, since that's the most concrete) and produce shallow or formulaic output for the others. By splitting into three agents, each one gets a focused prompt, a focused context window, and a focused output format.

### Agent Definitions

```typescript
// Boundary tester (exists as current tester, renamed)
interface BoundaryTesterAgent extends AgentDefinition {
  role: "boundary-tester"
  // Sees: function signatures, type definitions, acceptance criteria
  // Produces: in-language test file(s) targeting individual function edge cases
  maxTurns: 5
  temperature: 0.3
}

// Contract tester (new)
interface ContractTesterAgent extends AgentDefinition {
  role: "contract-tester"
  // Sees: module dependency graph, interface definitions, data flow paths, error contracts
  // Produces: test file(s) that compose multiple modules and verify their assumptions align
  maxTurns: 10    // needs more turns — must reason about cross-module interactions
  temperature: 0.4 // slightly higher — contract violations require more creative reasoning
}

// Behavioral tester (new)
interface BehavioralTesterAgent extends AgentDefinition {
  role: "behavioral-tester"
  // Sees: system topology, public interface surface, config schema, failure mode catalog
  // Produces: blackbox test suite with fault injection scenarios
  maxTurns: 15    // most complex scope — must reason about system-wide interactions
  temperature: 0.5 // highest — behavioral failures require creative scenario construction
}
```

### Context Builders

Each scope has a dedicated context-building function that extracts and formats the information the agent needs:

```typescript
// Boundary context (exists — type extractor + signatures)
function buildBoundaryContext(
  changedFiles: string[],
  profile: ToolchainProfile,
  workDir: string,
): Promise<BoundaryContext>

// Contract context (new)
function buildContractContext(
  changedFiles: string[],
  profile: ToolchainProfile,
  workDir: string,
): Promise<ContractContext>
// Must extract: import graph, exported interfaces, error types at boundaries,
// data transformation chains

// Behavioral context (new)
function buildBehavioralContext(
  profile: ToolchainProfile,
  workDir: string,
  deploymentManifest?: DeploymentMetadata,
): Promise<BehavioralContext>
// Must extract: service topology, endpoint catalog, config schema,
// external dependency map, failure mode inventory
```

---

## 7. Integration Modes — Per Scope

For each adversarial scope, the developer (or Bollard's auto-detection) chooses how generated tests relate to the project's existing test infrastructure. This is configured per-scope because the right choice depends on both the scope and the project's test framework capabilities.

### Mode 1: Integrated

Adversarial tests are written to be runnable by the project's own test framework and placed in the project's test directory structure. They show up in `pytest -v`, `vitest run`, `go test ./...` alongside the developer's own tests.

**When this works well:** The project's test framework supports the scope's requirements. For boundary scope, almost any test framework works. For contract scope, the framework needs to support composing multiple modules (most do). For behavioral scope, the framework needs HTTP client capabilities, timeout control, and ideally fault injection — which many frameworks can do with the right libraries, but some can't.

**When this doesn't work:** The project's test framework is too limited for the scope (e.g., Go's `testing` package has no built-in HTTP server management for behavioral tests), or the project has no test infrastructure at all.

**Lifecycle options in integrated mode:**
- **Persistent:** Tests are written to `.bollard/tests/{scope}/{feature-slug}/` and configured so the project's test runner discovers them. They persist across runs and are replaceable per feature.
- **Ephemeral:** Tests are generated, executed via the project's test runner, results captured, tests discarded. Fresh generation each run.

### Mode 2: Independent

Bollard provides its own execution environment for the adversarial tests. The tests run in Bollard-controlled containers, separate from the project's test infrastructure. This is the fallback when integration isn't possible and the default for behavioral scope.

**When this is the right choice:** The project has no test framework. The test framework can't support the scope's requirements. The developer wants Bollard's adversarial tests to be completely decoupled from the project's CI. Behavioral scope with fault injection (always needs container control).

**Lifecycle options in independent mode:**
- **Persistent:** Tests are kept in `.bollard/tests/{scope}/{feature-slug}/` and run by Bollard's own runner. They persist across runs.
- **Ephemeral:** Tests are generated, executed in Bollard's container, results captured, tests discarded.

### Mode 3: Hybrid

The boundary and contract scopes run integrated (using the project's test framework), while the behavioral scope runs independent (using Bollard's container infrastructure). This is likely the most common configuration for mature projects.

### Auto-Detection Logic

Bollard selects the default mode per scope based on what it detects:

```
For each scope:
  1. Can the project's test framework support this scope?
     - Boundary: almost always yes → default to integrated
     - Contract: yes if framework supports multi-module imports → default to integrated
     - Behavioral: yes if framework + libraries support HTTP/fault injection → otherwise independent
  2. Does the project HAVE a test framework?
     - No → independent for all scopes (Bollard guarantees coverage)
  3. Did the developer override in .bollard.yml?
     - Yes → use their choice
```

The key guarantee: **regardless of mode, Bollard runs all configured scopes.** A project with zero test infrastructure still gets boundary + contract + behavioral adversarial verification — all running in Bollard's own containers.

---

## 8. Lifecycle: Ephemeral, Persistent, Promoted

Each scope's adversarial tests follow a lifecycle that determines how long they live and whether they become part of the project's permanent test suite.

### Ephemeral (Default)

Tests are generated fresh each pipeline run, executed, results captured, tests discarded. The test source is preserved in run artifacts for auditability but not in the project directory.

```
.bollard/runs/{run-id}/
  adversarial/
    boundary/
      auth-handler.test.ts          # generated, run, kept for audit
      results.json
    contract/
      auth-to-session.test.ts
      results.json
    behavioral/
      concurrent-auth-flow.test.ts
      results.json
```

**Advantages:** No file accumulation. No stale tests. Each run generates tests against the current code state. Zero maintenance burden.

**Disadvantages:** No regression coverage between runs. A defect found in run N might not be re-tested in run N+1 if the adversarial agent happens to probe different paths.

### Persistent

Tests are kept in the project directory (under `.bollard/tests/{scope}/`) and survive across runs. Each feature's tests are replaced when that feature is re-processed — so you always have the latest adversarial tests, but they don't accumulate endlessly.

```
.bollard/tests/
  boundary/
    {feature-slug}/
      auth-handler.test.ts
      _bollard.json                 # metadata: run ID, timestamp, scope, feature
  contract/
    {feature-slug}/
      auth-to-session.test.ts
      _bollard.json
  behavioral/
    {feature-slug}/
      concurrent-auth-flow.test.ts
      _bollard.json
```

**Advantages:** Regression coverage. Tests that found defects continue to guard against regression. Visible in PRs, auditable, committable.

**Disadvantages:** Tests can go stale if the code changes outside of Bollard's pipeline. Requires periodic regeneration.

### Promoted

A test that found a real defect can be **promoted** from adversarial to project-owned. Promotion moves the test from `.bollard/tests/` into the project's own test directory, strips Bollard metadata, and registers it as a Layer 1 test.

```bash
$ bollard promote .bollard/tests/contract/auth-retry/auth-to-session.test.ts

Promoting: auth-to-session.test.ts
  Scope: contract
  → Copying to: tests/contract/test-auth-to-session.ts
  → Stripping Bollard metadata
  → Verifying it runs under project test runner

Promoted. This test is now project-owned — Bollard runs it as Layer 1.
The contract-tester agent will be informed this coverage exists.
```

Once promoted, the test is the developer's responsibility. The adversarial agent is told (via plan context) that this coverage exists, so it focuses on finding new gaps rather than re-discovering the same defect.

### Per-Scope Lifecycle Defaults

| Scope | Default Lifecycle | Rationale |
|-------|------------------|-----------|
| Boundary | Persistent | Boundary tests are stable (tied to function signatures) and valuable as regression guards |
| Contract | Persistent | Contract tests catch subtle composition bugs that are worth keeping |
| Behavioral | Ephemeral | Behavioral tests depend on system state that changes frequently; regeneration is preferred |

These defaults are overridable per scope in `.bollard.yml`.

---

## 9. Configuration

### ToolchainProfile Extension

The existing `ToolchainProfile.adversarial` field expands from a flat `{ mode, runtimeImage? }` to a per-scope configuration:

```typescript
type AdversarialConcern = "correctness" | "security" | "performance" | "resilience"
type ConcernWeight = "high" | "medium" | "low" | "off"

interface ConcernConfig {
  correctness: ConcernWeight       // "off" disables, "high"/"medium"/"low" sets probe budget
  security: ConcernWeight
  performance: ConcernWeight
  resilience: ConcernWeight
}

// Default weights per scope (see Section 4 for rationale)
// Boundary:   { correctness: "high", security: "high", performance: "low", resilience: "low" }
// Contract:   { correctness: "high", security: "medium", performance: "medium", resilience: "medium" }
// Behavioral: { correctness: "medium", security: "high", performance: "high", resilience: "high" }

interface AdversarialScopeConfig {
  enabled: boolean
  integration: "integrated" | "independent"
  lifecycle: "ephemeral" | "persistent"
  // Per-scope concern weight overrides (inherits scope defaults if not set)
  concerns?: Partial<ConcernConfig>
  // For integrated mode: can the project's test framework handle this scope?
  frameworkCapable?: boolean          // auto-detected, overridable
  // For independent mode: what container image to use
  runtimeImage?: string              // e.g., "bollard/verify:latest"
}

interface AdversarialConfig {
  // Global concern weight overrides (applied before scope defaults)
  concerns?: Partial<ConcernConfig>
  // Per-scope configuration
  boundary: AdversarialScopeConfig
  contract: AdversarialScopeConfig
  behavioral: AdversarialScopeConfig
}

// Updated ToolchainProfile
interface ToolchainProfile {
  // ... existing fields ...

  adversarial: AdversarialConfig       // replaces the flat { mode, runtimeImage? }
}
```

**Weight resolution order:** scope-level override → global override → scope default matrix. For example, if the global config sets `security: "off"` but the boundary scope overrides it to `"high"`, boundary gets `"high"` and the other scopes get `"off"`.

### `.bollard.yml` Extension

```yaml
# .bollard.yml — adversarial scope overrides
adversarial:
  boundary:
    enabled: true                     # default: true
    integration: integrated           # default: auto-detected
    lifecycle: persistent             # default: persistent

  contract:
    enabled: true                     # default: true (from Stage 3)
    integration: integrated           # default: auto-detected
    lifecycle: persistent             # default: persistent

  behavioral:
    enabled: true                     # default: true (from Stage 4)
    integration: independent          # default: independent
    lifecycle: ephemeral              # default: ephemeral
    runtime_image: bollard/verify:latest
```

### `bollard init` Extension

```
$ bollard init

Detected:
  Language:         TypeScript
  Test framework:   Vitest
  ...

Adversarial scopes:
  Boundary:    enabled, integrated (Vitest), persistent
  Contract:    enabled, integrated (Vitest supports multi-module), persistent
  Behavioral:  enabled, independent (Docker), ephemeral

  Framework assessment:
    Vitest can handle boundary and contract scopes natively.
    Behavioral scope requires Docker isolation for fault injection.

? Override any scope settings? (most projects use the defaults)
  > No, use detected settings (recommended)
    Yes, customize
```

---

## 10. Blueprint Integration

The `implement-feature` blueprint evolves to run adversarial testing per scope. Scopes are additive — each stage adds a scope, and the pipeline runs all enabled scopes.

### Current pipeline (Stage 2)

```
1.  [deterministic] Create branch
2.  [agentic]       Generate plan
3.  [human_gate]    Approve plan
4.  [agentic]       Implement
5.  [deterministic] Static checks
6.  [deterministic] Extract signatures
7.  [agentic]       Generate boundary tests          ← single scope
8.  [deterministic] Write boundary tests
9.  [deterministic] Run all tests
10. [deterministic] Generate diff
11. [human_gate]    Approve PR
```

### Proposed pipeline (Stage 3+)

```
1.  [deterministic] Create branch
2.  [agentic]       Generate plan
3.  [human_gate]    Approve plan
4.  [agentic]       Implement
5.  [deterministic] Static checks
6.  [deterministic] Extract context (signatures + dependency graph + topology)
7.  [agentic]       Generate boundary tests           ← scope 1
8.  [deterministic] Write boundary tests
9.  [agentic]       Generate contract tests            ← scope 2 (Stage 3)
10. [deterministic] Write contract tests
11. [agentic]       Generate behavioral tests          ← scope 3 (Stage 4)
12. [deterministic] Write behavioral tests
13. [deterministic] Run all tests (Layer 1 + all scopes)
14. [deterministic] Mutation testing                   ← Stage 3
15. [agentic]       Semantic review                    ← Stage 3
16. [agentic]       Generate production probes         ← Stage 4
17. [deterministic] Generate diff
18. [human_gate]    Approve PR
```

Steps 7–12 run per enabled scope. Disabled scopes are skipped. The context extraction step (6) builds context for all enabled scopes in a single pass — extracting signatures, dependency graphs, and topology maps simultaneously.

### Parallelization Opportunity

Scopes 1, 2, and 3 are independent — they see different context and produce different outputs. Once context extraction is complete, all three adversarial agents could run in parallel. This is a natural fit for the parallel node execution planned for Stage 4's blueprint engine improvements.

---

## 11. Context Extraction — The Hard Part

Each scope requires different context, and building that context is the most technically challenging part of this design. The boundary scope's context builder (type extractor) already exists. The contract and behavioral scope context builders are new.

### Boundary Context (Exists)

Input: changed files, `ToolchainProfile`
Output: function signatures, type definitions, referenced types
Method: TS Compiler API (TypeScript), `ast` module (Python), `go doc` (Go), `cargo doc` (Rust), LLM fallback (others)

### Contract Context (New — Stage 3)

Input: changed files, `ToolchainProfile`, project source tree
Output: module dependency graph, interface definitions at boundaries, error propagation paths, data flow chains

**Extraction strategy:**
1. **Import graph:** Parse import/require/use statements across changed files and their direct dependents. This is language-specific but deterministic — AST parsing, not LLM inference.
2. **Boundary interfaces:** For each edge in the import graph, extract the exported types/functions that the importer actually uses. This is the "contract" — the assumptions the consumer makes about the provider.
3. **Error contracts:** What errors can each module throw? What does its consumer catch? Mismatches here are high-value contract-scope targets.
4. **Data flow:** Trace how a data structure transforms as it crosses module boundaries. If module A produces `{ status: string }` but module B expects `{ status: "ok" | "error" }`, that's a contract gap.

**Implementation:** Per-language extractors (similar to type extractor), with an LLM fallback for languages without good AST tooling. The LLM fallback receives the source of two modules and is asked to identify the contract between them — this is a focused, bounded query that LLMs handle well.

### Behavioral Context (New — Stage 4)

Input: `ToolchainProfile`, project source tree, deployment manifest (if available)
Output: system topology, endpoint catalog, config schema, external dependency map, failure mode inventory

**Extraction strategy:**
1. **Endpoint catalog:** Scan for HTTP route definitions, CLI command registrations, gRPC service definitions, event handler registrations. Language-specific patterns (Express `app.get()`, FastAPI `@app.get()`, Go `http.HandleFunc()`, etc.) — detectable by pattern matching, no LLM needed.
2. **Config schema:** Parse config files, env var references, and config validation code to build a map of what's configurable and what the defaults are.
3. **External dependency map:** Identify database connections, HTTP client instantiations, message queue connections, cache clients. These are the failure injection points.
4. **Failure mode inventory:** For each external dependency, enumerate the failure modes: timeout, connection refused, auth failure, rate limit, partial response. This is partially deterministic (known failure modes per dependency type) and partially LLM-assisted (project-specific failure modes).

**Implementation:** Hybrid — deterministic pattern matching for endpoints and dependencies, LLM-assisted for failure mode analysis and topology inference. The LLM sees only the public surface (no implementation bodies), consistent with the adversarial information barrier.

---

## 12. Stage Roadmap

With adversarial scopes and cross-cutting concerns, the forward-looking roadmap is:

| Stage | Focus |
|-------|-------|
| 2 | Boundary-scope adversarial testing + Docker isolation (no change) |
| 3 | Contract-scope adversarial testing + mutation testing + semantic review |
| 4 | Behavioral-scope adversarial testing + production feedback loop |
| 5 | Self-hosting + self-improvement |

### Rationale

**Stage 3 pairs contract scope with mutation testing and semantic review** because they share infrastructure: deeper type extraction (Python `ast`, Go `go doc`), cross-module analysis, and dependency graph context. Contract-scope adversarial testing is a natural extension of the signature extraction work, not a separate effort.

**Stage 4 pairs behavioral scope with the production feedback loop** because they share conceptual and technical foundations: Docker-level fault injection, system topology awareness, production-like execution environments, and the question "does the system behave correctly under realistic conditions?"

**Stage 5 is self-hosting.** By this point, Bollard has all three adversarial scopes, all four concern lenses, mutation testing, semantic review, and production observability. It's ready to build itself.

### Stage 3 — What to Build (Updated)

Everything in the current Stage 3 spec PLUS:

```
packages/
├── agents/
│   └── src/
│       └── contract-tester.ts       # NEW: contract-scope adversarial agent
│   └── prompts/
│       └── contract-tester.md       # NEW: contract-scope prompt
│
├── verify/
│   └── src/
│       └── contract-extractor.ts    # NEW: import graph, boundary interfaces, error contracts
│
└── blueprints/
    └── src/
        └── implement-feature.ts     # UPDATED: adds contract-scope adversarial steps
```

New context builder: `buildContractContext()` — extracts module dependency graph, boundary interfaces, error propagation paths.

New agent: `createContractTesterAgent(profile?)` — sees dependency graph + interface contracts, generates tests that compose multiple modules and verify their assumptions.

### Stage 4 — What to Build (Updated)

```
packages/
├── agents/
│   └── src/
│       └── behavioral-tester.ts     # NEW: behavioral-scope adversarial agent
│   └── prompts/
│       └── behavioral-tester.md     # NEW: behavioral-scope prompt
│
├── verify/
│   └── src/
│       └── behavioral-extractor.ts  # NEW: topology, endpoints, config, failure modes
│       └── fault-injector.ts        # NEW: Docker-level fault injection orchestration
│
├── observe/                          # Production feedback loop (Stage 4)
│   └── src/
│       ├── probe-runner.ts
│       ├── probe-scheduler.ts
│       ├── deployment-registry.ts
│       ├── drift-checker.ts
│       └── flag-manager.ts
│
└── docker/
    └── compose.behavioral.yml       # Behavioral test orchestration with fault injection
```

New context builder: `buildBehavioralContext()` — extracts system topology, endpoint catalog, config schema, external dependency map.

New agent: `createBehavioralTesterAgent(profile?)` — sees topology + public interfaces + failure mode catalog, generates blackbox tests with fault injection scenarios.

New infrastructure: `FaultInjector` — orchestrates Docker-level fault injection (network delays, connection drops, resource limits) during behavioral test execution.

---

## 13. The Guarantee

Bollard's promise to the developer:

> "Regardless of your test infrastructure, Bollard will adversarially verify your changes at every scope it can. If your test framework supports it, Bollard integrates. If it doesn't, Bollard provides its own. If you write no tests at all, Bollard still runs boundary, contract, and behavioral adversarial verification."

This is the table the developer sees after `bollard init`:

```
Adversarial verification plan:

  Scope        Mode          Lifecycle    Runner
  ─────────    ────────────  ──────────   ──────────────────
  Boundary     integrated    persistent   vitest (your framework)
  Contract     integrated    persistent   vitest (your framework)
  Behavioral   independent   ephemeral    bollard/verify (Docker)

  Concerns:    correctness ✓  security ✓  performance ✓  resilience ✓

  Total scopes enabled: 3/3
  Adversarial surface: 12 cells (3 scopes × 4 concerns)
  Estimated cost per run: $3.50–14.00
```

For a project with no test framework:

```
Adversarial verification plan:

  Scope        Mode          Lifecycle    Runner
  ─────────    ────────────  ──────────   ──────────────────
  Boundary     independent   persistent   bollard/verify (Docker)
  Contract     independent   persistent   bollard/verify (Docker)
  Behavioral   independent   ephemeral    bollard/verify (Docker)

  Concerns:    correctness ✓  security ✓  performance ✓  resilience ✓

  ⚠ No test framework detected. Bollard will provide all test infrastructure.
  Consider adding a test framework — promoted adversarial tests integrate better.

  Total scopes enabled: 3/3
  Adversarial surface: 12 cells (3 scopes × 4 concerns)
  Estimated cost per run: $4.00–16.00
```

---

## 14. Design Principles (Extending the Existing Set)

11. **One agent, one adversarial concern.** Each scope gets its own agent with its own prompt, context, and output format. Overloading a single agent with multiple scopes guarantees drift toward the most concrete scope and hallucination in the others.

12. **Bollard guarantees coverage, not the developer.** If the developer's test infrastructure can't support a scope, Bollard provides its own. The developer never needs to set up integration test infrastructure "just for Bollard."

13. **Scope is about the defect class, not the technology.** "Boundary" doesn't mean "unit test." "Contract" doesn't mean "integration test." "Behavioral" doesn't mean "end-to-end test." Each scope hunts a specific class of defect using whatever execution strategy is most effective.

14. **Integration is preferred, independence is guaranteed.** When the project's test framework can support a scope, Bollard uses it — tests are more idiomatic, more maintainable, and more likely to be promoted. When it can't, Bollard runs independently rather than skipping the scope.

15. **Concerns are lenses, not scopes.** Security, performance, and resilience are not additional scopes — they don't change what the agent sees. They change what it looks for within the context it already has. Each scope agent carries all enabled concern lenses in its prompt. This keeps the agent count at three (one per scope) while covering a 3×4 adversarial surface.

---

## 15. Open Questions

1. **Should scopes be independently disableable per run?** E.g., `bollard run implement-feature --scopes boundary,contract` to skip behavioral during development iteration. Likely yes, with all scopes enabled by default.

2. **How does mutation testing interact with scopes?** Currently, mutation testing runs against "both test suites" (Layer 1 + Layer 2). With three scopes, mutation testing should run against Layer 1 + all adversarial scope outputs. A mutation that survives all four test suites is a genuine coverage gap.

3. **Should the contract-scope agent see the boundary-scope test results?** There's an argument for cascading: if boundary tests found an edge case, the contract agent should know so it doesn't redundantly test the same thing at a higher scope. Counter-argument: independence between scopes prevents anchoring. Leaning toward independence.

4. **Cost management with three scopes.** Three adversarial agents per pipeline run approximately triples the LLM cost. This needs careful budgeting — possibly with scope-level cost caps that are deducted from the overall `maxCostUsd` budget. Boundary scope gets the smallest budget (simplest reasoning), behavioral gets the largest.

5. **Incremental scope adoption.** Projects adopting Bollard should be able to start with boundary scope only and add contract + behavioral as they gain confidence. The `.bollard.yml` scope enables/disables make this straightforward, but the UX of "you're not using all scopes" needs to be informative, not nagging.

6. **When to split behavioral sub-agents.** The spec allows the behavioral scope to split into sub-agents (correctness+resilience, security, performance) when probe quality degrades. What's the metric for "degraded"? Likely: mutation survival rate per concern, or human review of probe quality during early runs. This needs empirical data before we can set a threshold.

7. **Concern-specific tooling at behavioral scope.** Security behavioral tests may benefit from specialized tools (OWASP ZAP, fuzzing frameworks). Performance behavioral tests may need load generators (k6, wrk, vegeta). Should these be detected/configured in the ToolchainProfile, or are they always Bollard-provided? Leaning toward Bollard-provided initially, with detection for project-installed tools as an optimization.

8. **Concern weighting in mutation testing.** Should mutation testing score be broken down per concern? E.g., "80% overall mutation score, but only 40% of security-relevant mutations caught" would be more actionable than a single number. This requires classifying mutations by concern — possible but adds complexity.

---

## 16. Changes Required in Existing Specs

### 01-architecture.md
- The verification layer diagram needs the three-scope model alongside the three-layer model (layers are about *what verifies*; scopes are about *what class of defect is targeted*).
- The `AgentDefinition` roster needs contract-tester and behavioral-tester entries.

### 02-bootstrap.md
- Historical document — no changes needed. The stage roadmap in this spec (Section 12) is the forward-looking reference.

### 04-configuration.md
- The verification layers table needs a "scope" column.
- The `.bollard.yml` schema gains the `adversarial.{scope}` sections.

### 06-toolchain-profiles.md
- Section 2 (Three-Layer Verification Model) needs a forward reference to this spec for the scope dimension.
- Section 5 (ToolchainProfile) needs the `AdversarialConfig` type update.
- Section 13 (Generated Test Location and Lifecycle) needs per-scope lifecycle descriptions.

---

## Implementation status (Stage 3a)

**Landed in codebase:** per-scope `AdversarialConfig` with concern weights; root + legacy `.bollard.yml` adversarial merge; `boundary-tester` agent (renamed from tester) with `{{#concern}}` templating; deterministic `SignatureExtractor` routing for TypeScript, Python, Go, and Rust; TypeScript contract graph (`buildContractContext`) plus `contract-tester` agent; `implement-feature` blueprint nodes `extract-contracts`, `generate-contract-tests`, `write-contract-tests`, `run-contract-tests`; CLI `bollard contract` and MCP `bollard_contract`; contract test output paths via `resolveContractTestOutputRel` (persistent vs ephemeral).

**Not in Stage 3a:** behavioral scope, mutation testing, semantic review, multi-language contract graphs beyond TypeScript, `promote-test` for contract outputs.

---

*Bollard: three scopes (boundary, contract, behavioral) × four concerns (correctness, security, performance, resilience). Twelve adversarial lenses, three agents, one guarantee — adversarial verification at every scale, for every class of defect, regardless of what the developer's own test infrastructure provides.*
