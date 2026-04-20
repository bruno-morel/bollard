# Stage 4b — Production Feedback Loop

> **Status:** GREEN (validated 2026-04-16; built-in providers; external providers 4b+)  
> **Depends on:** Stage 4a (behavioral scope, GREEN 2026-04-16)  
> **Validates:** Probe extraction, probe execution, deployment tracking, drift detection, flag management, progressive rollout  
> **Prerequisite for:** Stage 4c (Java/Kotlin Wave 1), Stage 5 (self-hosting)

---

## 1. Goal

Close the loop between development-time verification and production health. After Stage 4b, every change that passes Bollard's adversarial pipeline generates **probes** — lightweight health assertions that run continuously against production. When probes fail, Bollard creates a fix task that goes through the full adversarial pipeline. When production diverges from verified state (manual hotfixes, config drift), Bollard detects it and queues reconciliation.

The entire runtime is **provider-based**: Bollard ships minimal built-in implementations (JSON files, HTTP fetch) but every component has a provider interface so teams can plug in their existing tools (Datadog, Flagsmith, LaunchDarkly, ArgoCD, Cloud Run, etc.).

### The loop

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│ 1. DEPLOY │ ──► │ 2. PROBE │ ──► │3. MEASURE│ ──► │4. CORRECT│
│           │     │          │     │          │     │          │
│ Record    │     │ Execute  │     │ Compare  │     │ Create   │
│ deployment│     │ probes   │     │ against  │     │ Bollard  │
│ manifest  │     │ against  │     │ expected │     │ task if  │
│           │     │ prod     │     │          │     │ failing  │
└──────────┘     └──────────┘     └──────────┘     └─────┬────┘
      ▲                                                   │
      └───────────────────────────────────────────────────┘
                     fix goes through full adversarial pipeline
```

---

## 2. Architecture: provider-based observability

Every runtime component has three layers:

1. **Interface** — what Bollard expects (in `@bollard/observe/src/providers/types.ts`)
2. **Built-in implementation** — works out of the box, zero config, file-based
3. **Provider implementations** — teams plug in their tools

| Component | Interface | Built-in | Example providers |
|-----------|-----------|----------|-------------------|
| **Probe executor** | `ProbeExecutor` | HTTP fetch + assertions | Datadog Synthetic, Grafana Cloud Synthetic, Checkly |
| **Metrics store** | `MetricsStore` | JSON files in `.bollard/observe/metrics/` | Datadog, Prometheus pushgateway, CloudWatch |
| **Flag manager** | `FlagProvider` | JSON file (`.bollard/flags/flags.json`) | Flagsmith, LaunchDarkly, Unleash, env vars |
| **Deployment tracker** | `DeploymentTracker` | Git tags + JSON file | Cloud Run API, ArgoCD, Flux, GitHub Deployments |
| **Drift detector** | `DriftDetector` | Git diff (deployed SHA vs verified SHA) | ArgoCD drift detection, Flux reconciliation |

### Provider resolution

```yaml
# .bollard.yml
observe:
  probes:
    provider: datadog          # or "built-in" (default)
    config:
      apiKey: ${DD_API_KEY}
      site: datadoghq.eu
  flags:
    provider: flagsmith        # or "built-in" (default)
    config:
      apiKey: ${FLAGSMITH_API_KEY}
      environment: production
  deployments:
    provider: cloud-run        # or "built-in" (default)
    config:
      project: my-project
      region: europe-west1
  drift:
    provider: built-in         # default
```

Provider resolution: `.bollard.yml` → env var (`BOLLARD_PROBE_PROVIDER=datadog`) → `"built-in"`.

---

## 3. Scope (What Ships)

### 3.1 Probe extraction from behavioral claims

**File:** `packages/observe/src/probe-extractor.ts`

Deterministic filter on behavioral claims (ADR-0001 pattern — no LLM):

```typescript
export function extractProbes(
  claims: ClaimRecord[],
  context: BehavioralContext,
  runId: string,
): ProbeDefinition[]
```

**A claim is probe-eligible when:**
1. Its `grounding` references at least one `endpoint:*` source
2. Its `grounding` does NOT reference any `failure:*` source
3. Its `test` field contains HTTP/gRPC call assertions (not internal module imports)

**Transformation:** `ClaimRecord` → `ProbeDefinition`
- `claim.grounding[].source` with `endpoint:` prefix → `probe.endpoint` + `probe.method`
- `claim.test` → parsed for assertion patterns → `probe.assertions[]`
- `claim.concern` → `probe.riskTier` mapping (security/resilience claims → higher risk tier)
- `claim.id` → `probe.id` (prefixed with `probe-`)
- Schedule derived from risk tier (see §3.5 progressive rollout)

**Blueprint node:** `extract-probes` (deterministic) — inserted after `run-behavioral-tests`, before `run-mutation-testing`. Populates `ctx.generatedProbes` and sets `NodeResult.probes`.

### 3.2 Probe runner

**File:** `packages/observe/src/probe-runner.ts`

Executes probes against a target URL and returns results:

```typescript
export interface ProbeExecutor {
  execute(probe: ProbeDefinition, baseUrl: string): Promise<ProbeResult>
}

export interface ProbeResult {
  probeId: string
  timestamp: number
  status: "pass" | "fail"
  assertions: AssertionResult[]
  latencyMs: number
  deploymentId?: string
  sourceRunId?: string
}

export interface AssertionResult {
  assertion: ProbeAssertion
  passed: boolean
  actual?: unknown
  error?: string
}
```

**Built-in implementation:** `HttpProbeExecutor` — uses `fetch()` (Node 22 native) with timeout. Supports all `ProbeAssertion` types:

| Assertion type | Check |
|---------------|-------|
| `status` | Response status code matches `expected` |
| `latency` | Response time ≤ `maxMs` |
| `json_field` | `response.body[path]` matches `expected` |
| `body_contains` | Response body includes substring |
| `body_matches` | Response body matches regex |
| `header` | Response header matches `expected` |

### 3.3 Probe scheduler

**File:** `packages/observe/src/probe-scheduler.ts`

Runs probes on a schedule. Two modes:

```typescript
export interface ProbeScheduler {
  /** Run all probes once. Returns aggregated results. */
  runOnce(baseUrl: string): Promise<ProbeRunSummary>
  /** Start watching — run probes on their configured intervals. */
  watch(baseUrl: string, onResult: (result: ProbeResult) => void): ProbeWatchHandle
  /** Load probes from .bollard/probes/ */
  loadProbes(): Promise<ProbeDefinition[]>
}

export interface ProbeWatchHandle {
  stop(): void
}

export interface ProbeRunSummary {
  total: number
  passed: number
  failed: number
  results: ProbeResult[]
  duration_ms: number
}
```

**Built-in implementation:** `setInterval`-based scheduler. Each probe has its own interval derived from its risk tier. The `watch` command runs until stopped (Ctrl+C or programmatic).

**Probe storage:** Probes are persisted to `.bollard/probes/{probeId}.json` during the pipeline run. The scheduler loads from this directory. Probes are version-controlled (they're artifacts).

### 3.4 Deployment tracker

**File:** `packages/observe/src/deployment-tracker.ts`

Records when deployments happen and associates them with Bollard runs:

```typescript
export interface DeploymentTracker {
  record(metadata: DeploymentMetadata): Promise<void>
  getCurrent(): Promise<DeploymentMetadata | undefined>
  getHistory(limit?: number): Promise<DeploymentMetadata[]>
}

export interface DeploymentMetadata {
  deploymentId: string          // git SHA or deployment UUID
  timestamp: number
  sourceRunIds: string[]        // Bollard run IDs that produced this deploy
  relatedCommits: string[]
  environment: string           // "production", "staging", etc.
  baselineMetrics?: Record<string, number>
}
```

**Built-in implementation:** `FileDeploymentTracker` — stores in `.bollard/observe/deployments.json`. The `record` command is called manually (`bollard deploy record`) or hooked into CI/CD.

**Cloud Run provider (example):** `CloudRunDeploymentTracker` — queries Cloud Run revision list to auto-detect deployments. Maps revision metadata to `DeploymentMetadata`.

### 3.5 Progressive rollout

**File:** `packages/observe/src/rollout.ts`

Risk-tier-driven rollout progression:

```typescript
export interface RolloutState {
  flagId: string
  riskTier: "low" | "medium" | "high" | "critical"
  stage: RolloutStage
  percent: number
  startedAt: number
  lastAdvancedAt: number
  probeWindow: number           // ms to wait before advancing
  requiresHumanApproval: boolean
  history: RolloutEvent[]
}

export type RolloutStage = "off" | "canary" | "partial" | "full"

export interface RolloutEvent {
  from: RolloutStage
  to: RolloutStage
  timestamp: number
  trigger: "auto" | "human" | "probe_failure" | "emergency_kill"
  probeResults?: ProbeRunSummary
}

export function computeRolloutPlan(riskTier: string): RolloutPlan
export function shouldAdvance(state: RolloutState, probeResults: ProbeRunSummary): AdvanceDecision
```

**Rollout plan by risk tier:**

| Risk | Stages | Probe window | Advance gate |
|------|--------|-------------|-------------|
| Low | OFF → full (100%) | — | Automatic |
| Medium | OFF → canary (5%) → partial (25%) → full (100%) | 30 min | Automatic if probes pass |
| High | OFF → canary (5%) → partial (25%) → full (50%) → full (100%) | 60 min | Human approves each step |
| Critical | OFF → canary (5%) → partial (10%) → partial (25%) → full (50%) → full (100%) | 120 min | Human approves each step |

**`shouldAdvance` logic:** Check if enough time has passed in probe window AND all probe runs in the window passed. For high/critical, return `{ advance: false, requiresHuman: true }` — the CLI prompts for approval.

### 3.6 Flag manager

**File:** `packages/observe/src/flag-manager.ts`

Minimal feature flag read/write with provider abstraction:

```typescript
export interface FlagProvider {
  get(flagId: string): Promise<FlagState | undefined>
  set(flagId: string, state: FlagState): Promise<void>
  list(): Promise<FlagState[]>
}

export interface FlagState {
  id: string
  enabled: boolean
  percent: number             // 0-100 for canary splits
  updatedAt: number
  updatedBy: string           // "bollard" | "human" | deployment ID
}
```

**Built-in implementation:** `FileFlagProvider` — reads/writes `.bollard/flags/flags.json`. Zero dependencies.

**Emergency kill:**
```bash
bollard flag set <flagId> off    # immediate 0%, logged with audit trail
```

This is the escape hatch. It logs the action, halts any in-progress rollout, and creates a retroactive investigation task.

### 3.7 Metrics store

**File:** `packages/observe/src/metrics-store.ts`

Stores probe results for trend analysis and rollout decisions:

```typescript
export interface MetricsStore {
  record(result: ProbeResult): Promise<void>
  query(probeId: string, since: number, limit?: number): Promise<ProbeResult[]>
  summary(probeId: string, windowMs: number): Promise<ProbeSummary>
}

export interface ProbeSummary {
  probeId: string
  windowMs: number
  total: number
  passed: number
  failed: number
  avgLatencyMs: number
  p99LatencyMs: number
}
```

**Built-in implementation:** `FileMetricsStore` — append-only JSON lines in `.bollard/observe/metrics/`. One file per day (`2026-04-16.jsonl`). Queries scan files in the time window. Zero dependencies.

The `summary()` method computes pass/fail rates and latency percentiles from stored results — used by the rollout state machine (`shouldAdvance`) to decide whether probes are healthy enough to advance a rollout stage.

**Retention:** The built-in store retains 30 days by default (configurable via `.bollard.yml` `observe.metrics.retentionDays`). Older files are pruned on write.

### 3.8 Drift detector

**File:** `packages/observe/src/drift-detector.ts`

Compares deployed state against last verified state:

```typescript
export interface DriftDetector {
  check(): Promise<DriftReport>
}

export interface DriftReport {
  hasDrift: boolean
  deployedSha: string
  verifiedSha: string
  driftedFiles: string[]
  driftedConfigs: string[]
  severity: "low" | "medium" | "high"
  recommendation: "reconcile" | "investigate" | "ignore"
}
```

**Built-in implementation:** `GitDriftDetector`
1. Get current deployed SHA from deployment tracker
2. Get last verified SHA from `.bollard/observe/last-verified.json`
3. `git diff <verified> <deployed>` — any divergence = drift
4. Classify severity: test-only changes = low, source changes = medium, config/infra = high

**What happens on drift:** Bollard creates a task to reconcile — the drifted changes go through the full adversarial pipeline retroactively. Emergency hotfixes become verified after the fact.

### 3.9 Blueprint integration

Insert **1 new node** after `run-behavioral-tests` (node 20):

| # | ID | Type | Description |
|---|-----|------|-------------|
| 21 | `extract-probes` | deterministic | Filter behavioral claims → `ProbeDefinition[]`, persist to `.bollard/probes/` |

Total node count: **27 → 28**.

The `extract-probes` node:
1. Reads grounded behavioral claims from `ctx.results["verify-behavioral-grounding"]`
2. Applies the probe-eligibility filter (endpoint ref, no failure ref)
3. Transforms eligible claims → `ProbeDefinition[]`
4. Writes probes to `.bollard/probes/{probeId}.json`
5. Sets `ctx.generatedProbes` and `NodeResult.probes`

**Skip logic:** Skips when behavioral scope was skipped (no claims to extract from) or when no claims are probe-eligible.

### 3.10 Provider interface types

**File:** `packages/observe/src/providers/types.ts`

Central type definitions for all provider interfaces. Each provider is registered via `.bollard.yml` config:

```typescript
export interface ObserveProviderConfig {
  probes?: { provider: string; config?: Record<string, unknown> }
  flags?: { provider: string; config?: Record<string, unknown> }
  deployments?: { provider: string; config?: Record<string, unknown> }
  drift?: { provider: string; config?: Record<string, unknown> }
}

export function resolveProviders(
  observeConfig: ObserveProviderConfig,
): ResolvedProviders

export interface ResolvedProviders {
  probeExecutor: ProbeExecutor
  flagProvider: FlagProvider
  deploymentTracker: DeploymentTracker
  driftDetector: DriftDetector
}
```

**Stage 4b ships:** All built-in providers are fully functional standalone implementations — not stubs. The entire feedback loop works with zero external dependencies beyond what Bollard already requires (Node 22, git, Docker). External providers (Datadog, Flagsmith, Cloud Run) are Stage 4b+ — the interfaces are ready, implementations come when we need them.

### 3.11 Standalone mode (zero external tools)

The built-in providers form a complete, self-contained feedback loop:

| Step | Built-in implementation | External dependency |
|------|------------------------|---------------------|
| **Probe execution** | `HttpProbeExecutor` — Node 22 native `fetch()` with timeout, retry, all 6 assertion types | None (fetch is built into Node 22) |
| **Metrics storage** | `FileMetricsStore` — append-only JSON lines in `.bollard/observe/metrics/` | None (filesystem) |
| **Flag management** | `FileFlagProvider` — atomic read/write to `.bollard/flags/flags.json` | None (filesystem) |
| **Deployment tracking** | `FileDeploymentTracker` — JSON file in `.bollard/observe/deployments.json` | None (filesystem) |
| **Drift detection** | `GitDriftDetector` — `git diff` between verified SHA and deployed SHA | git (already required) |
| **Probe scheduling** | `setInterval`-based scheduler with per-probe intervals | None (Node built-in) |
| **Rollout state machine** | Pure function: `computeRolloutPlan` + `shouldAdvance` | None |

**Zero-config path:** If no `observe:` section exists in `.bollard.yml`, all providers resolve to built-in. A team can go from `bollard run implement-feature` → probes generated → `bollard probe watch --url http://localhost:3000` → `bollard drift check` without configuring anything.

**What the built-in implementations store:**
```
.bollard/
├── probes/                   # Generated probe definitions (version-controlled)
│   ├── probe-abc123.json
│   └── probe-def456.json
├── flags/
│   └── flags.json            # Feature flag states
└── observe/
    ├── deployments.json      # Deployment history
    ├── last-verified.json    # SHA of last pipeline-verified commit
    └── metrics/
        └── 2026-04-16.jsonl  # Probe results (append-only, one line per result)
```

All files are plain JSON and version-controllable. Teams using external tools plug in providers without changing any calling code — the interfaces are identical.

### 3.12 New error codes

Add to `BollardErrorCode`:

- `PROBE_EXECUTION_FAILED` — probe HTTP request failed (network error, timeout)
- `PROBE_ASSERTION_FAILED` — probe ran but assertions didn't match
- `DRIFT_DETECTED` — deployed state diverges from verified state
- `ROLLOUT_BLOCKED` — probe failures during rollout window; advancement halted
- `FLAG_NOT_FOUND` — flag ID doesn't exist in provider

### 3.13 CLI commands

```bash
# Probe commands
bollard probe run [--url <baseUrl>]           # execute all probes once
bollard probe run <probeId> [--url <baseUrl>] # execute specific probe
bollard probe watch [--url <baseUrl>]         # continuous monitoring
bollard probe list                            # list generated probes

# Deployment commands
bollard deploy record [--sha <sha>] [--env <env>]  # record a deployment
bollard deploy list                                  # show deployment history
bollard deploy current                               # show current deployment

# Flag commands
bollard flag set <flagId> <on|off|percent>    # set flag state
bollard flag list                              # list all flags
bollard flag kill <flagId>                     # emergency: off + investigation task

# Drift commands
bollard drift check                            # run drift detection
bollard drift watch                            # continuous drift monitoring
```

### 3.14 MCP tools

- `bollard_probe_run` — execute probes
- `bollard_deploy_record` — record deployment
- `bollard_flag_set` — manage flags
- `bollard_drift_check` — check for drift

---

## 4. What Does NOT Ship in Stage 4b

| Item | Why | When |
|------|-----|------|
| External provider implementations (Datadog, Flagsmith, Cloud Run, ArgoCD) | Interfaces ship; implementations need real integration testing against external services | 4b+ — each provider is a self-contained addition |
| SLO tracking and error budgets | Requires stable probe data over weeks; premature to specify thresholds | 4b+ when probes have been running |
| Auto-task creation from probe failures | The `bollard probe watch` reports failures; auto-creating `implement-feature` tasks from failures needs the self-hosting loop (Stage 5) | Stage 5 |
| Rollout-to-rollout interaction handling | Edge case when two features roll out simultaneously | 4b+ |
| Probe versioning / migration | Probes evolve as code changes; migration strategy TBD | 4b+ |

---

## 5. Implementation Sequence

### Phase 1: @bollard/observe package + probe extraction

1. Create `packages/observe/` package with `package.json`, `tsconfig.json`
2. Define provider interface types (`providers/types.ts`)
3. Define `ProbeDefinition` extensions (add `body_contains`, `body_matches`, `header` assertion types — current type only has `status`, `latency`, `json_field`)
4. Implement `extractProbes()` — deterministic filter on behavioral claims
5. Implement `HttpProbeExecutor` (built-in probe runner using `fetch()`)
6. Add `extract-probes` blueprint node
7. **Tests:** Probe extraction filter tests (~10), HTTP executor tests with mock server (~8)

### Phase 2: Deployment tracking + drift detection

8. Implement `FileDeploymentTracker` (built-in)
9. Implement `GitDriftDetector` (built-in)
10. Add CLI `bollard deploy record`, `bollard deploy list`, `bollard deploy current`
11. Add CLI `bollard drift check`
12. **Tests:** Deployment tracker tests (~6), drift detector tests against git fixtures (~8)

### Phase 3: Flags + progressive rollout

13. Implement `FileFlagProvider` (built-in)
14. Implement rollout state machine (`computeRolloutPlan`, `shouldAdvance`)
15. Add CLI `bollard flag set`, `bollard flag list`, `bollard flag kill`
16. Wire probe results into rollout advancement decisions
17. **Tests:** Flag provider tests (~6), rollout state machine tests (~12), advancement decision tests (~8)

### Phase 4: Scheduler + watch mode

18. Implement `ProbeScheduler` with `runOnce` and `watch`
19. Add CLI `bollard probe run`, `bollard probe watch`, `bollard drift watch`
20. Integrate probe results with deployment attribution (tag results with current deployment ID)
21. **Tests:** Scheduler tests (~6), integration test running probes against a fixture server (~4)

### Phase 5: Provider resolution + config

22. Implement `resolveProviders()` — reads `.bollard.yml` `observe:` config, instantiates providers
23. Add `observe:` section to `.bollard.yml` schema validation
24. Wire providers through CLI commands
25. **Tests:** Provider resolution tests (~6), config validation tests (~4)

### Phase 6: Validation

26. Run full `implement-feature` self-test: 28/28 nodes, probe extraction from behavioral claims
27. Run `bollard probe run --url <fixture-server>` against a test fixture
28. Run `bollard deploy record` + `bollard drift check` against git history
29. Run `bollard flag set` + rollout state machine with mock probe results
30. Document results in `spec/stage4b-validation-results.md`

---

## 6. Test Plan

### Unit tests

| File | Tests | Coverage |
|------|-------|----------|
| `probe-extractor.test.ts` | Eligibility filter (endpoint ref, no failure ref), claim→probe transform, concern→risk tier mapping, empty claims, all-filtered-out | ~10 |
| `probe-runner.test.ts` | HTTP executor with mock server, all assertion types, timeout handling, error responses | ~8 |
| `probe-scheduler.test.ts` | runOnce aggregation, watch lifecycle (start/stop), interval derivation from risk tier | ~6 |
| `deployment-tracker.test.ts` | Record, getCurrent, getHistory, file persistence | ~6 |
| `drift-detector.test.ts` | No drift, source drift, config drift, severity classification | ~8 |
| `flag-manager.test.ts` | Get/set/list, percent-based flags, emergency kill | ~6 |
| `metrics-store.test.ts` | Record, query by time range, summary aggregation, retention pruning | ~6 |
| `rollout.test.ts` | Plan computation per risk tier, shouldAdvance logic, human gate, probe window timing | ~12 |
| `providers.test.ts` | resolveProviders with built-in, config validation, unknown provider error | ~6 |
| `implement-feature.test.ts` (extended) | Node count = 28, extract-probes node present, skip logic | ~2 |

**Estimated new test count:** ~70

### Integration tests

| Test | What It Validates |
|------|-------------------|
| Probe extraction from real behavioral claims | End-to-end: behavioral claims → filter → ProbeDefinition[] |
| Probe execution against fixture HTTP server | fetch + all assertion types against a real server |
| Drift detection against git repo | Real git diff between two commits |
| Full pipeline with probe extraction | 28/28 nodes pass, `.bollard/probes/` populated |

---

## 7. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| No behavioral claims are probe-eligible | Zero probes generated; feedback loop has nothing to run | Accept gracefully — not all changes produce probes. Log `probe_extraction_result` event with counts. |
| Probes are too specific to the change (fragile) | Probes break on unrelated changes | Risk tier mapping: probes from correctness claims get lower risk; security/resilience get higher. Fragile probes expire after N failures without code change. |
| Built-in file-based providers don't scale | Large teams overwhelm JSON files | Provider abstraction exists from day 1 — teams plug in Datadog/etc. when they outgrow built-in. |
| Drift detector false positives | Every config change looks like drift | Severity classification + `.bollardignore` patterns for expected drift (e.g., auto-scaling config) |
| Progressive rollout complexity | State machine bugs block deployments | Extensive state machine tests (~12). Emergency kill always works (bypasses state machine). |

---

## 8. Acceptance Criteria

Stage 4b is **GREEN** when:

1. `docker compose run --rm dev run test` passes with all new tests (~70 new + existing ~626)
2. `docker compose run --rm dev run typecheck` clean
3. `docker compose run --rm dev run lint` clean
4. `bollard probe run --url http://fixture:3000` executes probes and reports pass/fail
5. `bollard deploy record --sha HEAD` writes deployment metadata
6. `bollard drift check` reports drift status against git history
7. `bollard flag set test-flag on` + `bollard flag list` shows flag state
8. Full `implement-feature` pipeline runs 28/28 nodes with probe extraction
9. Rollout state machine correctly gates advancement by risk tier
10. Provider resolution works with built-in defaults (no config needed)

---

## 9. Files Changed / Created

### New package: `packages/observe/`

| File | Description |
|------|-------------|
| `packages/observe/package.json` | Package manifest |
| `packages/observe/tsconfig.json` | TypeScript config (extends root) |
| `packages/observe/src/providers/types.ts` | Provider interfaces: ProbeExecutor, FlagProvider, DeploymentTracker, DriftDetector |
| `packages/observe/src/providers/resolve.ts` | Provider resolution from config |
| `packages/observe/src/probe-extractor.ts` | Deterministic probe extraction from behavioral claims |
| `packages/observe/src/probe-runner.ts` | HttpProbeExecutor (built-in) |
| `packages/observe/src/probe-scheduler.ts` | Interval-based probe scheduling + watch mode |
| `packages/observe/src/metrics-store.ts` | FileMetricsStore (built-in) — append-only JSONL |
| `packages/observe/src/deployment-tracker.ts` | FileDeploymentTracker (built-in) |
| `packages/observe/src/drift-detector.ts` | GitDriftDetector (built-in) |
| `packages/observe/src/flag-manager.ts` | FileFlagProvider (built-in) |
| `packages/observe/src/rollout.ts` | Progressive rollout state machine |
| `packages/observe/tests/probe-extractor.test.ts` | Extraction filter tests |
| `packages/observe/tests/probe-runner.test.ts` | HTTP executor tests |
| `packages/observe/tests/probe-scheduler.test.ts` | Scheduler tests |
| `packages/observe/tests/deployment-tracker.test.ts` | Deployment tracking tests |
| `packages/observe/tests/drift-detector.test.ts` | Drift detection tests |
| `packages/observe/tests/flag-manager.test.ts` | Flag management tests |
| `packages/observe/tests/metrics-store.test.ts` | Metrics storage and query tests |
| `packages/observe/tests/rollout.test.ts` | Rollout state machine tests |
| `packages/observe/tests/providers.test.ts` | Provider resolution tests |

### Modified files

| File | Change |
|------|--------|
| `pnpm-workspace.yaml` | Add `packages/observe` |
| `packages/engine/src/blueprint.ts` | Extend `ProbeAssertion` with `body_contains`, `body_matches`, `header` types |
| `packages/engine/src/errors.ts` | Add `PROBE_EXECUTION_FAILED`, `PROBE_ASSERTION_FAILED`, `DRIFT_DETECTED`, `ROLLOUT_BLOCKED`, `FLAG_NOT_FOUND` |
| `packages/blueprints/src/implement-feature.ts` | Add `extract-probes` node (21), bump total to 28 |
| `packages/blueprints/tests/implement-feature.test.ts` | Update node count |
| `packages/cli/src/index.ts` | Add `probe`, `deploy`, `flag`, `drift` command groups |
| `packages/mcp/src/tools.ts` | Add `bollard_probe_run`, `bollard_deploy_record`, `bollard_flag_set`, `bollard_drift_check` |
| `CLAUDE.md` | Add @bollard/observe to project structure, update node count, test stats |

---

## 10. Open Design Decisions

### 10.1 Probe expiry

Probes are generated per pipeline run. As code evolves, old probes may become invalid (endpoint removed, response shape changed). Options:
- **A:** Probes expire after N consecutive failures without a corresponding code change (heuristic)
- **B:** Probes are regenerated on every pipeline run and old ones are replaced (clean but loses history)
- **C:** Probes reference their source commit; drift detector flags stale probes

**Recommendation: B for Stage 4b.** Regenerate on every run. Probe history is stored in metrics, not in the probe definitions themselves. Simple and correct.

### 10.2 Probe target URL

Probes need a target URL to hit. Where does this come from?
- **A:** Explicit in `.bollard.yml` (`observe.probes.baseUrl: https://api.example.com`)
- **B:** Inferred from deployment tracker (Cloud Run URL, k8s ingress)
- **C:** Required as CLI argument (`bollard probe run --url <url>`)

**Recommendation: A + C.** Config for CI/CD, CLI flag for ad-hoc. Provider can override (Cloud Run provider auto-resolves URL).

### 10.3 Fix-forward automation scope

When probes fail, Stage 4b *reports* the failure. Auto-creating a Bollard `implement-feature` task to fix it requires the self-hosting loop (Stage 5). For Stage 4b:
- `bollard probe watch` logs failures and exits with non-zero code
- CI/CD can trigger alerts from the exit code
- Human creates the fix task manually

Full automation (probe failure → auto-task → auto-fix → auto-deploy) is Stage 5.

---

## 11. Dependencies on Existing Infrastructure

| Dependency | Status | Notes |
|------------|--------|-------|
| `ProbeDefinition` in blueprint.ts | ✅ Exists | Has `status`, `latency`, `json_field` assertions; needs `body_contains`, `body_matches`, `header` |
| `NodeResult.probes` field | ✅ Exists | Never populated; Stage 4b is the first consumer |
| `PipelineContext.generatedProbes` | ✅ Exists | Typed as `unknown[]`; Stage 4b populates it |
| `PipelineContext.deploymentManifest` | ✅ Exists | Typed as `unknown`; Stage 4b gives it structure |
| Behavioral claims protocol | ✅ Exists | `ClaimRecord` with grounding sources — probe filter reads these |
| `BehavioralContext` | ✅ Exists | Endpoints, deps, config — probe extractor cross-references |
| `FaultInjector` interface | ✅ Exists | Extensible `inject(FaultSpec)` — not directly used by observe but shares infrastructure patterns |

---

## 12. Deferred items

| Item | Target | Notes |
|------|--------|-------|
| Datadog probe provider | 4b+ | Synthetic monitor creation via API |
| Flagsmith / LaunchDarkly flag provider | 4b+ | Flag read/write via API |
| Cloud Run deployment tracker | 4b+ | Query Cloud Run revisions |
| ArgoCD drift detector | 4b+ | Hook into ArgoCD reconciliation status |
| SLO tracking + error budgets | 4b+ | Needs weeks of probe data first |
| Auto-task creation from probe failures | Stage 5 | Requires self-hosting loop |
| Rollout-to-rollout interaction | 4b+ | Concurrent rollout edge case |
| Probe migration on code changes | 4b+ | Probe versioning strategy |
| `bollard probe watch` as daemon/service | 4b+ | Currently CLI-only; could be a long-running service |
