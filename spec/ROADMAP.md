# Bollard Roadmap

Features deferred from v0.1 spec to keep scope tight. These are all good ideas — they just don't belong in the first build.

**Stage 3a (contract adversarial scope)** — Contract graph extraction (TypeScript monorepo), `contract-tester` agent, blueprint nodes, and `bollard contract` / MCP `bollard_contract` are implemented in the main tree. Validated **YELLOW** on 2026-04-07 — see [stage3a-validation-results.md](./stage3a-validation-results.md) and `spec/07-adversarial-scopes.md` implementation status.

## Stage 3a — flip YELLOW → GREEN

One-off remaining work before Stage 3a can be called done:

- **Full 16-node `implement-feature` re-run** after commit `f14bd66` (`vitest.contract.config.ts` + `runTests` branch for `.bollard/` paths). Cheap (~$0.37, ~100s based on earlier runs), high signal. Run with `BOLLARD_AUTO_APPROVE=1` and the `sh -c` workaround for pnpm's `--filter` inside `docker compose run`.
- Watch specifically for **LLM-generated contract test quality** on `run-contract-tests`. An earlier generated file had incorrect `CostTracker` expectations; the information-barrier fix limited the *input* surface, but the *prompt* may still need tuning — see Stage 3b.

## Stage 3b — multi-language contract graph + dev ergonomics

Contract-scope coverage beyond TypeScript monorepos, plus the infrastructure debts surfaced during Stage 3a validation:

- **Contract graph for Python / Go / Rust workspaces** — `buildContractContext` currently returns an empty graph with a warning for non-TS repos. Needs language-specific module/import edge extractors plus a common `ContractContext` shape.
- **Go + Rust in the dev image** — `packages/verify/tests/type-extractor.test.ts` has two `it.skipIf` integration tests marked `TODO(stage-3b)` because `go` and `rustc` are not on the dev image PATH. Likely a `Dockerfile.dev-full` variant, or a split multi-stage image, so CI can exercise the extractors unconditionally.
- **Contract-tester prompt tuning** — teach the agent to prefer behavioral assertions over identity assertions when given only a type signature + entry-export closure. Cross-reference: the `CostTracker` false expectation from Stage 3a validation.
- **Deterministic test output parsers** for pytest, `go test`, and `cargo test` — Vitest is the only parser today; others fall back to zero/error detection via profile-driven execution.

## Stage 3c follow-ups

- **Per-language mutation testing** — Stryker (JS/TS), mutmut (Python), cargo-mutants (Rust), go-mutesting (Go). Unblocked now that extractors are deterministic. Mutation testing against both Layer 1 (project tests) and Layer 2 (adversarial tests) is the Stage 3c exit criterion.
- **Semantic review agent** — separate agent that sees diff + plan (but not implementation internals) and flags misalignments. Information barrier enforced by prompt construction + postcondition scan, same pattern as contract-tester.
- **Streaming LLM responses** — `LLMProvider.chat_stream`, partial/streaming tool-call assembly, and CLI rendering of tokens as they arrive. Design notes and rationale for deferring vs. spinner-based progress: [stage3a-progress-ux-prompt.md](./stage3a-progress-ux-prompt.md) (§1 Option B, §6). Option A (spinner + turn/tool telemetry) already shipped in Stage 3a.
- **Verification summary batching** — replace per-check retry loops with a single consolidated feedback message when the turn budget is close to exhaustion. Related to the `deferPostCompletionVerifyFromTurn` tradeoff that caused Stage 2 validation's TS static-check failure.
- **Git rollback on coder max-turns failure** — partially-written files remain on disk today. Needs a worktree/branch strategy that can be reset atomically when the coder agent exhausts its turn budget.

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
- **Stage 3:** Per-language mutation testing (Stryker, mutmut, go-mutesting, cargo-mutants), deterministic type extractors for Python/Go/Rust, mutation testing against both Layer 1 and Layer 2 test suites.

The persistent-native adversarial test mode (tests written in the project's language, integrated with the project's test runner) is a Stage 2 deliverable. See [06-toolchain-profiles.md](06-toolchain-profiles.md) Section 13 for the ephemeral vs. persistent-native lifecycle model.

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
