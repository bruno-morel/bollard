# Bollard Roadmap

Features deferred from v0.1 spec to keep scope tight. These are all good ideas — they just don't belong in the first build.

## Stage 3 — COMPLETE (validated GREEN)

**Stage 3a** (contract-scope adversarial testing) — validated GREEN on 2026-04-08. See [stage3a-validation-results.md](./stage3a-validation-results.md).

**Stage 3b** (polyglot contract graphs + dev ergonomics) — validated GREEN on 2026-04-09. See [stage3b-validation-results.md](./stage3b-validation-results.md).

**Stage 3c** (mutation testing, semantic review, streaming, `go.work` detection) — validated GREEN on 2026-04-16. See [stage3c-validation-results.md](./stage3c-validation-results.md).

**Stage 4a** (behavioral-scope adversarial testing — deterministic context extraction, `behavioral-tester` agent, grounding, coarse fault injection, behavioral compose) — validated GREEN on 2026-04-16. See [stage4a-validation-results.md](./stage4a-validation-results.md).

**Stage 4b** (production feedback loop — `@bollard/observe` package: probe extraction from behavioral claims, HTTP probe runner, metrics store, deployment tracker, drift detector, flag manager, progressive rollout, probe scheduler; `extract-probes` blueprint node; CLI `probe`/`deploy`/`flag`/`drift` commands; 4 MCP tools; built-in providers only, zero external deps) — validated GREEN on 2026-04-16. See [stage4b-validation-results.md](./stage4b-validation-results.md).

**Stage 4c Part 1** (OpenAI + Google `chatStream` parity with Anthropic) — validated GREEN on 2026-04-16. See [stage4c-streaming-parity.md](./stage4c-streaming-parity.md).

**Stage 4c Part 1 hardening** (auto-format write nodes, grep→ripgrep, `rm` allowlist, model ID update) — 705 pass / 4 skip. Bollard-on-bollard self-test: 28/28 nodes, $0.63.

**Stage 4c Part 2** — Java/Kotlin Wave 1 — automated suite and integration checks **validated 2026-04-17** (744 pass / 4 skip; adversarial 331 pass). Full Java `implement-feature` E2E deferred; see [stage4c-validation-results.md](./stage4c-validation-results.md). Design: [stage4c-java-kotlin-wave1.md](./stage4c-java-kotlin-wave1.md).

**Stage 4d** — DX & Agent Integrations: planned. See [stage4d-dx-agent-integrations.md](./stage4d-dx-agent-integrations.md).

## Stage 3c — shipped (validated GREEN 2026-04-16)

- ~~**Per-language mutation testing**~~ — Stryker (JS/TS), `MutmutProvider` (Python), `CargoMutantsProvider` (Rust). Go mutation testing deferred (no maintained upstream tool). Scope-aware targeting via `mutateFiles` reduces pipeline runs from full-repo to coder-changed files only.
- ~~**Semantic review agent**~~ — `semantic-reviewer` agent sees diff + plan, produces structured `ReviewFinding`s with grounding. Deterministic verifier filters hallucinations. Advisory only (never blocks pipeline). Findings shown at `approve-pr`.
- ~~**Streaming LLM responses**~~ — Anthropic `chatStream` + executor integration + `stream_delta` progress events. OpenAI + Google `chatStream` shipped in **Stage 4c Part 1** (see [stage4c-streaming-parity.md](./stage4c-streaming-parity.md)).
- ~~**`go.work`-only detection**~~ — `parseGoWorkUses` in Go detector; root `go.mod` takes precedence when both exist.

### Moved to Stage 4c

These items were originally tracked under Stage 3c but have been rescheduled through 4a/4b to 4c:

- **Java/Kotlin language expansion (Wave 1)** — originally Stage 3c per [07-adversarial-scopes.md §12.1](07-adversarial-scopes.md). Moved to Stage 4c because the mutation-testing integration pattern needed to stabilize on TS/Python/Rust first.
- ~~**OpenAI / Google streaming parity**~~ — **Done (Stage 4c Part 1, 2026-04-16).** See [stage4c-streaming-parity.md](./stage4c-streaming-parity.md).
- **Verification summary batching** — replace per-check retry loops with a single consolidated feedback message. Stage 4c.
- **Git rollback on coder max-turns failure** — partially-written files remain on disk today. Needs a worktree/branch strategy. Stage 4c.

---

## Stage 4b+: Production Feedback Loop Enhancements

These extend the core probe → measure → correct loop shipped in Stage 4b.

### ~~Bollard-Owned Feature Flags~~ — SHIPPED (Stage 4b)
- `FileFlagProvider` (built-in) + `FlagProvider` interface for external providers (Flagsmith, LaunchDarkly)
- Progressive rollout state machine: OFF → canary (5%) → partial (25%) → full (100%)
- Risk-gated rollout advancement (auto for low/medium, human-gated for high/critical)
- CLI: `bollard flag set/list/kill`

### ~~Drift Detection~~ — SHIPPED (Stage 4b)
- `GitDriftDetector` (built-in) + `DriftDetector` interface for external providers (ArgoCD, Flux)
- Severity classification: test-only = low, source = medium, config/infra = high
- CLI: `bollard drift check/watch`

### External Provider Implementations (4b+)
- Datadog Synthetic for probes, Prometheus pushgateway for metrics
- Flagsmith / LaunchDarkly for flags
- Cloud Run / ArgoCD / Flux for deployment tracking and drift detection
- **When:** When teams need them; interfaces are ready.

### SLO Tracking and Error Budgets (4b+)
- Rolling-window error budget math on probe results
- Risk-tier-derived SLO targets (availability, latency P95/P99)
- Budget consumption notifications (25%, 50%, 75%)
- Auto-task creation when budget exhausted
- **Why deferred:** Requires stable probe data over weeks. Specifying thresholds before running a single probe is premature.

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

## Stage 4c → 5+: Language Coverage Expansion

Stages 3–4b ship with deterministic support for TypeScript, JavaScript, Python, Go, and Rust. Additional major languages are sequenced into three waves. **Full design and rationale in [07-adversarial-scopes.md §12.1](07-adversarial-scopes.md#121-language-expansion-roadmap).**

Each new language is a four-step integration: detector (`packages/detect/src/languages/<lang>.ts`), deterministic `SignatureExtractor` (ideally a compiled helper binary, same pattern as `bollard-extract-go` / `bollard-extract-rs`), Docker verify image (`docker/Dockerfile.verify-<lang>`), and mutation-testing wrapper.

### Wave 1 — Stage 4c: Java + Kotlin (JVM)
- **Why first:** largest enterprise footprint; **PIT** is the flagship mutation tool in any language, so Java becomes Bollard's reference mutation-testing integration. Originally slated for Stage 3c; moved to Stage 4c because the mutation-testing integration pattern needed to stabilize on TS/Python/Rust first.
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
- **Elixir** — reserved in `LanguageId`; may move earlier if Stage 4c wants a resilience-concern reference implementation (BEAM's supervision model)
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
