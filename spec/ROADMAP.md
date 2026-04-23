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

**Stage 4c Part 2** — Java/Kotlin Wave 1 — automated baseline **validated 2026-04-17** (744 pass / 4 skip; adversarial 331 pass). **2026-04-19:** Full validation re-run under Docker: Phase 0–2 GREEN (753 pass / 4 skip; adversarial 331). Phase 3 Bollard-on-bollard reached 14/28 nodes, surfaced cross-module contract-test placement bug. **2026-04-20 (Wave 1.1 fix):** `resolveContractTestModulePrefix` places cross-module contract tests in consumer module; conditional OWASP audit detection. **769 pass / 4 skip**. Phase 3 re-run: node 15 `run-contract-tests` now compiles and executes (2 tests, 1 pass, 1 runtime error from LLM test-design assumption — not infrastructure). Phase 4 Gradle detection GREEN (live pipeline deferred). Status **GREEN** (infrastructure validated). See [stage4c-validation-results.md](./stage4c-validation-results.md). Design: [stage4c-java-kotlin-wave1.md](./stage4c-java-kotlin-wave1.md).

**Stage 4c cleanup (DONE):** Coder verification hook includes `audit` + `secretScan` (aligned with `runStaticChecks`); no-profile fallback adds them when `pnpm`/`gitleaks` are on PATH. `**static-checks`** and `**run-tests**` blueprint nodes use `onFailure: "skip"` so the pipeline does not stop there after the coder’s batched verification retries. `**ctx.rollbackSha**` records HEAD after branch creation; on coder agent failure, CLI resets the working tree to that SHA when `ctx.gitBranch` is set.

**Stage 4d** — DX & Agent Integrations: `bollard init --ide` with Cursor/Claude Code/Codex/Antigravity generators, MCP v2 (enriched descriptions, 6 resources, 3 prompts), `bollard watch`, `--quiet` verify. See [stage4d-validation-results.md](./stage4d-validation-results.md). Design: [stage4d-dx-agent-integrations.md](./stage4d-dx-agent-integrations.md).

**Stage 4d hardening (DONE, 2026-04-22):** Self-test validation (Bollard-on-Bollard) using `bollard_watch_status` MCP tool task. 862 pass / 4 skip. Protocol compliance: 5/5 checklist items passed. Key findings and fixes:

- **MCP profile resolution:** `handleVerify` now calls `resolveConfig(undefined, dir)` for proper `ToolchainProfile` — was falling back to hardcoded pnpm defaults
- **MCP structured output:** `bollard_verify` returns `{ allPassed, summary, checks[], suggestion }` — agents can act on failures without parsing raw JSON
- **MCP workspace root:** `server.ts` uses `findWorkspaceRoot(process.cwd())` for resilient cwd resolution
- **Static check error capture:** `runStaticChecks` error handler captures both stdout and stderr (tsc/biome write errors to stdout)
- **Protocol compliance finding:** "you MUST" language in rules files is advisory to LLMs. Fixed via WHY-first explanation, explicit DO NOT list with specific command examples, and BEFORE REPORTING COMPLETION self-check checklist. See [ADR-0003](./adr/0003-agent-protocol-compliance.md).
- **Bollard-on-Bollard validation pattern:** Formalized as: give the model a real implementation task → observe whether it follows the verification protocol → measure with checklist. Three rounds validated (Stage 2, 4c, 4d). All infrastructure issues found this way were invisible to unit tests.

---

## Stage 5 — Self-Hosting + Self-Improvement

Bollard has all three adversarial scopes, four concern lenses, mutation testing, semantic review, production observability, and IDE integrations. Stage 5 turns Bollard inward: it builds and verifies itself.

### 5a: Self-Hosting

Bollard runs its own `implement-feature` pipeline on Bollard changes. Every PR to Bollard goes through boundary + contract + behavioral adversarial testing, mutation testing, and semantic review — using Bollard itself.

- **Bollard-on-Bollard CI:** GitHub Actions workflow runs `bollard run implement-feature` on PR branches. The pipeline verifies the change with the *current* Bollard (not the changed one) to avoid bootstrap paradox.
- **Run history:** Persist pipeline run results (cost, duration, node outcomes, test counts, mutation scores) to `.bollard/runs/` or an external store. Enables trend analysis and regression detection.
- **Protocol compliance CI:** Automated validation that generated IDE configs (Cursor rules, Claude Code CLAUDE.md sections) actually produce protocol-compliant agent behavior. Uses the Bollard-on-Bollard self-test pattern: generate config → give agent a task → check 5-point compliance checklist programmatically.
- **Cost tracking dashboard:** Aggregate `CostTracker` data across runs for budget monitoring and per-stage cost trends.

### 5b: Self-Improvement

- **Prompt regression gating:** `bollard eval` runs before and after prompt changes; new prompts must match or exceed baseline scores. Eval sets already exist for planner, coder, boundary-tester, contract-tester.
- **Meta-verification:** Risk score auditing — confusion matrix of agent assessments vs. actual outcomes over N runs. `bollard doctor --risk-audit` for calibration quality.
- **Adaptive concern weights:** Analyze which concern lenses find real bugs most often per project. Suggest weight adjustments in `bollard doctor` output based on historical probe hit rates.
- **Protocol audit command:** `bollard audit-protocol` — run a synthetic task through the MCP tools and verify the agent followed the verification protocol. Extends the manual Bollard-on-Bollard pattern into an automated, repeatable check.

### 5c: Agent Intelligence Upgrades

- **MCP client for agents:** Bollard's planner/coder agents consume external MCP tools (GitHub, Slack, Jira). Agent tool list = built-in tools + available MCP servers, with allowlist/denylist in `.bollard.yml`.
- **Parallel scope execution:** Boundary, contract, and behavioral agents run concurrently after context extraction (they see different context and produce different outputs). Blueprint engine needs parallel node support.
- **Agent memory across runs:** Agents learn from previous runs on the same project — which probes found real bugs, which test patterns were most effective, which concerns had the highest yield.

### Lessons from Stage 4d that shape Stage 5

These findings are architectural — they affect how every future stage is designed:

1. **Advisory ≠ enforced.** Rules files and system prompts that say "you MUST" are suggestions to LLMs, not constraints. Any protocol that must be followed needs three structural elements: WHY the protocol exists (so the model can reason about it), explicit DO NOT section with concrete negative examples, and a self-check checklist the model runs before declaring completion. See [ADR-0003](./adr/0003-agent-protocol-compliance.md).

2. **Self-tests find what unit tests can't.** All three Bollard-on-Bollard rounds (Stage 2, 4c, 4d) surfaced issues invisible to the 862-test suite. The pattern: give a real model a real task through real infrastructure, observe what breaks. This is not a substitute for unit tests — it's a different verification layer that catches integration-level and protocol-level failures.

3. **MCP tools need structured output from day one.** Raw JSON dumps force the consuming agent to parse and interpret. Structured output with `allPassed`, `summary`, `suggestion` fields lets the agent act immediately. Every new MCP tool should return an actionable shape, not a data dump.

4. **Workspace resolution is never simple.** `process.cwd()` is wrong in containers, wrong under `pnpm --filter`, wrong when MCP servers are spawned from different directories. Always use `findWorkspaceRoot()` or equivalent. Any new entry point (CLI command, MCP handler, hook) must thread workspace resolution through.

5. **Error output goes to unexpected places.** TypeScript compiler and Biome write errors to stdout, not stderr. Any error-capture code must collect both streams. This is a general principle: don't assume tools follow Unix conventions.

---

## Stage 3c — shipped (validated GREEN 2026-04-16)

- ~~**Per-language mutation testing**~~ — Stryker (JS/TS), `MutmutProvider` (Python), `CargoMutantsProvider` (Rust). Go mutation testing deferred (no maintained upstream tool). Scope-aware targeting via `mutateFiles` reduces pipeline runs from full-repo to coder-changed files only.
- ~~**Semantic review agent**~~ — `semantic-reviewer` agent sees diff + plan, produces structured `ReviewFinding`s with grounding. Deterministic verifier filters hallucinations. Advisory only (never blocks pipeline). Findings shown at `approve-pr`.
- ~~**Streaming LLM responses**~~ — Anthropic `chatStream` + executor integration + `stream_delta` progress events. OpenAI + Google `chatStream` shipped in **Stage 4c Part 1** (see [stage4c-streaming-parity.md](./stage4c-streaming-parity.md)).
- ~~`**go.work`-only detection**~~ — `parseGoWorkUses` in Go detector; root `go.mod` takes precedence when both exist.

### Moved to Stage 4c

These items were originally tracked under Stage 3c but have been rescheduled through 4a/4b to 4c:

- **Java/Kotlin language expansion (Wave 1)** — originally Stage 3c per [07-adversarial-scopes.md §12.1](07-adversarial-scopes.md). Moved to Stage 4c because the mutation-testing integration pattern needed to stabilize on TS/Python/Rust first.
- ~~**OpenAI / Google streaming parity**~~ — **Done (Stage 4c Part 1, 2026-04-16).** See [stage4c-streaming-parity.md](./stage4c-streaming-parity.md).
- ~~**Verification summary batching**~~ — **Done (Stage 4c cleanup).** Coder post-completion hook runs typecheck, lint, test, audit, secretScan in one pass with batched failure output (up to 3 retries).
- ~~**Git rollback on coder max-turns failure**~~ — **Done (Stage 4c cleanup).** `rollbackSha` + `git reset --hard` in CLI agent-handler when coder throws; only on `bollard/`* branch (`ctx.gitBranch` set).

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
- Detection: `pom.xml` / `build.gradle`* / `settings.gradle*`
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

## Stage 5+: Agent Intelligence

### ~~MCP Client for Agents~~ — MOVED TO Stage 5c

See Stage 5c above.

### Prompt Evaluation Framework (Full)

- ~~Eval sets per agent~~ — **Done (Stage 1).** Planner (4 cases), coder (2), boundary-tester, contract-tester eval sets exist. `bollard eval [agent]` command works.
- Prompt change gating: new prompt must pass ≥ baseline evals — **Stage 5b**
- Prompt regression detection over N runs — **Stage 5b**
- Additional assertion types: test_catches_bug, no_implementation_leak — **Stage 5b**

### ~~Information Isolation Verification~~ — DONE (Stage 3a)

- Contract context re-export closure limits `publicExports` to entry-export paths — private internals no longer leak into adversarial agent prompts
- Regression test added in Stage 3a validation
- Leak scan in `write-tests` / `write-contract-tests` / `write-behavioral-tests` nodes

### ~~Meta-Verification~~ — MOVED TO Stage 5b

See Stage 5b above. Needs hundreds of runs of calibration data.

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