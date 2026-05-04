# Stage 5a — Self-Hosting: Run History + Bollard-on-Bollard CI

**Status:** Draft
**Depends on:** Stage 4d (complete)
**Author:** Bruno / Claude
**Date:** 2026-04-22

## 1. Motivation

Bollard has three self-test rounds (Stage 2, 4c, 4d) that each found bugs invisible to the 862-test unit/integration suite. These self-tests were manual: a human writes a Cursor/Claude Code prompt, watches the model work, and checks a compliance checklist. This works but doesn't scale — every future stage needs the same validation, and regression detection requires comparing across runs.

Stage 5a turns self-testing from a manual ritual into automated infrastructure:

1. **Run history** — persist every pipeline run's results so we can trend, compare, and detect regressions.
2. **Bollard-on-Bollard CI** — run `bollard verify` (and eventually `bollard run implement-feature`) on Bollard PRs, using Bollard itself.
3. **Protocol compliance CI** — automate the self-test pattern: give a model a task, observe whether it follows the verification protocol, measure with a checklist.

This spec covers the **first deliverable: run history**, with forward design for CI integration.

---

## 2. Run History

### 2.1 What we capture

Every `runBlueprint` invocation produces a `RunResult`. Run history persists a superset of this into a `RunRecord`:

```typescript
interface RunRecord {
  // Identity
  runId: string
  blueprintId: string
  task: string
  timestamp: number               // Date.now() at run start
  
  // Outcome
  status: "success" | "failure" | "handed_to_human"
  error?: { code: BollardErrorCode; message: string }
  
  // Cost & timing
  totalCostUsd: number
  totalDurationMs: number
  
  // Per-node breakdown
  nodes: NodeSummary[]
  
  // Verification snapshot
  testCount: { passed: number; skipped: number; failed: number }
  mutationScore?: number           // 0–100 if mutation testing ran
  
  // Context
  toolchainProfile?: {
    language: LanguageId
    packageManager: PackageManagerId
  }
  gitBranch?: string
  gitSha?: string                  // HEAD at run start
  
  // Adversarial scope results
  scopes: ScopeResult[]
  
  // Generated probes (if any)
  probeCount?: number
}

interface NodeSummary {
  id: string
  name: string
  type: NodeType
  status: "ok" | "fail" | "block"
  costUsd?: number
  durationMs?: number
  error?: { code: string; message: string }
}

interface ScopeResult {
  scope: "boundary" | "contract" | "behavioral"
  enabled: boolean
  claimsProposed?: number
  claimsGrounded?: number
  claimsDropped?: number
  testFile?: string
  testsPassed?: number
  testsFailed?: number
}
```

### 2.2 Storage: dual-layer (JSONL + SQLite)

**Primary: JSONL (append-only, git-trackable)**

```
.bollard/runs/
  history.jsonl          # one RunRecord per line, append-only
```

Each `runBlueprint` completion appends one JSON line. This file is the source of truth — it can be committed to git, diffed in PRs, and read without any tooling beyond `cat` and `jq`.

**Derived: SQLite (queryable, aggregatable)**

```
.bollard/runs/
  history.jsonl          # source of truth
  history.db             # derived, gitignored, rebuilt on demand
```

The SQLite database is a materialized view of the JSONL file. It's rebuilt from scratch whenever it's missing or stale (JSONL has more lines than the DB's `run_count` metadata). This means:

- The JSONL file can be edited, truncated, or merged without breaking anything — the DB just rebuilds.
- The DB file is `.gitignore`d — no binary blobs in the repo.
- CI environments start fresh (no DB) and rebuild on first query.

**SQLite schema:**

```sql
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  blueprint_id TEXT NOT NULL,
  task TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  status TEXT NOT NULL,           -- success | failure | handed_to_human
  error_code TEXT,
  error_message TEXT,
  total_cost_usd REAL NOT NULL,
  total_duration_ms INTEGER NOT NULL,
  test_passed INTEGER,
  test_skipped INTEGER,
  test_failed INTEGER,
  mutation_score REAL,
  language TEXT,
  package_manager TEXT,
  git_branch TEXT,
  git_sha TEXT,
  probe_count INTEGER,
  raw_json TEXT NOT NULL          -- full RunRecord JSON for fields not in columns
);

CREATE TABLE nodes (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  node_id TEXT NOT NULL,
  node_name TEXT NOT NULL,
  node_type TEXT NOT NULL,
  status TEXT NOT NULL,
  cost_usd REAL,
  duration_ms INTEGER,
  error_code TEXT,
  PRIMARY KEY (run_id, node_id)
);

CREATE TABLE scopes (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  scope TEXT NOT NULL,             -- boundary | contract | behavioral
  enabled INTEGER NOT NULL,
  claims_proposed INTEGER,
  claims_grounded INTEGER,
  claims_dropped INTEGER,
  tests_passed INTEGER,
  tests_failed INTEGER,
  PRIMARY KEY (run_id, scope)
);

CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- metadata: { "run_count": "42", "last_rebuild": "2026-04-22T..." }

CREATE INDEX idx_runs_timestamp ON runs(timestamp);
CREATE INDEX idx_runs_status ON runs(status);
CREATE INDEX idx_runs_blueprint ON runs(blueprint_id);
CREATE INDEX idx_nodes_status ON nodes(status);
```

### 2.3 RunHistoryStore interface

Following the provider pattern from `@bollard/observe`:

```typescript
interface RunHistoryStore {
  /** Append a completed run record. */
  record(run: RunRecord): Promise<void>
  
  /** Query runs with optional filters. */
  query(filter?: RunFilter): Promise<RunRecord[]>
  
  /** Aggregate stats over a time window. */
  summary(since?: number): Promise<RunSummary>
  
  /** Compare two runs (for regression detection). */
  compare(runIdA: string, runIdB: string): Promise<RunComparison>
  
  /** Rebuild the SQLite index from JSONL source. */
  rebuild(): Promise<{ runCount: number; durationMs: number }>
}

interface RunFilter {
  since?: number                   // timestamp lower bound
  until?: number                   // timestamp upper bound
  status?: RunRecord["status"]
  blueprintId?: string
  limit?: number                   // default: 50
  offset?: number
}

interface RunSummary {
  totalRuns: number
  successRate: number              // 0–1
  avgCostUsd: number
  avgDurationMs: number
  avgTestCount: number
  avgMutationScore?: number
  costTrend: "increasing" | "stable" | "decreasing"
  byBlueprint: Record<string, {
    runs: number
    successRate: number
    avgCostUsd: number
  }>
}

interface RunComparison {
  runA: RunRecord
  runB: RunRecord
  delta: {
    costUsd: number                // B - A
    durationMs: number
    testCountDelta: number
    mutationScoreDelta?: number
    newFailingNodes: string[]
    newPassingNodes: string[]
    scopeChanges: Array<{
      scope: string
      field: string
      from: number
      to: number
    }>
  }
}
```

### 2.4 Implementation: `FileRunHistoryStore`

Lives in `packages/engine/src/run-history.ts` (not `@bollard/observe` — run history is a core engine concern, not an observe concern).

```typescript
class FileRunHistoryStore implements RunHistoryStore {
  private readonly jsonlPath: string
  private readonly dbPath: string
  
  constructor(workDir: string) {
    this.jsonlPath = join(workDir, ".bollard", "runs", "history.jsonl")
    this.dbPath = join(workDir, ".bollard", "runs", "history.db")
  }
  
  async record(run: RunRecord): Promise<void> {
    // 1. Append to JSONL
    // 2. Insert into SQLite (if DB exists; don't rebuild just for a write)
  }
  
  async query(filter?: RunFilter): Promise<RunRecord[]> {
    // 1. Ensure DB is current (rebuild if stale)
    // 2. SELECT from runs with filter predicates
    // 3. Parse raw_json back to RunRecord
  }
  
  async summary(since?: number): Promise<RunSummary> {
    // 1. Ensure DB is current
    // 2. Aggregate queries
  }
  
  async compare(runIdA: string, runIdB: string): Promise<RunComparison> {
    // 1. Fetch both records
    // 2. Compute deltas
  }
  
  async rebuild(): Promise<{ runCount: number; durationMs: number }> {
    // 1. Read JSONL line by line
    // 2. Parse each line as RunRecord
    // 3. DROP + CREATE tables
    // 4. INSERT all records
    // 5. Update metadata
  }
}
```

**SQLite dependency:** `better-sqlite3` (synchronous, zero-config, ~3 MB, no native compilation issues on Node 22). This is the standard choice for embedded SQLite in Node.js. It's a dev/runtime dep of `@bollard/engine` only.

**Graceful degradation:** If `better-sqlite3` is not available (e.g., in a minimal Docker image), `query` and `summary` fall back to scanning the JSONL file directly (slower, but functional). The `rebuild` method becomes a no-op. This means JSONL-only operation is always possible — SQLite is a performance optimization, not a requirement.

---

## 3. Integration with the Pipeline

### 3.1 Where `record` is called

The runner (`runBlueprint`) returns a `RunResult`. The CLI `implement-feature` command already has access to this result. The integration point is in the CLI, not the engine:

```typescript
// packages/cli/src/index.ts — after runBlueprint returns
const runResult = await runBlueprint(blueprint, task, config, ...)

// Build RunRecord from RunResult + context
const record: RunRecord = {
  runId: runResult.runId,
  blueprintId: blueprint.id,
  task,
  timestamp: ctx.startedAt,
  status: runResult.status,
  error: runResult.error,
  totalCostUsd: runResult.totalCostUsd,
  totalDurationMs: runResult.totalDurationMs,
  nodes: Object.entries(runResult.nodeResults).map(([id, nr]) => ({
    id,
    name: blueprint.nodes.find(n => n.id === id)?.name ?? id,
    type: blueprint.nodes.find(n => n.id === id)?.type ?? "deterministic",
    status: nr.status,
    costUsd: nr.cost_usd,
    durationMs: nr.duration_ms,
    error: nr.error,
  })),
  testCount: extractTestCount(runResult),
  mutationScore: ctx.mutationScore,
  toolchainProfile: ctx.toolchainProfile
    ? { language: ctx.toolchainProfile.language, packageManager: ctx.toolchainProfile.packageManager }
    : undefined,
  gitBranch: ctx.gitBranch,
  gitSha: await getHeadSha(workDir),
  scopes: extractScopeResults(runResult),
  probeCount: ctx.generatedProbes?.length,
}

// Persist
const store = new FileRunHistoryStore(workDir)
await store.record(record)
```

### 3.2 `bollard verify` also records

Standalone `bollard verify` runs should also be recorded — they're lightweight but frequent. A simpler `VerifyRecord` shape:

```typescript
interface VerifyRecord {
  type: "verify"                   // discriminant from RunRecord
  runId: string                    // auto-generated
  timestamp: number
  workDir: string
  checks: Array<{ name: string; passed: boolean; durationMs: number }>
  allPassed: boolean
  totalDurationMs: number
  language?: LanguageId
  gitSha?: string
  source: "cli" | "mcp" | "watch" | "hook"  // how the verify was triggered
}
```

Same JSONL file, tagged with `type: "verify"` so queries can filter. The SQLite schema gains a `type` column on `runs` to distinguish.

---

## 4. CLI Commands

### `bollard history` (new)

```bash
# Show recent runs (default: last 10)
bollard history

# Show with filters
bollard history --status success --limit 20
bollard history --since 2026-04-01 --blueprint implement-feature

# Show a specific run's details
bollard history show <run-id>

# Compare two runs
bollard history compare <run-id-a> <run-id-b>

# Show aggregate stats
bollard history summary
bollard history summary --since 2026-04-01

# Rebuild SQLite index from JSONL
bollard history rebuild

# Export as JSON (for external tools)
bollard history --json
```

**Output format (default):**

```
$ bollard history

  Run ID                                   Status    Cost    Duration  Tests   Mutation
  ────────────────────────────────────────  ────────  ──────  ────────  ──────  ────────
  20260422-1430-impl-feat-add-watch-a3b    success   $1.42   3m 22s   862/4   71.2%
  20260420-0900-impl-feat-jvm-audit-c1f    success   $0.63   2m 01s   769/4   —
  20260417-1100-impl-feat-cost-sum-b2e     success   $0.63   1m 48s   705/4   —
  
  3 runs | 100% success | avg $0.89 | avg 2m 24s
```

**Output format (summary):**

```
$ bollard history summary --since 2026-04-01

  Bollard run history (since 2026-04-01)
  
  Total runs:       12
  Success rate:     91.7% (11/12)
  Avg cost:         $1.12
  Avg duration:     2m 45s
  Avg test count:   743
  Avg mutation:     68.4%
  Cost trend:       decreasing ↓
  
  By blueprint:
    implement-feature    8 runs   87.5%   $1.38 avg
    verify               4 runs   100%    $0.00 avg
```

### `bollard history show <run-id>`

```
$ bollard history show 20260422-1430-impl-feat-add-watch-a3b

  Run: 20260422-1430-impl-feat-add-watch-a3b
  Task: Add bollard_watch_status MCP tool
  Blueprint: implement-feature
  Status: success
  Cost: $1.42 | Duration: 3m 22s
  Branch: bollard/20260422-1430-impl-feat-add-watch-a3b
  SHA: adfad44
  
  Nodes:
    ✓ create-branch           0ms     $0.00
    ✓ generate-plan           12.3s   $0.08
    ✓ approve-plan            0ms     $0.00   (auto-approved)
    ✓ implement               142.1s  $1.22
    ✓ static-checks           8.2s    $0.00
    ...
    ✓ approve-pr              0ms     $0.00   (auto-approved)
  
  Scopes:
    boundary    5 claims → 5 grounded (0 dropped) | 12 tests passed
    contract    6 claims → 6 grounded (0 dropped) | 8 tests passed
    behavioral  disabled
  
  Mutation: 71.2% (threshold: 60%)
  Tests: 862 passed, 4 skipped
```

### MCP tools (2 new)

- `bollard_history` — query run history with filters, return structured results
- `bollard_history_summary` — aggregate stats for a time window

These follow the Stage 4d MCP DX principles: structured output with actionable fields, not raw data dumps.

---

## 5. `bollard doctor` Integration

`bollard doctor` (existing) gains a `--history` flag that checks run history health:

```bash
$ bollard doctor --history

  Run history:
    ✓ history.jsonl exists (42 records)
    ✓ history.db is current (42 records, last rebuild 2m ago)
    ✓ Last run: 20260422-1430 (success, 3m ago)
    ⚠ Cost trend: increasing over last 5 runs ($0.63 → $1.42)
    ✓ No failing nodes in last 3 runs
    ✓ Mutation score stable (68-72% over last 5 runs)
```

---

## 6. Forward Design: Bollard-on-Bollard CI (5a Phase 2)

Not in the first deliverable, but the run history design must support it.

### GitHub Actions workflow

```yaml
# .github/workflows/bollard-verify.yml
name: Bollard Verify
on: [pull_request]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: docker compose build dev
      - run: docker compose run --rm dev --filter @bollard/cli run start -- verify --quiet
      - run: docker compose run --rm dev --filter @bollard/cli run start -- history --json > verify-result.json
      # Upload history as artifact for trend tracking
      - uses: actions/upload-artifact@v4
        with:
          name: bollard-run-history
          path: .bollard/runs/history.jsonl
```

### Bootstrap paradox resolution

Bollard-on-Bollard CI verifies *Bollard changes* using *the current Bollard* (from the PR branch). This is not a paradox — it's the same pattern as a compiler compiling itself: the toolchain under test is also the toolchain doing the testing. If the change breaks Bollard's own verification, the CI fails — which is exactly what we want.

The one edge case: a change to the runner itself. If the runner has a bug that makes it report false success, Bollard-on-Bollard can't catch it. This is mitigated by:

1. The unit test suite (862 tests) catches runner bugs at the function level.
2. Mutation testing catches undertested runner paths.
3. The semantic reviewer flags suspicious changes to core engine files.
4. Protocol compliance CI (Phase 3) uses a *different* validation path than the runner itself.

---

## 7. Forward Design: Protocol Compliance CI (5a Phase 3)

Also not in the first deliverable, but shapes the run history schema.

### Concept

Automate the Bollard-on-Bollard self-test pattern:

1. Generate IDE config (`bollard init --ide cursor`)
2. Feed the generated rules + a synthetic task to an LLM
3. Observe which tools the model calls
4. Score against the 5-point compliance checklist from ADR-0003

### Run history support

Protocol compliance runs are stored as `RunRecord` with `blueprintId: "protocol-compliance"` and a dedicated `compliance` field:

```typescript
interface ComplianceResult {
  platform: "cursor" | "claude-code" | "codex" | "antigravity"
  task: string
  checklistItems: Array<{
    item: string
    passed: boolean
    evidence?: string    // which tool call or lack thereof
  }>
  score: number          // 0–5 (of the 5-point checklist)
  rawToolCalls: string[] // for audit
}
```

This lets `bollard history summary` report protocol compliance trends alongside cost/test/mutation trends.

### Cost consideration

Each protocol compliance run costs ~$0.10–0.30 (one short LLM interaction to simulate the task). Running on every PR is feasible. Running for all four platforms on every PR costs ~$0.40–1.20 — still acceptable if limited to changes that touch generators, prompts, or MCP tools.

---

## 8. Package Location

Run history lives in `@bollard/engine`, not `@bollard/observe`:

- `**@bollard/engine**` owns `PipelineContext`, `RunResult`, `CostTracker` — run history is a direct extension of these.
- `**@bollard/observe**` owns production feedback (probes, metrics, drift, flags) — runtime behavior of the *deployed* system.
- Run history is about the *build* pipeline, not the *deployed* system.

New files:

```
packages/engine/src/
  run-history.ts         # RunRecord, RunHistoryStore, FileRunHistoryStore
  run-history-db.ts      # SQLite layer (separate file for optional dep isolation)
```

The SQLite layer is imported dynamically (`await import("./run-history-db.js")`) so that environments without `better-sqlite3` get JSONL-only operation with no import errors.

---

## 9. Implementation Plan

### Phase 1: Core types + JSONL store (no SQLite)

1. Define `RunRecord`, `VerifyRecord`, `RunHistoryStore` types in `packages/engine/src/run-history.ts`
2. Implement `FileRunHistoryStore` with JSONL append + JSONL scan for queries
3. Wire `record()` call into CLI `implement-feature` and `verify` commands
4. Add `bollard history` CLI command (basic: list, show, compare)
5. Tests: record/query/compare round-trip, JSONL format stability, concurrent append safety

### Phase 2: SQLite query layer

1. Add `better-sqlite3` dependency to `@bollard/engine`
2. Implement `SqliteRunHistoryIndex` in `packages/engine/src/run-history-db.ts`
3. `rebuild()` reads JSONL, populates SQLite tables
4. `query()` and `summary()` use SQLite when available, fall back to JSONL scan
5. Add `bollard history rebuild` and `bollard history summary` commands
6. Wire into `bollard doctor --history`
7. Tests: rebuild correctness, staleness detection, fallback behavior

### Phase 3: MCP tools + watch integration

1. Add `bollard_history` and `bollard_history_summary` MCP tools
2. Wire `bollard watch` verify completions into history (source: "watch")
3. Wire MCP `handleVerify` completions into history (source: "mcp")

### Phase 4: CI-aware verification + test promotion

1. Implement `detectCIEnvironment` — env var detection for GitHub Actions, GitLab CI, CircleCI, Jenkins, Buildkite
2. JUnit XML reader — parse standard test result artifacts
3. Local build cache staleness detection (tsbuildinfo, biome cache, vitest cache)
4. `--ci-passed` flag on `verify` and `run` commands (explicit injection escape hatch)
5. `skipChecks` parameter on `runStaticChecks`
6. Test fingerprinting — `TestFingerprint` type, SHA-256 hash of normalized assertion structure
7. Store fingerprints in `RunRecord.scopes[].testFingerprints`
8. Promotion candidate detection: bug-catcher (test failed → code fixed → test passed) + repeated generation (3+ runs with same fingerprint)
9. Promotion flow at `approve-pr` gate: present candidates, user selects, `rewriteImportsForPromotion`, strip markers, update `.bollard/promoted.json`
10. Skip regeneration of promoted tests during adversarial pass
11. Tests: CI detection for each provider, JUnit XML parsing, fingerprint stability, promotion import rewriting

### Phase 5: CI workflow (Bollard-on-Bollard)

1. Add `.github/workflows/bollard-verify.yml`
2. `bollard verify --quiet` already exists — CI uses its exit code
3. Run history artifact upload for cross-run trend tracking
4. Optional: `bollard history compare --ci` that compares against `main` branch baseline

### Phase 6: Protocol compliance CI

1. Add `bollard audit-protocol` CLI command
2. Implement synthetic task runner (sends task + rules to LLM, captures tool calls)
3. Implement checklist scorer
4. Add ComplianceResult to run history schema
5. CI integration: run on changes to `generators/`, `prompts/`, `packages/mcp/`

---

## 10. Dependencies

### New runtime dependencies

- `better-sqlite3` — SQLite bindings for Node.js. ~3 MB, no external deps, prebuilt binaries for Linux/macOS/Windows. Already used by many Node CLIs. **Optional** — JSONL-only mode works without it.

### Docker image impact

- `dev` image: +~3 MB for `better-sqlite3` prebuilt binary (already has `node-gyp` prerequisites from other native deps)
- `dev-full` image: same +~3 MB
- No new system packages required

### No new external services

Run history is entirely local. No network calls, no cloud storage, no API keys. Same zero-external-deps principle as all of `@bollard/observe`.

---

## 11. Success Criteria

### Phase 1 (first deliverable)

- `bollard run implement-feature --task "..."` appends a `RunRecord` to `.bollard/runs/history.jsonl`
- `bollard verify` appends a `VerifyRecord` to the same file
- `bollard history` lists recent runs with status, cost, duration, test count
- `bollard history show <id>` prints detailed node-by-node breakdown
- `bollard history compare <a> <b>` shows deltas
- JSONL format is stable (schema version in each record for forward compatibility)
- Round-trip test: record → query → verify fields match
- Concurrent append safety (file locking or atomic rename)

### Phase 2

- `bollard history summary` uses SQLite for O(1) aggregation
- SQLite DB rebuilds automatically when JSONL has more records
- Fallback to JSONL scan when `better-sqlite3` is unavailable
- `bollard doctor --history` reports health
- `.gitignore` includes `history.db`

### Phase 3

- MCP `bollard_history` returns structured results with the same shape as CLI
- `bollard watch` verify events appear in history with `source: "watch"`

---

## 12. CI-Aware Verification

### 12.1 Problem

When Bollard runs inside an existing CI pipeline (GitHub Actions, GitLab CI, local dev loop), it re-runs checks that another step already completed — typecheck, lint, audit. This wastes time and compute. Bollard should be smart enough to detect what already ran and skip redundant work, focusing on its unique value: adversarial testing.

### 12.2 Detection hierarchy

Bollard detects its environment and available results in three tiers, always degrading toward *more* verification (never less):

**Tier 1 — CI artifact ingestion (strongest signal).** Bollard detects it's running in CI via well-known environment variables (`GITHUB_ACTIONS`, `GITLAB_CI`, `CIRCLECI`, `JENKINS_URL`, `BUILDKITE`). It then looks for standard result artifacts:

- **JUnit XML** — the de facto cross-ecosystem standard. Vitest (`--reporter=junit`), pytest (`--junitxml`), `go test` (via `gotestsum`), Maven Surefire, Gradle all produce it. Bollard reads the XML, extracts pass/fail/skip counts and individual test names.
- **CI step metadata** — GitHub Actions exposes step outcomes in `$GITHUB_STEP_SUMMARY` and check annotations. Bollard can infer which checks passed from the workflow run context.

If Bollard finds results for typecheck/lint/audit/test that already passed, it skips those checks and jumps to adversarial scopes.

**Tier 2 — Bollard's own `last-verified.json` (local dev).** For local developers, Bollard tracks its own verification state rather than sniffing tool-specific cache files (which are fragile and tool-version-dependent). Every successful `bollard verify` writes `.bollard/observe/last-verified.json` (already used by the drift detector):

```json
{
  "gitSha": "adfad44",
  "timestamp": 1714567890123,
  "checks": {
    "typecheck": { "passed": true, "durationMs": 2100 },
    "lint": { "passed": true, "durationMs": 1400 },
    "test": { "passed": true, "durationMs": 8200 },
    "audit": { "passed": true, "durationMs": 900 }
  }
}
```

On the next run, Bollard compares `last-verified.json` against `HEAD`:
- **Same SHA** → all recorded checks are skippable (nothing changed since last verify)
- **Different SHA** → run everything (source changed, prior results are stale)

This is simpler and more reliable than sniffing `tsconfig.tsbuildinfo` or `.eslintcache` timestamps. Bollard controls the data format, the staleness logic is trivial (SHA match = fresh), and it works identically regardless of the user's toolchain.

**Integration model: Bollard as smart observer, not script injector.** Bollard does NOT modify `package.json` scripts, inject `posttest` hooks, or chain itself into the user's existing commands. Instead:

- `bollard watch` observes file changes and verifies continuously — if the user ran `pnpm test` themselves, `watch` sees the resulting file changes and updates `last-verified.json` on its next verify cycle.
- `bollard verify` checks `last-verified.json` before running checks — if they already passed at the current SHA, it skips them.
- **Optional pre-commit hook** (via `bollard init`): the one enforcement point where Bollard insists on verification before code leaves the working tree. `bollard init` can offer to install a git pre-commit hook that calls `bollard verify --quiet`. This is opt-in, non-destructive, and runs at a natural boundary (commit time). It coexists cleanly with Cursor (which verifies during editing), Docker (the hook can detect Docker availability and route accordingly), and CI (which has its own checks).

This approach avoids coupling with any specific tool, framework, or IDE. Bollard benefits from what already happened without injecting itself into the user's workflow.

**Tier 3 — Run everything (fallback).** No CI detected, no `last-verified.json`, or SHA mismatch → Bollard runs all checks itself, making its own opinionated choices based on `ToolchainProfile`. This is the current behavior and remains the default for projects with no CI.

### 12.3 Implementation: `detectCIEnvironment`

Extends the `detectToolchain` pattern — deterministic, file/env-based, no LLM:

```typescript
interface CIEnvironment {
  provider: "github-actions" | "gitlab-ci" | "circleci" | "jenkins" | "buildkite" | "local" | "unknown"
  priorResults: PriorCheckResult[]
  artifactPaths: string[]           // where to find JUnit XML, etc.
}

interface PriorCheckResult {
  check: "typecheck" | "lint" | "test" | "audit" | "secretScan"
  source: "junit-xml" | "ci-step" | "cache-timestamp" | "injected"
  passed: boolean
  timestamp: number
  detail?: string                    // e.g. "12 passed, 0 failed" from JUnit
}
```

The `runStaticChecks` function gains an optional `skipChecks` parameter:

```typescript
// Before (current)
runStaticChecks(workDir, profile?)

// After
runStaticChecks(workDir, profile?, skipChecks?: string[])
```

Checks in `skipChecks` emit a `skipped (prior CI pass)` result instead of running.

### 12.4 Explicit injection (escape hatch)

For CI setups where artifact detection doesn't work, Bollard accepts explicit injection:

```bash
bollard verify --ci-passed typecheck,lint,audit
bollard run implement-feature --task "..." --ci-passed typecheck,lint
```

This is the simplest integration path: the CI workflow knows what it already ran and tells Bollard directly.

### 12.5 What Bollard NEVER skips

Regardless of CI context, Bollard always runs:

- **Adversarial scope agents** (boundary, contract, behavioral) — this is Bollard's unique value
- **Grounding verification** — deterministic, never redundant
- **Mutation testing** (when enabled) — not run by conventional CI
- **Semantic review** — not run by conventional CI
- **Test execution of Bollard-generated tests** — even if prior tests passed, adversarial tests are new

The principle: Bollard skips what any CI can do, keeps what only Bollard can do.

---

## 13. Adversarial Test Promotion

### 13.1 Problem

Bollard currently regenerates adversarial tests from scratch every pipeline run. This is expensive (LLM calls) and wasteful when the same tests keep being generated for the same gaps. Tests that catch real bugs or are repeatedly generated should become permanent — but only with user approval.

### 13.2 Promotion criteria

Two signals trigger automatic promotion candidacy:

**Signal 1 — Bug catcher (strongest).** An adversarial test *failed* during the pipeline, the coder fixed the code, and the test *passed* on re-run. This test is now a regression guard — it found a real defect that was fixed. Bollard flags it immediately.

**Signal 2 — Repeated generation.** The same test (by assertion fingerprint) has been generated in 3+ pipeline runs. The LLM keeps producing it because the gap is real and persistent. This requires run history (Stage 5a Phase 1) to detect — Bollard compares test fingerprints across `RunRecord`s.

Everything else (tests that pass on first run, tests generated only once) is left to the user's discretion. `bollard promote-test <path>` already exists for manual promotion.

### 13.3 Test fingerprinting

To detect repeated generation, Bollard needs a stable fingerprint for adversarial tests that's invariant to variable naming and formatting:

```typescript
interface TestFingerprint {
  scope: "boundary" | "contract" | "behavioral"
  targetModule: string              // which module the test targets
  assertionTypes: string[]          // sorted: ["rejects", "throws", "toBe", ...]
  inputPatterns: string[]           // normalized: ["null", "empty-string", "negative-number", ...]
  hash: string                     // SHA-256 of the above, for fast comparison
}
```

The fingerprint captures *what* the test checks (assertion types, input patterns) without being sensitive to *how* it's written (variable names, formatting, comments). Two tests that both check "null input to `processOrder` throws `TypeError`" produce the same fingerprint even if the code differs.

Fingerprints are stored in `RunRecord` as an optional field:

```typescript
interface ScopeResult {
  // ... existing fields ...
  testFingerprints?: TestFingerprint[]   // for promotion candidate detection
}
```

### 13.4 Promotion flow

At the `approve-pr` human gate (node 28 in `implement-feature`), Bollard presents promotion candidates alongside the diff summary and review findings:

```
Promotion candidates (3 tests):

  🔴 Bug catcher — boundary test caught null-input crash in processOrder()
     .bollard/tests/boundary/process-order.boundary.test.ts
     → Recommend: tests/process-order.test.ts

  🔁 Repeated (4 runs) — contract test validates UserService.getById return type
     .bollard/tests/contract/user-service.contract.test.ts
     → Recommend: tests/user-service.contract.test.ts

  🔁 Repeated (3 runs) — boundary test checks empty-array edge case in aggregate()
     .bollard/tests/boundary/aggregate.boundary.test.ts
     → Recommend: tests/aggregate.test.ts

Promote? [y/n/select]
```

The user can:
- `y` — promote all candidates
- `n` — skip all
- `select` — choose individually

### 13.5 What promotion does

1. **Copy** the test file from `.bollard/tests/` to the project's test directory
2. **Rewrite imports** — `rewriteImportsForPromotion(content, fromPath, toPath, profile)` adjusts relative import paths based on the new location. This is deterministic — TS `import from`, Python `from X import`, Go package paths are all string transforms
3. **Strip markers** — remove `@bollard-generated` comments
4. **Register** — add the promoted test's fingerprint to a `.bollard/promoted.json` manifest so Bollard knows not to regenerate it

### 13.6 What is NOT promotable

A test is excluded from promotion candidacy if it:

- **Depends on Bollard infrastructure** — uses `generateBehavioralCompose`, Docker fault injection, or other Bollard-specific setup. Most behavioral tests with fault injection fall here.
- **Is not self-contained** — requires external services, fixtures, or state that only exists during the Bollard pipeline run.
- **Duplicates an existing project test** — Bollard checks the project's test directory for tests covering the same assertion fingerprint before proposing promotion.

Boundary and contract tests almost always qualify. Behavioral tests qualify only when they're pure HTTP assertion tests without fault injection.

### 13.7 Relationship to run history

Test promotion depends on Stage 5a Phase 1 (run history) for:
- **Signal 2 detection** — fingerprint comparison across runs requires `RunRecord.scopes[].testFingerprints`
- **Promotion tracking** — `promoted.json` is referenced during test generation to avoid regenerating promoted tests
- **Trend analysis** — `bollard history summary` can report promotion rate (what fraction of adversarial tests become permanent)

---

## 14. Non-Goals (This Stage)

- **Cross-machine run history sync** — history is per-repo, per-machine. Sync is a future concern.
- **Run history UI** — CLI and MCP are sufficient. A web dashboard is Stage 5b+.
- **Run replay** — re-running a historical run with the same inputs. Interesting but requires snapshotting the entire codebase state.
- **Automatic regression alerting** — `compare` is manual. Automated "this run is worse than the last 5" is Stage 5b.
- **Run history pruning** — JSONL files grow linearly. For Bollard's own development cadence (~10 runs/week), a year of history is ~500 KB. Pruning is not needed yet.
- **Automatic test promotion without user approval** — Bollard always asks before committing candidates to the permanent suite. Fully autonomous promotion is an explicit non-goal.
- **CI pipeline generation** — Bollard reads CI results and skips redundant checks, but it does not generate CI workflow files (GitHub Actions YAML, etc.). `bollard init --ide` covers IDE config; CI workflow generation is a separate concern.
- **Cross-CI provider abstraction** — Bollard detects CI environment and reads artifacts, but doesn't provide a unified CI API. Each provider (GitHub Actions, GitLab, etc.) has its own detection logic.

---

## 15. Design Principles Applied

- **Principle 1 (deterministic guardrails):** Run history capture is fully deterministic — no LLM calls, no creative decisions.
- **Principle 2 (convention over configuration):** Zero config. History is always captured to `.bollard/runs/`. No opt-in, no YAML section.
- **Principle 3 (minimal deps):** One optional dep (`better-sqlite3`). JSONL works with zero deps.
- **Principle 15 (protocols need structure):** MCP tool descriptions for `bollard_history` will follow the WHY + structured output pattern from ADR-0003.

---

*Run history is the foundation. Once we can see trends, CI becomes "run the pipeline and check the trend." Protocol compliance becomes "run the self-test and check the trend." Everything in Stage 5 builds on the ability to compare this run to the last one.*