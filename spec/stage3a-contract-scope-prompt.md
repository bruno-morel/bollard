# Stage 3a — Contract Scope Bundle

> Cursor prompt for the first slice of Stage 3. Builds the contract-scope adversarial tester end-to-end, plus the two pieces of infrastructure it depends on (deterministic type extractors for non-TS languages, and weighted concern lenses).
>
> **Out of scope for this pass:** mutation testing, semantic review agent, behavioral scope. Those are Stage 3b/3c/4.

## Source of truth

Read these BEFORE writing any code:
- `CLAUDE.md` — current architecture, conventions, "do not build yet" list
- `spec/06-toolchain-profiles.md` — three-layer verification, ToolchainProfile design
- `spec/07-adversarial-scopes.md` — **§3 (scopes), §4 (concerns + weights), §6 (separate agents per scope), §9 (config), §10 (blueprint), §11 (context extraction)**

When in doubt, the spec wins. If the spec and this prompt disagree, stop and flag it.

## Non-negotiables (carry over from Stage 0–2)

- Run **everything** through `docker compose run --rm dev ...` — never bare `pnpm`/`node`/`tsc`/`vitest`/`biome` on the host.
- TypeScript strict mode, `exactOptionalPropertyTypes`, no `any`, named exports only, no semicolons (Biome).
- All errors via `BollardError` with codes; never raw `Error`.
- Tests for every source file, in `packages/<pkg>/tests/`. Use `MockProvider` for any LLM-touching test.
- No new runtime dependencies unless absolutely required. If you need one, justify it in a comment and confirm it's not already in the workspace.
- Path-traversal protection for any new tool/extractor that touches the filesystem.

## Goal

After this pass, `bollard run implement-feature` produces three layers of adversarial coverage:
1. **Boundary scope** (Stage 2, retrofitted with concern lenses)
2. **Contract scope** (NEW — package-level interface contracts between modules)
3. Layer 1 project tests (existing)

And the foundation for Stage 3b/c/Stage 4 is in place: deterministic type extractors for Python/Go/Rust, a per-scope `AdversarialConfig` shape, weighted concern blocks in agent prompts.

---

## Phase 1 — Profile shape migration: per-scope `AdversarialConfig` with concern weights

**Files:** `packages/detect/src/types.ts`, `packages/detect/src/derive.ts` (new helpers), all per-language detectors, all tests that construct profiles.

### 1.1 New types in `packages/detect/src/types.ts`

```typescript
export type AdversarialScope = "boundary" | "contract" | "behavioral"
export type AdversarialConcern = "correctness" | "security" | "performance" | "resilience"
export type ConcernWeight = "high" | "medium" | "low" | "off"

export interface ConcernConfig {
  correctness: ConcernWeight
  security: ConcernWeight
  performance: ConcernWeight
  resilience: ConcernWeight
}

export interface AdversarialScopeConfig {
  enabled: boolean
  integration: "integrated" | "independent"
  lifecycle: "ephemeral" | "persistent"
  concerns: ConcernConfig
  frameworkCapable?: boolean
  runtimeImage?: string
  /** Existing semantics from Stage 2 — only used by boundary scope today */
  mode?: "blackbox" | "in-language" | "both"
}

export interface AdversarialConfig {
  boundary: AdversarialScopeConfig
  contract: AdversarialScopeConfig
  behavioral: AdversarialScopeConfig
}

// Updated ToolchainProfile.adversarial:
//   adversarial: AdversarialConfig    (replaces flat { mode, runtimeImage?, persist? })
```

### 1.2 Default weight matrix (spec §4)

Add `packages/detect/src/concerns.ts`:

```typescript
export const DEFAULT_CONCERN_WEIGHTS: Record<AdversarialScope, ConcernConfig> = {
  boundary:   { correctness: "high",   security: "high",   performance: "low",    resilience: "low"    },
  contract:   { correctness: "high",   security: "medium", performance: "medium", resilience: "medium" },
  behavioral: { correctness: "medium", security: "high",   performance: "high",   resilience: "high"   },
}

export function defaultAdversarialConfig(profile: { language: LanguageId }): AdversarialConfig {
  return {
    boundary:   { enabled: true,  integration: "integrated",  lifecycle: "persistent", concerns: { ...DEFAULT_CONCERN_WEIGHTS.boundary },   mode: "in-language" },
    contract:   { enabled: true,  integration: "integrated",  lifecycle: "persistent", concerns: { ...DEFAULT_CONCERN_WEIGHTS.contract } },
    behavioral: { enabled: false, integration: "independent", lifecycle: "ephemeral",  concerns: { ...DEFAULT_CONCERN_WEIGHTS.behavioral } },
  }
}
```

`behavioral.enabled = false` by default until Stage 4 — we don't want the blueprint to try running it yet.

### 1.3 Migrate every detector and every test fixture

Search for `adversarial: {` in `packages/**/src` and `packages/**/tests` and update each construction site to use `defaultAdversarialConfig(...)` (overriding fields where the test/detector needs something specific).

The Stage 2 fields `mode` and `persist` are absorbed into the per-scope config:
- Old `mode` becomes `boundary.mode`.
- Old `persist: true` becomes `boundary.lifecycle: "persistent"` (the new default anyway).
- Old `persist: false` or unset becomes `boundary.lifecycle: "ephemeral"` only if a detector explicitly opted out.

### 1.4 New error code

Add `CONCERN_CONFIG_INVALID` to `BollardErrorCode` in `packages/engine/src/errors.ts`. Used when a `.bollard.yml` override produces an invalid weight or unknown scope.

### 1.5 Tests

- `packages/detect/tests/concerns.test.ts`: defaults match the matrix in spec §4, override resolution order is `scope override → global override → default matrix`.
- All existing detect tests still pass after migration.

---

## Phase 2 — `.bollard.yml` schema + CLI surfacing

**Files:** `packages/cli/src/config.ts`, `packages/cli/src/diff.ts`, `packages/cli/src/index.ts` (init output), tests.

### 2.1 YAML schema

Extend the existing `.bollard.yml` parser to accept (all fields optional):

```yaml
adversarial:
  concerns:                        # global overrides applied before scope defaults
    security: high
    performance: low
  boundary:
    enabled: true
    integration: integrated        # integrated | independent
    lifecycle: persistent          # persistent | ephemeral
    mode: in-language              # blackbox | in-language | both
    concerns:
      security: off                # per-scope wins over global
  contract:
    enabled: true
    integration: integrated
    lifecycle: persistent
  behavioral:
    enabled: false
```

Use Zod to validate. Reject unknown scope names and unknown weight values with `CONCERN_CONFIG_INVALID`.

Resolution order (implement and test): **scope override → global override → scope default matrix**. Document this in code with a one-line comment that points to spec §4.

### 2.2 `bollard init` output

Extend the detection summary to print, for each scope:
- enabled / disabled
- integration mode (and whether the project's test framework is `frameworkCapable` for that scope)
- lifecycle
- enabled concern lenses with their weights

For Stage 3a, `frameworkCapable` for the contract scope is always `true` for languages whose deterministic extractor exists (TS/Python/Go/Rust) and `false` otherwise.

### 2.3 `bollard config show` and `bollard diff`

Both must render the new shape correctly. `diff` should compare the resolved profile against `defaultAdversarialConfig(...)` for the detected language and only show fields that differ.

### 2.4 Tests

- `packages/cli/tests/config.test.ts`: weight resolution order, invalid YAML rejection, behavioral disabled by default.
- Snapshot test for `bollard init` output of a TypeScript project showing all three scopes.

---

## Phase 3 — Boundary tester retrofit with weighted concern blocks

**Files:** `packages/agents/prompts/tester.md` → rename to `boundary-tester.md`, `packages/agents/src/tester.ts` → rename to `boundary-tester.ts` and rename `createTesterAgent` → `createBoundaryTesterAgent`. Update all imports (blueprint, CLI handler, tests).

### 3.1 Extend `fillPromptTemplate`

Today it handles `{{var}}` and `{{#if isPython}}...{{/if}}`. Add support for **weighted concern blocks**:

```
### Security [{{concerns.security.weight}}]
{{#concern security}}
- Input validation bypasses: ...
- Injection vectors: ...
{{/concern}}
```

Rules:
- `{{concerns.<concern>.weight}}` renders as `HIGH`, `MEDIUM`, `LOW`, or — when off — the entire `### …` line plus `{{#concern X}}…{{/concern}}` block is removed.
- The function takes a second optional argument: `fillPromptTemplate(template, profile, scopeConcerns?: ConcernConfig)`. When `scopeConcerns` is omitted, every concern block is stripped (so existing call sites don't break before they're updated).

Add `packages/agents/tests/prompt-template.test.ts` cases covering: all-high, mixed weights, one-off, all-off.

### 3.2 Boundary tester prompt sections

In `boundary-tester.md` add four `### Correctness/Security/Performance/Resilience` sections matching spec §4's example. The agent receives the rendered prompt with weight tags visible (`[HIGH]`, `[MEDIUM]`, `[LOW]`) — this is intentional, it guides probe budget allocation.

`createBoundaryTesterAgent(profile?)` now reads `profile?.adversarial.boundary.concerns` and threads it into `fillPromptTemplate`.

### 3.3 Eval cases

Add at least one eval case in `packages/agents/src/evals/boundary-tester/cases.ts` (you'll need to create this directory; the existing eval framework already supports per-agent case files) that checks the rendered prompt contains the expected concern sections for a TS profile.

### 3.4 Update existing tester tests

`packages/agents/tests/tester.test.ts` → `boundary-tester.test.ts`. All assertions still hold; add cases for the new concern-block rendering.

---

## Phase 4 — Deterministic type extractors for Python, Go, Rust

**Files:** `packages/verify/src/extractors/python.ts`, `go.ts`, `rust.ts`, plus tests + fixtures.

These implement the existing `SignatureExtractor` interface. They must produce `ExtractionResult` with the same shape as `TsCompilerExtractor` (signatures + referenced type definitions). No LLM calls — pure parsing.

### 4.1 Python — `PythonAstExtractor`

Use Python's stdlib `ast` module via a subprocess. Ship a small helper script at `packages/verify/scripts/extract_python.py`:

```python
# Reads file paths from argv, prints ExtractionResult JSON to stdout.
# Extracts:
#   - Top-level def / async def signatures (no body)
#   - Class definitions with method signatures (private methods _foo are excluded)
#   - Type aliases (X = SomeType, X: TypeAlias = ...)
#   - TypedDict / Protocol / dataclass definitions
#   - Referenced type names from annotations, resolved within the same file
```

The TypeScript `PythonAstExtractor` calls `python3` (or `profile.allowedCommands` python entry) with the helper script and parses the JSON. Skip files where the python interpreter is unavailable and surface the warning via the same `warn` callback `LlmFallbackExtractor` uses.

**Path-traversal protection:** all input file paths must resolve under a workDir prefix passed to the extractor.

### 4.2 Go — `GoAstExtractor`

Use `go doc -all -short <pkg>` and `go list -json` from a subprocess. For each file in the input set:
1. Resolve its package via `go list -json -find ./...`.
2. Run `go doc -all <importpath>` to dump the public API.
3. Parse the output (it's stable, line-prefixed) for `func`, `type`, `const`, `var`.
4. Reference resolution: for each type used in a signature that's defined elsewhere in the same module, fetch it via `go doc <importpath>.<TypeName>`.

If `go` is not in `profile.allowedCommands`, emit a `warn` and return empty.

### 4.3 Rust — `RustExtractor`

Two viable paths — pick the simpler one and document why in a comment at the top of the file:

**Option A (preferred):** `cargo +nightly rustdoc -- --output-format json` and parse the rustdoc JSON. Pure data, no parsing brittleness. Downside: requires nightly toolchain.

**Option B (fallback):** Parse files line-by-line for `pub fn`, `pub struct`, `pub enum`, `pub trait`, `pub type` declarations, terminating signatures at `{` or `;`. Less accurate (doesn't handle attribute macros that rewrite signatures) but works on stable.

Start with Option B for the default extractor, and leave a TODO + design note for switching to Option A in Stage 3b. Tests for Option B can use a fixture crate with a handful of public items.

### 4.4 Wire into `getExtractor`

`packages/verify/src/type-extractor.ts`:

```typescript
export function getExtractor(
  lang: LanguageId,
  provider?: LLMProvider,
  model?: string,
  warn?: (msg: string) => void,
): SignatureExtractor {
  switch (lang) {
    case "typescript": return new TsCompilerExtractor()
    case "python":     return new PythonAstExtractor(warn)
    case "go":         return new GoAstExtractor(warn)
    case "rust":       return new RustExtractor(warn)
    default:
      if (!provider) throw new BollardError({ code: "PROVIDER_NOT_FOUND", message: `No deterministic extractor for ${lang} and no LLM provider supplied` })
      return new LlmFallbackExtractor(provider, model, warn)
  }
}
```

`LlmFallbackExtractor` stays in the file but only handles unknown languages now.

### 4.5 Fixtures + tests

Add `packages/verify/tests/fixtures/extractors/`:
- `python/sample.py` with: a public function, a private `_helper`, a class with public + private methods, a TypedDict, a dataclass, a type alias.
- `go/sample/sample.go` with: an exported func, an unexported func, an exported struct with methods, an exported interface, a type alias.
- `rust/sample/src/lib.rs` with: a `pub fn`, a private `fn`, a `pub struct`, a `pub trait`, a `pub enum`.

For each language, write a test that:
1. Runs the extractor against the fixture.
2. Asserts public items are present.
3. Asserts private items are absent (no leakage).
4. Asserts referenced types are resolved.

These tests gracefully skip (`it.skip` with a clear message) when the language toolchain is not available in the dev image. Document in `Dockerfile` what tooling needs to be installed for the tests to run end-to-end (Python 3 already exists; Go and Rust may need adding — if so, install only the minimum needed).

---

## Phase 5 — Contract context builder (`@bollard/verify`)

**File:** `packages/verify/src/contract-extractor.ts`, plus tests.

This is the headline new piece. It produces the context the contract-tester agent needs.

### 5.1 Output type

```typescript
export interface ModuleNode {
  /** Stable identifier — for TS this is the workspace package name; for Python the importable package; for Go the import path; for Rust the crate name */
  id: string
  language: LanguageId
  rootPath: string                                  // absolute path to package root
  publicExports: ExtractedSignature[]               // exported functions + types
  errorTypes: string[]                              // exported error/exception types this module declares
}

export interface ContractEdge {
  from: string                                       // ModuleNode.id
  to: string
  /** Symbols the consumer actually uses from the provider */
  importedSymbols: string[]
  /** Errors the provider declares that the consumer should handle */
  providerErrors: string[]
  /** Errors the consumer actually catches at the call sites (best-effort) */
  consumerCatches: string[]
}

export interface ContractContext {
  modules: ModuleNode[]
  edges: ContractEdge[]
  /** Edges that touch files in the plan's affected_files list — the agent will focus here */
  affectedEdges: ContractEdge[]
}

export async function buildContractContext(
  affectedFiles: string[],
  profile: ToolchainProfile,
  workDir: string,
): Promise<ContractContext>
```

### 5.2 Granularity (per the design decision)

Module boundaries are at the **package/workspace-package level**, not file level:
- TypeScript: each `pnpm` workspace package (`packages/<name>` with its own `package.json`).
- Python: each top-level package (directory containing `__init__.py` directly under a source root, or each entry in `pyproject.toml`'s `tool.poetry.packages` / `tool.setuptools.packages`).
- Go: each Go package (one directory = one package).
- Rust: each crate (each `Cargo.toml`).

A change inside `packages/agents/src/coder.ts` produces edges between `@bollard/agents` and any other workspace package that imports from `@bollard/agents`.

### 5.3 Extraction strategy (spec §11)

Per-language `ImportGraphExtractor` interface:

```typescript
interface ImportGraphExtractor {
  buildGraph(workDir: string, profile: ToolchainProfile): Promise<{ modules: ModuleNode[]; edges: ContractEdge[] }>
}
```

Per-language implementations:

- **TypeScript:** read every workspace package's `package.json`. For each, walk source files, parse imports with the TS Compiler API (already a dep), resolve `@bollard/<x>` specifiers to module IDs, collect symbol names. Reuse `TsCompilerExtractor` for `publicExports`. For `errorTypes` heuristic: any exported type whose name ends in `Error` or that extends `Error` / `BollardError`. For `consumerCatches`: at each call site of an imported symbol, walk up the AST to the nearest enclosing `try` and record the caught error type names.
- **Python:** parse each package's source via the Python AST helper (extend `extract_python.py` with a `--graph` mode). Imports of the form `from pkg.x import Y` produce edges. `errorTypes` = exported classes inheriting from `Exception`. `consumerCatches` = `except SomeError as e:` clauses near call sites.
- **Go:** `go list -deps -json ./...` gives the import graph for free. For each package, `go doc -all` enumerates public symbols (already used by `GoAstExtractor`). Errors are types implementing `error` (heuristic: type name ends in `Error` or has a method `Error() string`).
- **Rust:** parse `cargo metadata --format-version 1` for the crate dependency graph. `pub use` and `pub fn`/`pub struct` for public exports. `errorTypes` = types whose name ends in `Error` or that derive `thiserror::Error`. Catches are `match` arms on `Result::Err` — best effort, mark a TODO if it gets messy.

For each language, if the toolchain isn't installed, return an empty graph and `warn(...)`. The contract-tester agent should still run with whatever it has.

### 5.4 `affectedEdges` filter

After building the full graph, intersect `affectedFiles` (from `ctx.plan.affected_files`) with each module's source files to identify "touched" modules. `affectedEdges` = edges where at least one endpoint is a touched module. The agent prompt highlights these.

### 5.5 Information barrier

`ContractContext` must NEVER include implementation bodies. Only signatures + error type names + symbol lists. Test this explicitly: build a context for a fixture that contains a unique private identifier and assert the identifier never appears anywhere in the serialized `ContractContext`.

### 5.6 Tests

`packages/verify/tests/contract-extractor.test.ts`:
- Build a graph for the bollard repo itself (TypeScript). Assert known edges exist (e.g., `@bollard/blueprints → @bollard/verify`, `@bollard/cli → @bollard/agents`).
- Use `affectedFiles = ["packages/verify/src/dynamic.ts"]` and assert `affectedEdges` includes the edge from `@bollard/blueprints` to `@bollard/verify` (because `implement-feature.ts` imports `runTests` from `@bollard/verify`).
- Information leak test as in 5.5.
- One small Python fixture and one small Go fixture, each gracefully skipping if the toolchain isn't in the dev image.

---

## Phase 6 — Contract tester agent

**Files:** `packages/agents/src/contract-tester.ts`, `packages/agents/prompts/contract-tester.md`, `packages/agents/src/evals/contract-tester/cases.ts`, tests.

### 6.1 Agent definition

```typescript
export function createContractTesterAgent(profile?: ToolchainProfile): AgentDefinition {
  const concerns = profile?.adversarial.contract.concerns
  return {
    role: "contract-tester",
    systemPrompt: fillPromptTemplate(loadPrompt("contract-tester.md"), profile ?? FALLBACK_PROFILE, concerns),
    tools: [],                  // no tools — pre-seeded context only
    maxTurns: 10,
    temperature: 0.4,
  }
}
```

`maxTurns: 10` and `temperature: 0.4` per spec §6 — contract reasoning needs more turns and slightly more creativity than boundary.

### 6.2 Prompt: `contract-tester.md`

Skeleton (copy from spec §4 example, adapt for contract scope):

```markdown
# Role

You are a contract-scope adversarial tester in the Bollard verification pipeline. Your job is to find defects that live BETWEEN modules — places where two correct modules compose into something broken.

# What You Receive (pre-seeded, do not call read_file)

- The plan summary and acceptance criteria
- A module dependency graph (which packages import which)
- For each affected module: its public exports (signatures + type definitions)
- Contract edges: for each import relationship, the symbols the consumer uses, the errors the provider declares, and the errors the consumer catches
- The list of affectedEdges — focus your probes here

# What You Do NOT Receive

- Implementation bodies of any function
- Internal helpers or private members
- The coder's reasoning
- Existing integration tests

# What to Probe

Allocate your test budget according to the priorities below.
HIGH = primary focus, generate multiple targeted probes.
MEDIUM = meaningful coverage, at least 1-2 probes.
LOW = quick check only.

### Correctness [{{concerns.correctness.weight}}]
{{#concern correctness}}
- Assumption mismatches: provider returns Foo | null, consumer assumes Foo
- Data flow gaps: type narrowing on one side that the other side doesn't honor
- Sequencing assumptions: consumer calls A then B, but B requires state from C
{{/concern}}

### Security [{{concerns.security.weight}}]
{{#concern security}}
- Auth tokens passed across module boundaries without re-validation
- Trust violations: module A trusts module B's input without verifying
- TOCTOU between authorization check and resource access
{{/concern}}

### Performance [{{concerns.performance.weight}}]
{{#concern performance}}
- N+1 query patterns emerging from composition
- Chatty inter-module calls where a batch would suffice
- Lock contention between modules sharing a resource
{{/concern}}

### Resilience [{{concerns.resilience.weight}}]
{{#concern resilience}}
- Errors from provider that consumer does NOT catch (use providerErrors vs consumerCatches)
- Retry behavior in caller vs idempotency in callee
- Cascade failure: does one module's failure crash the entire chain?
{{/concern}}

# Output Format

Output ONLY a single test file. Use the project's test framework ({{testFramework}}).

{{#if isTypeScript}}
```typescript
import { describe, it, expect } from "vitest"
// Import from the public APIs of the modules under test
```
{{else if isPython}}
```python
import pytest
# Import from the public APIs of the modules under test
```
{{/if}}
```

The agent receives a `userMessage` constructed by the contract-tester executor that lists modules, edges, and affectedEdges in compact form. Build that message in `executeContractTester` (similar to `buildTesterMessage`).

### 6.3 Information leak guard

Reuse the `extractPrivateIdentifiers` from `packages/verify/src/type-extractor.ts`. After the agent returns, scan the output for any private identifier from any module in the context. If a leak is detected, `throw new BollardError({ code: "POSTCONDITION_FAILED", message: "Information leak in contract tests", context: { leakedTokens } })`.

### 6.4 Eval cases

`packages/agents/src/evals/contract-tester/cases.ts`: at least 2 cases. Use a small synthetic context (one or two modules + an edge) and assert the rendered output:
- Imports from public APIs only
- References at least one symbol from `affectedEdges`
- Mentions at least one of the providerErrors in a test name or assertion

### 6.5 Tests

`packages/agents/tests/contract-tester.test.ts`:
- Prompt loads and renders with a sample profile
- Concern blocks honor weights
- Tool list is empty
- maxTurns / temperature match spec
- Information leak guard rejects output containing a private identifier from the context

---

## Phase 7 — Blueprint integration

**Files:** `packages/blueprints/src/implement-feature.ts`, `packages/blueprints/src/write-tests-helpers.ts` (extend), tests.

### 7.1 New nodes

Insert between the existing `run-tests` (Stage 2 boundary tests) and `docker-verify`:

```
9.  run-tests              (existing — runs Layer 1 + boundary)
10. extract-contracts      NEW — deterministic — buildContractContext
11. generate-contract-tests NEW — agentic — contract-tester
12. write-contract-tests   NEW — deterministic — leak check + write to disk
13. run-contract-tests     NEW — deterministic — runs only contract test files via profile.checks.test
14. docker-verify          (existing, position shifted)
15. generate-diff          (existing)
16. approve-pr             (existing)
```

Skip nodes 10–13 entirely if `ctx.toolchainProfile.adversarial.contract.enabled === false`. Use `status: "ok"` with `data: { skipped: true, reason: "contract scope disabled" }`.

### 7.2 Test placement

Extend `deriveAdversarialTestPath` in `write-tests-helpers.ts` to take a `scope: AdversarialScope` argument:
- Boundary tests (existing behavior, default): `tests/<feature>.adversarial.test.ts` etc.
- Contract tests: `tests/contracts/<feature>.contract.test.ts` (TS), `tests/contracts/test_<feature>_contract.py` (Python), `<pkg>/contract_test.go` (Go), `tests/contracts/<feature>.rs` (Rust).

Update existing call sites to pass `"boundary"` explicitly. Add tests for the new path derivations in `write-tests-helpers.test.ts`.

### 7.3 Lifecycle

Honor `profile.adversarial.contract.lifecycle`:
- `persistent`: write to `.bollard/tests/contract/<feature-slug>/` with `_bollard.json` metadata (reuse `writeTestMetadata` from `test-lifecycle.ts`).
- `ephemeral`: write to `.bollard/runs/<runId>/adversarial/contract/`, run, capture results.

### 7.4 `run-contract-tests` node

Filter the test runner to only the freshly written contract test files. For Vitest, that's an extra positional arg. For pytest, use `--rootdir` + the explicit file path. For `go test`, run only the touched packages. For Rust, `cargo test --test <name>`.

If the framework can't be filtered (rare), run the full test suite and parse out the contract results — tag them with a `bollard-contract` describe block prefix that the test file enforces. (Mark this as a post-MVP optimization with a TODO.)

### 7.5 Tests

`packages/blueprints/tests/implement-feature.test.ts`:
- New node count and ordering
- Contract nodes are skipped when `contract.enabled = false`
- Contract nodes appear when `contract.enabled = true`

---

## Phase 8 — `@bollard/mcp` and CLI surface

**Files:** `packages/mcp/src/tools.ts`, `packages/cli/src/index.ts`.

- Add a `bollard contract` CLI subcommand: builds a `ContractContext` for the current workdir + plan affected_files (from a `--plan` JSON file or the most recent run) and prints it as JSON. Useful for debugging the extractor.
- Extend the MCP `profile` tool's output to include the new `AdversarialConfig` shape.
- Add a new MCP tool `contract` that mirrors the CLI subcommand.

Tests for both should follow the patterns already in `packages/mcp/tests/tools.test.ts` and `packages/cli/tests/`.

---

## Phase 9 — Documentation + housekeeping

### 9.1 `CLAUDE.md`

Update the following sections to reflect Stage 3a:
- "What works right now": add `bollard contract` example
- "Known limitations": remove items that are now done (deterministic Python/Go/Rust extractors, single boundary scope), add new ones (no mutation testing yet, no semantic review yet, no behavioral scope yet, contract-tester does not yet probe behavioral concerns)
- Project structure: add the new files
- "Stage 2" stays as is. Add a new "Stage 3a" subsection under "Scope Control" listing what was built
- "DO NOT build yet" list: shrink it (remove contract scope items, weighted concerns, deterministic extractors)
- "Current Test Stats" / "Validation": leave a placeholder for the post-implementation update — Cursor will fill this in at the end

### 9.2 `spec/07-adversarial-scopes.md`

No content changes — the spec stays the source of truth. Just append a small "Implementation status" footer noting which sections are now built (Stage 3a) and which remain (Stage 3b: mutation, semantic review; Stage 4: behavioral).

### 9.3 README / ROADMAP

If `spec/ROADMAP.md` is the user-facing roadmap, mark contract scope as ✅.

### 9.4 `.bollard.yml` example

Add a fully-commented example file at `examples/bollard.yml` (create the directory if it doesn't exist) showing the new adversarial config shape with all default weights. Reference it from `bollard init` output ("see examples/bollard.yml for all options").

---

## Phase 10 — Verification

Run, in this order, **all in Docker**:

1. `docker compose run --rm dev run typecheck` — must pass with zero errors.
2. `docker compose run --rm dev run lint` — must pass with zero errors. Run `docker compose run --rm dev run format` first if needed.
3. `docker compose run --rm dev run test` — all tests must pass. New count should be roughly +40 to +60 tests over the Stage 2 cleanup baseline of 344.
4. `docker compose run --rm dev --filter @bollard/cli run start -- verify --profile` — must show the new adversarial config shape with all three scopes.
5. `docker compose run --rm dev --filter @bollard/cli run start -- contract --work-dir /app` — must produce a non-empty ContractContext for the bollard repo itself.
6. **Self-test on the bollard repo:** `docker compose run --rm dev --filter @bollard/cli run start -- run implement-feature --task "Add a no-op debug log line in cost-tracker" --work-dir /app`. Approve the gates, watch nodes 1–13 run. Specifically confirm:
   - `extract-contracts` produces a graph that includes `@bollard/engine` (because the task touches it)
   - `generate-contract-tests` produces a non-empty test file mentioning at least one symbol from `@bollard/engine`'s exports
   - `write-contract-tests` writes to `tests/contracts/` and the leak guard does not fire
   - `run-contract-tests` runs them and reports pass/fail honestly
7. Update the "Current Test Stats" and add a "Stage 3a Validation" section to `CLAUDE.md` with: test counts, what worked, what failed, any TODOs deferred.

---

## Stop conditions / when to ask before continuing

Stop and surface a question if any of these happen:

- A non-trivial dependency needs to be added to the dev image (Go toolchain, Rust toolchain, cargo-mutants, etc.) — confirm before modifying `Dockerfile`.
- The contract-extractor produces a graph with > 50 modules or > 200 edges for the bollard repo — that's a sign granularity is wrong, stop and reassess.
- The contract-tester agent burns more than $0.50 per run on the self-test — stop and inspect the user message size and prompt.
- Information leak guard fires on a real run — STOP, do not paper over it. Investigate which module's private identifier leaked and why.
- Phase 4 deterministic extractors produce empty results because the toolchain is missing — gracefully degrade and continue, but flag in the validation report.

## What you are NOT building in this pass

(Repeat the "DO NOT build yet" list for clarity — these are Stage 3b/3c/4):
- Mutation testing (Stryker, mutmut, cargo-mutants integration, threshold gating)
- Semantic review agent
- Behavioral-scope adversarial tester or behavioral context builder
- Fault injector / fault injection orchestration
- Production probes, drift detection, flag manager
- Parallel scope execution in the blueprint engine
- Promotion of contract tests via `bollard promote-test` (the existing command targets boundary tests; extending it to contract is a small follow-up but not required for this pass)
