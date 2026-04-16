# Bollard Roadmap

Features deferred from v0.1 spec to keep scope tight. These are all good ideas — they just don't belong in the first build.

## Stage 3 — COMPLETE (validated GREEN)

**Stage 3a** (contract-scope adversarial testing) — validated GREEN on 2026-04-08. See [stage3a-validation-results.md](./stage3a-validation-results.md).

**Stage 3b** (polyglot contract graphs + dev ergonomics) — validated GREEN on 2026-04-09. See [stage3b-validation-results.md](./stage3b-validation-results.md).

**Stage 3c** (mutation testing, semantic review, streaming, `go.work` detection) — validated GREEN on 2026-04-16. See [stage3c-validation-results.md](./stage3c-validation-results.md).

**Stage 4a** (behavioral-scope adversarial testing — deterministic context extraction, `behavioral-tester` agent, grounding, coarse fault injection, behavioral compose) — validated GREEN on 2026-04-16. See [stage4a-validation-results.md](./stage4a-validation-results.md).

## Stage 3c — shipped (validated GREEN 2026-04-16)

- ~~**Per-language mutation testing**~~ — Stryker (JS/TS), `MutmutProvider` (Python), `CargoMutantsProvider` (Rust). Go mutation testing deferred (no maintained upstream tool). Scope-aware targeting via `mutateFiles` reduces pipeline runs from full-repo to coder-changed files only.
- ~~**Semantic review agent**~~ — `semantic-reviewer` agent sees diff + plan, produces structured `ReviewFinding`s with grounding. Deterministic verifier filters hallucinations. Advisory only (never blocks pipeline). Findings shown at `approve-pr`.
- ~~**Streaming LLM responses**~~ — Anthropic `chatStream` + executor integration + `stream_delta` progress events. OpenAI/Google stubs throw `PROVIDER_NOT_FOUND` — moved to Stage 4 for full parity.
- ~~**`go.work`-only detection**~~ — `parseGoWorkUses` in Go detector; root `go.mod` takes precedence when both exist.

### Moved from Stage 3 to Stage 4

These items were originally tracked under Stage 3c but have been rescheduled:

- **Java/Kotlin language expansion (Wave 1)** — originally Stage 3c per [07-adversarial-scopes.md §12.1](07-adversarial-scopes.md). Moved to Stage 4 because the mutation-testing integration pattern needed to stabilize on TS/Python/Rust first. Now shares Stage 4 with the behavioral scope.
- **OpenAI / Google streaming parity** — Anthropic streaming shipped; the other two providers remain stubs. Moved to Stage 4.
- **Verification summary batching** — replace per-check retry loops with a single consolidated feedback message. Moved to Stage 4.
- **Git rollback on coder max-turns failure** — partially-written files remain on disk today. Needs a worktree/branch strategy. Moved to Stage 4.

---

## Stage 3+: Production Feedback Loop Enhancements

These extend the core probe → measure → correct loop once it's running and proven.

### Bollard-Owned Feature Flags
- Flag definitions as artifacts (FlagDefinition, RolloutStrategy, RolloutState types)
- Progressive rollout state machine: OFF → canary (5%) → partial (25%) → full (100%)
- Zero-dep flag system: JSON files + provider storage, built-in HTTP flag endpoint
- Flags follow Universal Artifact Pattern (produce → verify → proof → drift)
- Risk-gated rollout advancement (auto for low/medium, human-gated for high/critical)
- Optimistic concurrency control for concurrent rollout state updates
- **Why deferred:** Most teams already have flag systems (LaunchDarkly, Unleash, env vars). Bollard should integrate first, own later — once we know what the probes actually tell us.

### SLO Tracking and Error Budgets
- Rolling-window error budget math on probe results
- Risk-tier-derived SLO targets (availability, latency P95/P99)
- Budget consumption notifications (25%, 50%, 75%)
- Auto-task creation when budget exhausted
- **Why deferred:** Requires stable probe data over weeks. Specifying thresholds before running a single probe is premature.

### Drift Detection — MOVED TO SPEC
- Now a Stage 3 core concern in [01-architecture.md](01-architecture.md) Section 11
- Essential for system convergence: unverified changes in production must be detected and corrected

---

## Stage 3+: Documentation as Artifact (Full)

The principle (docs go through the same adversarial pipeline) is in the spec. The full implementation is deferred.

### Doc Verification Agent
- Separate agent sees diff + plan + docs (NOT implementation)
- Impact analysis: which docs are affected by code changes
- Orphan detection: docs referencing removed code
- **When:** Stage 3, after adversarial test agent is proven

### Documentation Inventory
- INVENTORY.yml — machine-readable manifest of all docs
- Living docs (auto-generated), curated docs (human-owned), ephemeral docs (per-run)
- Doc coverage as a verification postcondition

### Documentation Testing
- Extract code blocks from guides, test them in sandbox
- Link checking, config sync, freshness detection
- Monthly verification cycle

---

## Stage 3+: Extended Observability

### Advanced Rollout Automation
- Basic progressive rollout by risk tier is in the spec (see [01-architecture.md](01-architecture.md) Section 11)
- This roadmap item covers: automatic step advancement based on probe health, rollout state machine persistence, optimistic concurrency for concurrent rollouts, rollout-to-rollout interaction handling
- **Why deferred:** Basic percentage-based canary with manual/risk-gated advancement is sufficient for v0.1

### Probe Scheduling
- Cron-based continuous probe execution
- Probe-to-probe dependencies for stateful APIs
- Multi-region probing

### Browser-Based Probes
- Playwright flows simulating real user journeys
- Visual regression detection
- Full synthetic monitoring (beyond API contract verification)

---

## Stage 1.5–3: Language Agnosticism — MOVED TO SPEC

Now a core concern across multiple stages. See [06-toolchain-profiles.md](06-toolchain-profiles.md) for the full design and [02-bootstrap.md](02-bootstrap.md) for the updated stage breakdown:

- **Stage 1.5:** Toolchain detection (`@bollard/detect`), profile-driven verification, templatized agent prompts, interactive `bollard init`. All existing TypeScript behavior preserved, plus Python/Go/Rust/Ruby/Java detection.
- **Stage 2:** Docker-isolated adversarial test containers, black-box testing in Bollard's own runtime (language-independent), in-language test generation for supported frameworks, `SignatureExtractor` interface with TS implementation + LLM fallback.
- **Stage 3:** Per-language mutation testing (Stryker for TS/JS, mutmut for Python, cargo-mutants for Rust), deterministic type extractors for Python/Go/Rust, semantic review agent, Anthropic LLM streaming. *Note: go-mutesting (Go) was deferred — no maintained upstream tool. Go mutation will be revisited when a viable tool emerges.*

The persistent-native adversarial test mode (tests written in the project's language, integrated with the project's test runner) is a Stage 2 deliverable. See [06-toolchain-profiles.md](06-toolchain-profiles.md) Section 13 for the ephemeral vs. persistent-native lifecycle model.

---

## Stage 4 → 5+: Language Coverage Expansion

Stage 3 ships with deterministic support for TypeScript, JavaScript, Python, Go, and Rust. Additional major languages are sequenced into three waves. **Full design and rationale in [07-adversarial-scopes.md §12.1](07-adversarial-scopes.md#121-language-expansion-roadmap).**

Each new language is a four-step integration: detector (`packages/detect/src/languages/<lang>.ts`), deterministic `SignatureExtractor` (ideally a compiled helper binary, same pattern as `bollard-extract-go` / `bollard-extract-rs`), Docker verify image (`docker/Dockerfile.verify-<lang>`), and mutation-testing wrapper.

### Wave 1 — Stage 4: Java + Kotlin (JVM)
- **Why first:** largest enterprise footprint; **PIT** is the flagship mutation tool in any language, so Java becomes Bollard's reference mutation-testing integration. Originally slated for Stage 3c; moved to Stage 4 because the mutation-testing integration pattern needed to stabilize on TS/Python/Rust first.
- Detection: `pom.xml` / `build.gradle*` / `settings.gradle*`
- Toolchain: javac + kotlinc, SpotBugs/Checkstyle/ErrorProne/ktlint/detekt, JUnit 5 / TestNG, Temurin JDK 21
- Extractor: JavaParser-based CLI jar (`bollard-extract-java`) in dev image; Kotlin shares the helper
- Mutation: **PIT** (`pitest`)
- Contract graph: Gradle/Maven `project(...)` references map directly to `ContractContext` module edges

### Wave 2 — Stage 4+: C#/.NET
- **Why second:** `dotnet` CLI is one cohesive entry point, Roslyn gives a first-class AST API, and **Stryker.NET** is healthy. Sequenced after Wave 1 to reuse the Bollard mutation-testing integration contract established there
- Detection: `*.csproj` / `*.sln` / `global.json`
- Toolchain: `dotnet build` / `dotnet format` / `dotnet test`, xUnit/NUnit/MSTest
- Extractor: Roslyn-based .NET global tool (`bollard-extract-dotnet`) — Roslyn's semantic model gives richer type information than any current extractor
- Mutation: **Stryker.NET**
- Contract graph: `.sln` + `ProjectReference` elements give a deterministic module graph

### Wave 3 — Stage 5+: Ruby + PHP
- **Why third:** smaller cohesive audiences, both underserved by AI tooling. PHP is the dark horse — massive install base plus **Infection** (on par with PIT and Stryker.NET)
- **Ruby:** `Gemfile` detection, Sorbet/RBS typecheck (optional — contract scope is weaker without it), RuboCop, RSpec/Minitest, **mutant** (validate licensing), Prism-based helper for projects without Sorbet
- **PHP:** `composer.json` detection, PHPStan/Psalm typecheck, PHPCS/PHP-CS-Fixer, PHPUnit/Pest, **Infection** for mutation testing, nikic/php-parser for extraction

### Explicit non-goals (no near-term timeline)
- **Swift** — Apple-ecosystem-dominant, limited server-side relevance
- **Scala** — JVM, complex toolchain relative to audience size; may piggyback on Wave 1 if a contributor shows up
- **Elixir** — reserved in `LanguageId`; may move earlier if Stage 4 wants a resilience-concern reference implementation (BEAM's supervision model)
- **F#, Clojure, Haskell, OCaml, Nim, Zig** — no near-term plans; the `LanguageId` union grows when demand appears

### Sequencing principle
Waves run in sequence, not parallel, so each wave re-validates the four-integration-point abstraction before we commit to the next, and so the `dev-full` image grows predictably (~200 MB JDK, ~500 MB .NET SDK, ~150 MB Ruby+PHP across the three waves).

---

## Stage 2+: Agent Intelligence

### MCP Client for Agents
- Bollard's agents consume external MCP tools (GitHub, Slack, Jira, Confluence)
- Agent tool list = Bollard built-in tools + available MCP servers
- MCP tool allowlist/denylist in .bollard.yml
- **Why deferred:** Agents don't exist yet. Add when planner/coder agents need external context.

### Prompt Evaluation Framework (Full)
- Eval sets per agent: (input, expected behavior) pairs
- `bollard eval [agent]` command
- Assertion types: contains, not_contains, json_field, risk_tier, review_verdict, test_catches_bug, no_implementation_leak
- Prompt change gating: new prompt must pass ≥ baseline evals
- Prompt regression detection over N runs
- **Currently in spec:** One-paragraph note in 02-bootstrap.md. Full framework specced when prompts exist (Stage 1).

### Information Isolation Verification
- TypeScript compiler API to extract identifiers from test agent output
- Diff against public API surface to detect leaked implementation details
- Postcondition check on test agent node
- **Why deferred:** Stage 3 optimization. Mutation testing (Stage 3) catches the same class of bugs from a different angle.

### Meta-Verification
- Risk score auditing: confusion matrix of agent assessments vs. outcomes
- `bollard doctor --risk-audit` for calibration quality
- Under/over-assessment detection and warnings
- **Why deferred:** Needs hundreds of runs of calibration data. Stage 4+ concern.

---

## Stage 4+: Cloud Providers (Beyond GCP)

The BollardProvider interface supports all of these. Implementation priority follows demand.

### Cloud-Native CI
- Azure Pipelines provider
- AWS CodeBuild provider

### Cloud Compute
- AWS provider (ECS Fargate)
- Azure provider (ACI)
- OpenStack provider (Zun/Heat)

### CI Platforms
- GitLab CI provider (self-hosted runner support)
- Bitbucket Pipelines provider

---

## Future (No Timeline)

- A/B experiment statistics (significance testing) on flag cohorts
- Audience-based flag targeting (user attributes beyond percentage)
- SQLite or webhook-push historical data storage
- Local model support (ollama, llama.cpp) as LLM provider
- Bollard marketplace for community blueprints
- IDE extensions (VS Code, JetBrains) beyond MCP
- Multi-repo / monorepo-aware verification
- Parallel multi-provider deployment

---

*Items move from this roadmap into the spec when there's evidence they're needed — not when they sound good.*
