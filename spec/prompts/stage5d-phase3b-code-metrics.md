# Cursor Prompt — Stage 5d Phase 3b: Deterministic Code Metrics + Load Testing

> **Purpose:** Add two deterministic nodes to the pipeline:
> 1. `extract-code-metrics` — between `generate-review-diff` and `semantic-review`. Collects coverage delta, complexity hotspots, SAST findings, git churn, CVE detail, and probe latency percentiles. Injects all of it as structured context into the semantic reviewer so it stops inferring what it can now read.
> 2. `run-load-tests` — optional stage inside `run-behavioral-tests`, activated when k6 is on PATH and `metrics.loadTest.enabled: true` in `.bollard.yml`. Produces p95/p99 latency and error-rate data that feeds into the semantic reviewer and probe perf report.
>
> **Tier (per ADR-0004):** Fully Tier 1 — zero LLM calls, zero new mandatory image deps. Every tool is either already in the `dev` image (`rg`, `git`, language-native coverage CLIs) or opt-in via `dev-full` (k6, semgrep). All extractors degrade gracefully to empty/zero when the tool is absent.

Read CLAUDE.md fully before writing any code. Then read:
- `spec/adr/0004-determinism-local-frontier-tiers.md` — Tier 1 confirmation
- `spec/adr/0001-deterministic-filters-for-llm-output.md` — grounding principle
- `packages/verify/src/static.ts` — pattern for tool execution + structured results
- `packages/verify/src/behavioral-extractor.ts` — pattern for regex-based extraction
- `packages/agents/prompts/semantic-reviewer.md` — what the reviewer currently sees (only diff + plan)
- `packages/cli/src/agent-handler.ts` — `buildSemanticReviewerMessage` to extend
- `packages/blueprints/src/implement-feature.ts` — insertion points: after node 25 (`generate-review-diff`) and inside `run-behavioral-tests` (node 22)
- `packages/detect/src/types.ts` — `ToolchainProfile`, `VerificationCommand`
- `packages/observe/src/providers/types.ts` — `ProbeResult`, `ProbeRunSummary`

---

## Tool decision matrix (evaluated against Bollard's constraints)

Every tool was evaluated against: self-contained Docker dev image, language-agnostic where possible, integrate with user's existing project config first, opinionated fallback, never block the pipeline.

| Tool | Decision | Where | Why |
|------|----------|-------|-----|
| `rg` patterns (SAST) | ✅ `dev` image | `extract-code-metrics` | Already in image; curated embedded patterns; no config needed |
| Semgrep | ✅ `dev-full` upgrade | `extract-code-metrics` | `which semgrep` → use OWASP rulesets; else `rg` fallback |
| Coverage (v8/go/tarpaulin/pytest-cov) | ✅ language-native | `extract-code-metrics` | Already present in any project running tests; detect + degrade |
| Git churn | ✅ `dev` image | `extract-code-metrics` | `git log` always available |
| CVE JSON (`pnpm audit --json` etc.) | ✅ already runs | `extract-code-metrics` | Re-run with `--json` for structured detail; same tool as `static-checks` |
| Probe latency percentiles | ✅ local JSONL | `extract-code-metrics` | Reads `FileMetricsStore` — no new dep |
| Complexity from diff | ✅ pure TS | `extract-code-metrics` | Parse `+` hunk lines; count decision keywords; zero deps |
| **k6** | ✅ `dev-full` opt-in | `run-behavioral-tests` | Single static binary; JS tests; `--out json`; fits Docker Compose model |
| axe-core | 🔜 later | behavioral scope | Right tool for UI projects; separate PR after Phase 3b |
| OWASP ZAP | 🔜 later | behavioral compose | Needs live service; separate compose service in `dev-full` |
| Prometheus | 🔜 Stage 4b+ | observe provider | Interface exists; implementation deferred |
| Chaos Mesh | ❌ | — | K8s-only; use `tc` for `network_delay` in existing `FaultInjector` |
| SonarQube | ❌ | — | Requires external server; breaks self-contained Docker model |
| Gatling / JMeter / Artillery | ❌ | — | k6 covers this; redundant |
| SQLMap | ❌ | — | Exploitation tool, not scanner; `rg` covers SQL injection detection |
| KICS | ❌ | — | IaC-only; out of scope for Bollard's `LanguageId` set |
| Sitespeed.io | ❌ | — | Too heavy; k6 covers perf; axe-core covers usability (later) |
| ESLint/Pylint/PMD | ✅ already done | `static-checks` | Biome/ruff/golangci-lint/clippy already wired per language |
| SpotBugs/PMD (JVM) | 🔜 small add | `java.ts` detector | Add as `checks.sast` in Java detector; separate PR |

---

## What to build

### Part A — `extract-code-metrics` node

#### A1. New file: `packages/verify/src/code-metrics.ts`

Pure functions + async tool runners. Every extractor has its own try/catch and returns zero/empty on failure.

##### A1a. Coverage delta on changed files

```typescript
export interface FileCoverage {
  file: string        // relative path
  lines: number
  coveredLines: number
  pct: number         // 0–100
}

export interface CoverageDelta {
  tool: "v8" | "go-cover" | "tarpaulin" | "pytest-cov" | "none"
  changedFiles: FileCoverage[]
  overallPct: number | null   // null when tool unavailable
  note?: string
}
```

Detection (profile-driven, `tool: "none"` on timeout/missing):
- **TypeScript/JavaScript**: detect `@vitest/coverage-v8` in `node_modules`. Run `vitest run --coverage --reporter=json --coverage.reporter=json`. Limit to test files that import any changed source file (pass as positional args). Parse `coverage/coverage-summary.json`. Timeout 60s.
- **Go**: `go test -coverprofile=.bollard/cover.out ./...` then `go tool cover -func=.bollard/cover.out`. Parse, filter to changed files. Timeout 60s.
- **Rust**: detect `cargo-tarpaulin`. Run `cargo tarpaulin --out Json --output-dir .bollard/`. Parse `tarpaulin-report.json`. Timeout 90s.
- **Python**: detect `pytest-cov` via `python3 -c "import pytest_cov"`. Run `python3 -m pytest --cov --cov-report=json:.bollard/coverage.json`. Parse. Timeout 60s.
- All others → `tool: "none"`.

##### A1b. Complexity hotspots (pure diff parsing — zero new deps)

```typescript
export interface ComplexityHotspot {
  file: string
  functionName: string  // best-effort: nearest function|def|func|fn|pub fn before hunk
  decisionPoints: number  // if|else if|for|while|switch|case|catch|&&|\|\||\?:
  added: boolean
}

export interface ComplexityReport {
  hotspots: ComplexityHotspot[]  // sorted desc by decisionPoints
  maxDecisionPoints: number
  filesAnalysed: number
}
```

Parse the unified diff string. For each `+` hunk: find nearest preceding context line matching `function|def|func|fn |pub fn|class ` (the `@@` header often contains the function name — prefer it). Count decision-point keywords on `+` lines only within that function block. Flag as hotspot if `decisionPoints >= hotspotThreshold` (default 5, configurable via `MetricsConfig`). Pure TypeScript string parsing — no external tool.

##### A1c. SAST via `rg` with Semgrep upgrade path

```typescript
export interface SastFinding {
  pattern: string    // "eval-misuse", "sql-concat", "path-traversal", etc.
  file: string
  line: number
  match: string      // truncated to 200 chars
  severity: "high" | "medium" | "low"
  source: "rg" | "semgrep"
}

export interface SastReport {
  findings: SastFinding[]
  patternsChecked: number
  filesScanned: number
  tool: "semgrep" | "rg"
}
```

**Detection order:**
1. `which semgrep` → run `semgrep --config p/owasp-top-ten --config p/secrets --json` against changed files. Parse JSON output. `tool: "semgrep"`.
2. Else → `rg` embedded patterns (`tool: "rg"`):

```typescript
const SAST_PATTERNS = [
  // Injection
  { name: "eval-misuse",         pattern: String.raw`\beval\s*\(`,                                         severity: "high",   langs: ["typescript","javascript","python"] },
  { name: "sql-concat",          pattern: String.raw`(query|sql|SQL)\s*[+]=?\s*["'\`]`,                   severity: "high",   langs: ["typescript","javascript","python","java","kotlin"] },
  { name: "shell-exec",          pattern: String.raw`\b(execSync|child_process|os\.system|subprocess\.call)\b`, severity: "high", langs: ["typescript","javascript","python"] },
  { name: "path-traversal",      pattern: String.raw`\.\./|path\.join\([^)]*req\b`,                        severity: "high",   langs: ["typescript","javascript"] },
  // Secrets (complement gitleaks which runs in static-checks)
  { name: "hardcoded-secret",    pattern: String.raw`(password|secret|api_key|token)\s*=\s*["'][^"']{8,}["']`, severity: "high", langs: ["typescript","javascript","python","java","kotlin","go","rust"] },
  { name: "hardcoded-jwt",       pattern: String.raw`eyJ[A-Za-z0-9_-]{20,}`,                               severity: "medium", langs: ["typescript","javascript","python","java","kotlin"] },
  // Unsafe patterns
  { name: "prototype-pollution", pattern: String.raw`\.__proto__\s*=|\[["']__proto__["']\]`,               severity: "high",   langs: ["typescript","javascript"] },
  { name: "regex-dos",           pattern: String.raw`new RegExp\([^)]*\+`,                                 severity: "medium", langs: ["typescript","javascript"] },
  { name: "unsafe-deserialize",  pattern: String.raw`\bpickle\.loads?\b|\byaml\.load\b`,                  severity: "high",   langs: ["python"] },
  { name: "go-unchecked-err",    pattern: String.raw`^\s*[a-zA-Z_]+,\s*_\s*:?=`,                         severity: "low",    langs: ["go"] },
  { name: "rust-unwrap",         pattern: String.raw`\.unwrap\(\)`,                                        severity: "low",    langs: ["rust"] },
  { name: "java-sql-concat",     pattern: String.raw`Statement.*execute.*\+`,                              severity: "high",   langs: ["java","kotlin"] },
  { name: "java-xxe",            pattern: String.raw`DocumentBuilderFactory|SAXParserFactory`,             severity: "medium", langs: ["java","kotlin"] },
] as const
```

Filter patterns by `profile.language`. Run `rg --json -n` per pattern × per changed file. Only flag lines appearing in `+` hunks. Deduplicate by `(file, line)`.

##### A1d. Git churn score

```typescript
export interface ChurnScore {
  file: string
  commitCount: number
  churnRisk: "low" | "medium" | "high"  // <10 / <30 / >=30 (configurable via MetricsConfig)
}
```

`git log --follow --oneline -- <file>` per changed file. Count output lines. Always available.

##### A1e. CVE detail from audit JSON

```typescript
export interface CveDetail {
  package: string
  severity: string
  title: string
  url?: string
}

export interface AuditDetail {
  tool: "pnpm-audit" | "cargo-audit" | "pip-audit" | "none"
  criticalCount: number
  highCount: number
  details: CveDetail[]  // top 5 by severity
}
```

Re-run audit with `--json` (same tool as `static-checks` but structured output — does NOT replace the gating pass/fail check):
- pnpm: `pnpm audit --json` → parse `advisories` map
- cargo: `cargo audit --json` → parse `vulnerabilities.list`
- Python: `pip-audit --format=json` if on PATH
- Timeout 30s; `tool: "none"` on failure.

##### A1f. Probe latency percentiles (production performance)

```typescript
export interface ProbePerf {
  probeId: string
  endpoint: string
  sampleCount: number
  avgMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  maxMs: number
  failRate: number   // 0–1
  trend: "improving" | "stable" | "degrading" | "insufficient-data"
}

export interface ProbePerfReport {
  probes: ProbePerf[]
  windowMs: number
  source: "file-metrics-store" | "k6" | "none"
}
```

Read `.bollard/observe/metrics.jsonl` (written by `FileMetricsStore`). Also read `.bollard/observe/k6-latest.json` if present (written by Part B). Per `probeId`: sort by timestamp, take last `windowResults` results (default 100) or 24h window. Compute percentiles via sort. Trend: avg of last-20% vs first-20% — "degrading" if delta > 15%. Return `source: "none"` if neither file exists.

#### A2. New file: `packages/verify/src/code-metrics-runner.ts`

```typescript
export interface CodeMetrics {
  coverage: CoverageDelta
  complexity: ComplexityReport
  sast: SastReport
  churn: ChurnScore[]
  audit: AuditDetail
  probePerf: ProbePerfReport
  durationMs: number
}

export async function extractCodeMetrics(
  workDir: string,
  diff: string,
  changedFiles: string[],
  profile: ToolchainProfile,
  warn: (msg: string, data?: unknown) => void,
): Promise<CodeMetrics>
```

Run all six extractors with `Promise.all`. Each has independent try/catch returning zero/empty. Hard overall timeout: 90s via `Promise.race`. Never throws.

#### A3. New blueprint node `extract-code-metrics`

Insert between `generate-review-diff` (node 25) and `semantic-review` (node 26):

```typescript
{
  id: "extract-code-metrics",
  name: "Extract Code Metrics",
  type: "deterministic",
  onFailure: "skip",
  execute: async (ctx: PipelineContext): Promise<NodeResult> => {
    const diffRes = ctx.results["generate-review-diff"]?.data as { diff?: string } | undefined
    const diff = diffRes?.diff ?? ""
    const profile = ctx.toolchainProfile
    if (!profile || !diff.trim()) {
      return { status: "ok", data: { skipped: true, reason: "no diff or profile" } }
    }
    const metrics = await extractCodeMetrics(
      workDir, diff, ctx.changedFiles ?? [], profile, ctx.log.warn
    )
    ctx.log.info("code_metrics_result", {
      event: "code_metrics_result",
      runId: ctx.runId,
      coverageTool: metrics.coverage.tool,
      coveragePct: metrics.coverage.overallPct,
      complexityHotspots: metrics.complexity.hotspots.length,
      sastFindings: metrics.sast.findings.length,
      sastTool: metrics.sast.tool,
      auditHigh: metrics.audit.highCount,
      auditCritical: metrics.audit.criticalCount,
      probeCount: metrics.probePerf.probes.length,
      probePerfSource: metrics.probePerf.source,
      durationMs: metrics.durationMs,
    })
    return { status: "ok", data: { metrics } }
  },
}
```

#### A4. Update `buildSemanticReviewerMessage` in `packages/cli/src/agent-handler.ts`

Add a `## Code Metrics` section between the diff and the plan. Only emit sub-sections where data is non-empty:

- `### Coverage (<tool>)` — overall pct + per-file breakdown
- `### Complexity hotspots` — top 5 by decision-point count
- `### SAST findings (<tool>)` — severity / pattern / file:line / match
- `### High-churn files` — files with commitCount >= highThreshold
- `### Dependency vulnerabilities` — critical/high counts + top-5 details
- `### Degrading probe performance` — probes where `trend === "degrading"`
- `### Load test (k6)` — when `probePerf.source === "k6"`, show p95/p99/error_rate per endpoint; flag endpoints with `error_rate > 1%` or `p99 > 1000ms`

Close with: `"Review the diff against the plan. Use the code metrics above to ground findings in concrete data where relevant. Output a JSON ReviewDocument."`

#### A5. Update semantic-reviewer prompt

After `# Inputs`, add:

```markdown
- **Code metrics** (when present, between diff and plan): coverage % on changed files,
  complexity hotspots (decision-point count in new code), SAST findings (rg patterns or
  semgrep OWASP rules on added lines only), git churn scores, CVE detail, probe latency
  percentiles, and optionally k6 load test results. These are deterministically computed —
  cite them in grounding when relevant. A finding grounded in a concrete number
  ("coverage 21% on changed file", "p99=1240ms above 1s threshold") is stronger than
  an inference from reading the diff.
```

Add two new `ReviewCategory` values to `review-grounding.ts` and the `ReviewCategory` type:
- `"insufficient-coverage"` — coverage on changed files below threshold
- `"security-pattern"` — SAST finding, CVE, or hardcoded secret in changed code

#### A6. `ToolchainProfile` extension in `packages/detect/src/types.ts`

```typescript
export interface MetricsConfig {
  coverage:   { enabled: boolean; thresholdPct: number }        // default: true, 60
  complexity: { enabled: boolean; hotspotThreshold: number }    // default: true, 5
  sast:       { enabled: boolean }                              // default: true
  churn:      { enabled: boolean; highThreshold: number }       // default: true, 30
  probePerf:  { enabled: boolean; windowResults: number }       // default: true, 100
  loadTest:   { enabled: boolean; vus: number; durationSec: number } // default: false, 10, 30
}
```

Add `metrics?: MetricsConfig` to `ToolchainProfile`. Add `metrics:` Zod schema to `packages/cli/src/config.ts` with the same structure, merging user values over opinionated defaults. Defaults work without any user config — `loadTest.enabled` defaults to `false`.

---

### Part B — k6 load testing inside `run-behavioral-tests`

#### B1. Detection and execution

After the existing `runTests(...)` call in `run-behavioral-tests` (node 22), add an optional k6 stage. Conditions to run:
1. `which k6` succeeds
2. `behavioralCtx.endpoints.length > 0`
3. `profile.metrics?.loadTest?.enabled === true`

If all three: generate k6 script, run it, parse results into `ProbePerfReport`, write `.bollard/observe/k6-latest.json`.

The k6 stage never fails `run-behavioral-tests` — wrap in try/catch, log a warning on failure, continue.

#### B2. k6 script generation (pure TS, deterministic)

New function `generateK6Script(endpoints: EndpointEntry[], opts: { vus: number; durationSec: number }): string`:

Generate a k6 JavaScript script from `BehavioralContext.endpoints`. Each endpoint becomes an `http.get` / `http.post` call with a basic status assertion. Script:

```javascript
import http from 'k6/http'
import { check, sleep } from 'k6'
export const options = { vus: {{vus}}, duration: '{{duration}}s' }
const BASE = __ENV.BASE_URL || 'http://localhost:3000'
export default function () {
  // one check per endpoint
  const r1 = http.get(`${BASE}/api/health`)
  check(r1, { 'status 2xx': (r) => r.status >= 200 && r.status < 300 })
  sleep(0.1)
}
```

Write to `.bollard/k6-behavioral.js`. Run:
```bash
k6 run --out json=.bollard/observe/k6-latest.json \
   --env BASE_URL=<observe.baseUrl or http://localhost:3000> \
   --quiet \
   .bollard/k6-behavioral.js
```

Timeout: `(durationSec * 2) + 30` seconds. Parse `k6-latest.json` summary object for `http_req_duration` (p95/p99) and `http_req_failed` rate per endpoint group. Write into `ProbePerfReport` with `source: "k6"`.

---

### Part C — Tests

#### C1. `packages/verify/tests/code-metrics.test.ts`

Unit tests (all pure / mock-based — no real tool execution):
- `extractComplexityFromDiff`: diff with known `if/for/&&` → correct hotspot count; diff with 0 decision points → no hotspot
- `buildSastFindings` (rg path): file content with `eval(` → finding returned; clean file → empty; pattern filtered by wrong language → not applied
- `computeChurnScore`: mock git output 5 lines → "low"; 35 lines → "high"
- `aggregateProbePerf`: 100 probe JSONL entries → correct p50/p95/p99; empty file → `source: "none"`; degrading trend detected correctly
- `extractCveDetail`: mock `pnpm audit --json` → correct counts and top-5 details
- `generateK6Script`: 2 endpoints → script contains both URLs, correct vus/duration
- All extractors: tool-not-found path → zero/empty result, never throws

#### C2. Update `packages/blueprints/tests/implement-feature.test.ts`
- Node count: 31 (was 30)
- `"extract-code-metrics"` between `"generate-review-diff"` and `"semantic-review"`
- `onFailure: "skip"` asserted on `"extract-code-metrics"`

#### C3. Update review-grounding tests
- `"insufficient-coverage"` and `"security-pattern"` in `VALID_CATEGORIES` → pass validation
- Unknown category → still fails

---

## What NOT to do

- Do not add semgrep to the `dev` image — `dev-full` upgrade path only via `which semgrep`.
- Do not add k6 to the `dev` image — `dev-full` only, and only runs when `metrics.loadTest.enabled: true`. Default is off.
- Do not wire OWASP ZAP, Chaos Mesh, SonarQube, Gatling, JMeter, SQLMap, or KICS — none fit the self-contained Docker model or Bollard's scope.
- Do not run coverage on the full test suite — only test files importing changed source files.
- Do not block the pipeline: `onFailure: "skip"` on `extract-code-metrics`; k6 stage is best-effort inside `run-behavioral-tests`.
- Do not change the semantic-reviewer output schema or grounding verifier — metrics are input context only.
- Do not add `ReviewCategory` values beyond `"insufficient-coverage"` and `"security-pattern"`.
- Do not run probe perf if `.bollard/observe/metrics.jsonl` does not exist — return `source: "none"`.
- Do not wire axe-core, Sitespeed.io, or OWASP ZAP in this phase — later behavioral-compose extension.

---

## Validation checklist

```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test   # 31 nodes, code-metrics tests pass
docker compose run --rm dev --filter @bollard/cli run start -- verify --profile
```

Bollard-on-Bollard self-test (`CostTracker.divide`):
- `extract-code-metrics` node appears in run output (node 26 of 31)
- `code_metrics_result` event logged with all fields
- `buildSemanticReviewerMessage` output includes `## Code Metrics` section
- Semantic reviewer findings cite concrete metric data in grounding quotes
- `"insufficient-coverage"` and `"security-pattern"` accepted by `verify-review-grounding`
- k6 stage skips gracefully when k6 not on PATH (expected in `dev` image)
- No regression: existing grounding categories and drop rates unchanged
