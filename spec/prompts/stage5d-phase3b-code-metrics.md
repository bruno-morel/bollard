# Cursor Prompt — Stage 5d Phase 3b: Deterministic Code Metrics Extraction

> **Purpose:** Add a `extract-code-metrics` deterministic node between `generate-review-diff` and `semantic-review`. It collects concrete, machine-readable signals — coverage delta on changed files, complexity hotspots, SAST pattern hits, git churn, probe latency percentiles, CVE detail — and injects them into the semantic reviewer's context. The reviewer stops having to infer what it can now read. This is ADR-0004 Tier 1 applied to the review scope.
>
> **Zero new image deps.** Everything uses tools already in the `dev` image (`rg`, `git`, `pnpm`, `go`, `cargo`, `python3`) or already-available language-native coverage outputs. No semgrep, no external services.

Read CLAUDE.md fully before writing any code. Then read:
- `spec/adr/0004-determinism-local-frontier-tiers.md` — confirms this is Tier 1 work
- `spec/adr/0001-deterministic-filters-for-llm-output.md` — the grounding principle
- `packages/verify/src/static.ts` — pattern for running tools and returning structured results
- `packages/verify/src/behavioral-extractor.ts` — pattern for regex-based deterministic extraction
- `packages/agents/prompts/semantic-reviewer.md` — what the reviewer currently sees (only diff + plan)
- `packages/cli/src/agent-handler.ts` — `buildSemanticReviewerMessage` (the function to extend)
- `packages/blueprints/src/implement-feature.ts` — node 25/26 (`generate-review-diff` → `semantic-review`) to see the insertion point
- `packages/detect/src/types.ts` — `ToolchainProfile`, `VerificationCommand`
- `packages/observe/src/providers/types.ts` — `ProbeResult`, `ProbeRunSummary`, `ProbeSummary`

---

## What to build

### 1. New file: `packages/verify/src/code-metrics.ts`

This is the core deterministic extractor. Pure functions where possible, async where tool execution is needed.

#### 1a. Coverage delta on changed files

```typescript
export interface FileCoverage {
  file: string           // relative path
  lines: number          // total lines
  coveredLines: number
  pct: number            // 0–100
}

export interface CoverageDelta {
  tool: "v8" | "go-cover" | "tarpaulin" | "pytest-cov" | "none"
  changedFiles: FileCoverage[]
  overallPct: number | null   // null when tool unavailable
  note?: string
}
```

Detection logic (profile-driven, graceful degradation):
- **TypeScript/JavaScript**: detect `@vitest/coverage-v8` in `node_modules/.pnpm` or `node_modules/@vitest`. If present, run `vitest run --coverage --reporter=json --coverage.reporter=json` with `--testPathPattern` limited to test files touching the changed source files. Parse `coverage/coverage-summary.json` (Istanbul/v8 JSON format). If absent → `tool: "none"`.
- **Go**: run `go test -coverprofile=.bollard/cover.out ./...` then `go tool cover -func=.bollard/cover.out` → parse line-level output. Filter to changed files only.
- **Rust**: detect `cargo-tarpaulin` in `~/.cargo/bin`. If present, run `cargo tarpaulin --out Json --output-dir .bollard/` → parse `tarpaulin-report.json`. Filter to changed files.
- **Python**: detect `pytest-cov` via `python3 -c "import pytest_cov"`. If present, run `python3 -m pytest --cov --cov-report=json:/.bollard/coverage.json`. Parse. Filter to changed files.
- All: **timeout 60s**, return `tool: "none"` on timeout or tool-not-found. Never block the pipeline.

#### 1b. Complexity hotspots from diff hunks (zero new deps — uses `rg` + diff parsing)

```typescript
export interface ComplexityHotspot {
  file: string
  functionName: string    // best-effort from context lines
  decisionPoints: number  // count of: if|else if|for|while|switch|case|catch|&&|\|\||\?
  added: boolean          // true = new code, false = modified
}

export interface ComplexityReport {
  hotspots: ComplexityHotspot[]   // sorted desc by decisionPoints
  maxDecisionPoints: number
  filesAnalysed: number
}
```

Parse the unified diff from `ctx.results["generate-review-diff"].data.diff`. For each `+` hunk line, extract the enclosing function context (from `@@` context lines or nearest `function|def|func|fn |pub fn` in the preceding context). Count decision-point keywords in the added/modified lines only. No external tool — pure string parsing of the diff. This is an approximation but it's deterministic and fast.

Threshold: flag as a hotspot if `decisionPoints >= 5` in a single function's added lines.

#### 1c. SAST patterns via `rg` (already in dev image)

```typescript
export interface SastFinding {
  pattern: string     // human name: "eval-misuse", "sql-concat", "path-traversal", etc.
  file: string
  line: number
  match: string       // the matched line (truncated to 200 chars)
  severity: "high" | "medium" | "low"
}

export interface SastReport {
  findings: SastFinding[]
  patternsChecked: number
  filesScanned: number
}
```

Run `rg` against **only the changed files** (from `ctx.changedFiles`). Use a curated, embedded pattern set — no external rule files needed:

```typescript
const SAST_PATTERNS: Array<{ name: string; pattern: string; severity: SastFinding["severity"]; langs: LanguageId[] }> = [
  // Injection
  { name: "eval-misuse",       pattern: r`\beval\s*\(`,                              severity: "high",   langs: ["typescript","javascript","python"] },
  { name: "sql-concat",        pattern: r`(query|sql|SQL)\s*[+=]\s*["'`].*\+`,      severity: "high",   langs: ["typescript","javascript","python","java","kotlin"] },
  { name: "shell-exec",        pattern: r`\b(exec|execSync|child_process|os\.system|subprocess\.call)\b`, severity: "high", langs: ["typescript","javascript","python"] },
  { name: "path-traversal",    pattern: r`\.\./|path\.join\([^)]*req\b`,             severity: "high",   langs: ["typescript","javascript"] },
  // Secrets
  { name: "hardcoded-secret",  pattern: r`(password|secret|api_key|token)\s*=\s*["'][^"']{8,}["']`, severity: "high", langs: ["typescript","javascript","python","java","kotlin","go","rust"] },
  { name: "hardcoded-jwt",     pattern: r`eyJ[A-Za-z0-9_-]{20,}`,                   severity: "medium", langs: ["typescript","javascript","python","java","kotlin"] },
  // Unsafe patterns
  { name: "prototype-pollution",pattern: r`\.__proto__\s*=|\[["']__proto__["']\]`,  severity: "high",   langs: ["typescript","javascript"] },
  { name: "regex-dos",         pattern: r`new RegExp\([^)]*\+`,                      severity: "medium", langs: ["typescript","javascript"] },
  { name: "unsafe-deserialize",pattern: r`\bpickle\.loads?\b|\byaml\.load\b`,       severity: "high",   langs: ["python"] },
  { name: "go-unchecked-err",  pattern: r`^\s*[a-zA-Z_]+,\s*_\s*:?=`,              severity: "low",    langs: ["go"] },
  { name: "panic-unwrap",      pattern: r`\.unwrap\(\)|\.expect\(`,                  severity: "low",    langs: ["rust"] },
]
```

Filter patterns by `profile.language`. Run `rg --json -n <pattern> <file>` for each pattern × each changed file. Parse JSON output. Deduplicate by (file, line). **Only scan lines that appear in the diff `+` hunks** (new/modified code), not the whole file.

#### 1d. Git churn score for changed files

```typescript
export interface ChurnScore {
  file: string
  commitCount: number   // git log --follow --oneline -- <file> | wc -l
  churnRisk: "low" | "medium" | "high"  // low<10, medium<30, high>=30
}
```

Run `git log --follow --oneline -- <file>` per changed file. Count lines. Fast, always available, no external deps.

#### 1e. CVE detail from audit JSON

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

Re-run the audit tool with `--json` output (vs. the current human-readable run in `static-checks`). Parse structured JSON. For pnpm: `pnpm audit --json` → parse `advisories`. For cargo: `cargo audit --json` → parse `vulnerabilities`. For Python: `pip-audit --format=json` (detect presence first). This replaces the current pass/fail audit check with actionable detail the semantic reviewer can cite.

#### 1f. Probe latency percentiles (production performance)

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
  source: "file-metrics-store" | "none"
}
```

Read from `.bollard/observe/metrics.jsonl` (the `FileMetricsStore` already writes here). Parse the last N probe results per `probeId` (default window: last 100 results or 24h, whichever is smaller). Compute percentiles using a simple sort. Trend: compare avg of last 20% of window vs. first 20% — if delta > 15% degradation → "degrading". This is **purely deterministic** — no LLM, just JSONL parsing and arithmetic.

### 2. New file: `packages/verify/src/code-metrics-runner.ts`

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
  warn: (msg: string) => void,
): Promise<CodeMetrics>
```

Runs all six extractors in parallel (`Promise.all`). Each has its own try/catch returning a zero/empty result on failure — no extractor can block the others. Total wall time bounded by the slowest (coverage, ~30s). Hard timeout: 90s overall.

### 3. New `extract-code-metrics` blueprint node

Insert between `generate-review-diff` (node 25) and `semantic-review` (node 26) in `packages/blueprints/src/implement-feature.ts`.

```typescript
{
  id: "extract-code-metrics",
  name: "Extract Code Metrics",
  type: "deterministic",
  onFailure: "skip",   // never blocks semantic review
  execute: async (ctx: PipelineContext): Promise<NodeResult> => {
    const diffRes = ctx.results["generate-review-diff"]?.data as { diff?: string } | undefined
    const diff = diffRes?.diff ?? ""
    const changedFiles = ctx.changedFiles ?? []
    const profile = ctx.toolchainProfile
    if (!profile || !diff.trim()) {
      return { status: "ok", data: { skipped: true, reason: "no diff or profile" } }
    }
    const metrics = await extractCodeMetrics(workDir, diff, changedFiles, profile, ctx.log.warn)
    ctx.log.info("code_metrics_result", {
      event: "code_metrics_result",
      runId: ctx.runId,
      coverageTool: metrics.coverage.tool,
      coveragePct: metrics.coverage.overallPct,
      complexityHotspots: metrics.complexity.hotspots.length,
      sastFindings: metrics.sast.findings.length,
      auditHigh: metrics.audit.highCount,
      auditCritical: metrics.audit.criticalCount,
      probeCount: metrics.probePerf.probes.length,
      durationMs: metrics.durationMs,
    })
    return { status: "ok", data: { metrics } }
  },
}
```

### 4. Update `buildSemanticReviewerMessage` in `packages/cli/src/agent-handler.ts`

Extend to inject the metrics. Keep the existing diff + plan sections. Add a `## Code Metrics` section after the diff:

```typescript
function buildSemanticReviewerMessage(ctx: PipelineContext): string {
  const diffRes = ctx.results["generate-review-diff"]?.data as { diff?: string } | undefined
  const diff = diffRes?.diff ?? ""
  const plan = ctx.plan
  const metricsRes = ctx.results["extract-code-metrics"]?.data as
    | { skipped?: boolean; metrics?: CodeMetrics }
    | undefined
  const metrics = metricsRes?.metrics

  const metricsSections: string[] = []

  if (metrics) {
    // Coverage
    if (metrics.coverage.tool !== "none" && metrics.coverage.overallPct !== null) {
      metricsSections.push(`### Coverage (${metrics.coverage.tool})
Overall on changed files: ${metrics.coverage.overallPct.toFixed(1)}%
${metrics.coverage.changedFiles.map(f => `- ${f.file}: ${f.pct.toFixed(1)}% (${f.coveredLines}/${f.lines} lines)`).join("\n")}`)
    }

    // Complexity hotspots
    if (metrics.complexity.hotspots.length > 0) {
      metricsSections.push(`### Complexity hotspots (decision points in added code)
${metrics.complexity.hotspots.slice(0, 5).map(h => `- ${h.file} \`${h.functionName}\`: ${h.decisionPoints} decision points`).join("\n")}`)
    }

    // SAST
    if (metrics.sast.findings.length > 0) {
      metricsSections.push(`### SAST findings (rg patterns, added lines only)
${metrics.sast.findings.map(f => `- [${f.severity}] ${f.pattern} in ${f.file}:${f.line}: \`${f.match}\``).join("\n")}`)
    }

    // Churn
    const highChurn = metrics.churn.filter(c => c.churnRisk === "high")
    if (highChurn.length > 0) {
      metricsSections.push(`### High-churn files (commit history)
${highChurn.map(c => `- ${c.file}: ${c.commitCount} commits`).join("\n")}`)
    }

    // CVEs
    if (metrics.audit.criticalCount > 0 || metrics.audit.highCount > 0) {
      metricsSections.push(`### Dependency vulnerabilities
Critical: ${metrics.audit.criticalCount}, High: ${metrics.audit.highCount}
${metrics.audit.details.map(d => `- ${d.package}: ${d.severity} — ${d.title}`).join("\n")}`)
    }

    // Probe performance
    const degrading = metrics.probePerf.probes.filter(p => p.trend === "degrading")
    if (degrading.length > 0) {
      metricsSections.push(`### Degrading probe performance
${degrading.map(p => `- ${p.probeId} (${p.endpoint}): p95=${p.p95Ms}ms, failRate=${(p.failRate * 100).toFixed(1)}%`).join("\n")}`)
    }
  }

  const metricsBlock = metricsSections.length > 0
    ? `\n## Code Metrics\n\n${metricsSections.join("\n\n")}\n`
    : ""

  return `## Git Diff\n\n<diff>\n${diff}\n</diff>\n${metricsBlock}\n## Plan\n\n<plan>\n${JSON.stringify(plan ?? {}, null, 2)}\n</plan>\n\nReview the diff against the plan. Use the code metrics above to ground findings in concrete data. Output a JSON ReviewDocument.`
}
```

### 5. Update semantic-reviewer prompt

Add a section after `# Inputs` that explains the new context:

```markdown
- **Code metrics** (when available): coverage % on changed files, complexity hotspots, SAST findings, churn scores, CVE detail, probe latency trends. These are deterministically computed — cite them in your grounding when relevant. A finding grounded in a concrete metric (e.g. "coverage 23% on changed file") is stronger than an inference from reading the diff.
```

Update the `ReviewCategory` set to include two new categories that the metrics unlock:
- `"insufficient-coverage"` — coverage on changed files below threshold (suggested: 60%)
- `"security-pattern"` — SAST finding or CVE in changed code

Add both to `review-grounding.ts` `VALID_CATEGORIES` and the `ReviewCategory` type.

### 6. `.bollard.yml` extension for thresholds

Add `metrics:` section to the Zod schema in `packages/cli/src/config.ts`:

```typescript
const metricsYamlSchema = z.object({
  coverage: z.object({
    enabled: z.boolean().default(true),
    thresholdPct: z.number().min(0).max(100).default(60),
  }).optional(),
  complexity: z.object({
    enabled: z.boolean().default(true),
    hotspotThreshold: z.number().default(5),  // decision points
  }).optional(),
  sast: z.object({
    enabled: z.boolean().default(true),
  }).optional(),
  churn: z.object({
    enabled: z.boolean().default(true),
    highThreshold: z.number().default(30),  // commits
  }).optional(),
  probePerf: z.object({
    enabled: z.boolean().default(true),
    windowResults: z.number().default(100),
  }).optional(),
}).strict()
```

Extend `BollardConfig` and thread through `PipelineContext` via `toolchainProfile` (or directly from config in `extractCodeMetrics`). Defaults are opinionated and work without any user config.

### 7. Tests

New file `packages/verify/tests/code-metrics.test.ts`:
- `extractComplexityFromDiff`: given a diff string with known decision points → correct hotspot count
- `buildSastFindings`: given a file with a known `eval(` call → finding returned; clean file → empty
- `computeChurnScore`: given mock git output → correct risk tier
- `aggregateProbePerf`: given JSONL probe results → correct p95, trend detection
- `extractCveDetail`: given mock `pnpm audit --json` output → correct counts
- All extractors: tool-not-found path → returns zero/empty result, no throw

Update `packages/blueprints/tests/implement-feature.test.ts`:
- Node count: 31 (was 30)
- `"extract-code-metrics"` appears between `"generate-review-diff"` and `"semantic-review"`
- `onFailure: "skip"` on the new node

Update `packages/verify/src/review-grounding.ts`:
- `VALID_CATEGORIES` includes `"insufficient-coverage"` and `"security-pattern"`
- Tests in `packages/verify/tests/` (find the existing review-grounding test file) updated for new categories

### 8. `ToolchainProfile` extension

Add optional `metrics` field to `ToolchainProfile` in `packages/detect/src/types.ts`:

```typescript
export interface MetricsConfig {
  coverage: { enabled: boolean; thresholdPct: number }
  complexity: { enabled: boolean; hotspotThreshold: number }
  sast: { enabled: boolean }
  churn: { enabled: boolean; highThreshold: number }
  probePerf: { enabled: boolean; windowResults: number }
}
```

Add `metrics?: MetricsConfig` to `ToolchainProfile`. Default in each language detector: all enabled with the thresholds above. Thread through `extractCodeMetrics`.

---

## What NOT to do

- Do not install semgrep, SonarQube, or any tool that isn't already in the dev image or available as a language-native CLI already on the PATH for that language.
- Do not run coverage on the full test suite — only on test files whose source imports any of the changed files. Pass `--testPathPattern` / file args to limit scope.
- Do not block the pipeline on metrics failure. Every extractor wraps in try/catch returning zero result. `extract-code-metrics` has `onFailure: "skip"`.
- Do not add new `ReviewCategory` values beyond `"insufficient-coverage"` and `"security-pattern"`. The existing six categories stay.
- Do not change the semantic-reviewer agent's output schema or grounding verifier — metrics are input context only.
- Do not run probe perf analysis if `.bollard/observe/metrics.jsonl` does not exist — return `source: "none"`.

---

## Validation checklist

```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test        # 31 nodes, new code-metrics tests pass
docker compose run --rm dev --filter @bollard/cli run start -- verify --profile
```

Bollard-on-Bollard self-test (`CostTracker.divide` or similar):
- `extract-code-metrics` node appears in run output
- `code_metrics_result` log event emitted with coverage tool, hotspot count, SAST count
- Semantic reviewer message includes a `## Code Metrics` section
- Blueprint: 31 nodes
- Semantic reviewer findings reference concrete metric data (grounding quotes cite coverage % or SAST pattern name)
- No regression: all existing grounding categories still work, `verify-review-grounding` drop rate unchanged
