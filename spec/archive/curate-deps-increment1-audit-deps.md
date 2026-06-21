---
name: curate-deps-increment1-audit-deps
overview: "Stage 6 deps domain, Layer 1 (deterministic, zero LLM): bollard audit-deps — scan ALL dependency manifests (npm lockfile + the Go/Rust/Java helper manifests) against the OSV/GHSA database via osv-scanner, so Bollard sees the same vulnerabilities Dependabot does, in CI. Closes the blind spot that left bollard-verify green while Dependabot had 5 open vulns this session. Mirrors audit-docs exactly."
todos:
  - id: step-1-tool
    content: "Install osv-scanner (prebuilt release binary) in the dev Docker image, mirroring the extractor-binary COPY pattern. Keep dev lean."
    status: pending
  - id: step-2-engine
    content: "packages/engine/src/audit-deps.ts: DepsCheckResult/AuditDepsResult types + runOsvScanner + parse + check functions (npm-vulnerabilities, helper-manifest-vulnerabilities) + auditDeps(workDir) orchestrator. Zero LLM. Mirror audit-docs.ts."
    status: pending
  - id: step-3-cli-ci
    content: "CLI bollard audit-deps (formatAuditDepsResult, exit 1 on hard-check fail); wire into index.ts; add audit-deps step to bollard-verify.yml mirroring audit-docs."
    status: pending
  - id: step-4-tests-validate
    content: "Unit tests (parse fixtures, hard-fail on high/critical, advisory on lower, missing-manifest handling); run audit-deps on real repo; full suite green; docs close-out."
    status: pending
isProject: false
---

# curate-deps Layer 1 — `bollard audit-deps`

The deterministic, zero-LLM counterpart to `pnpm audit` that **also sees the Go/Rust/Java helper manifests**. This is the exact gap that bit us: the 2026-06 dependency refresh left `pnpm audit` clean while Dependabot reported 5 vulns — because `pnpm audit` only scans the npm tree, and nothing scanned `scripts/extract_{go,rs,java}/`. `audit-deps` closes it by running **osv-scanner** (same OSV/GHSA database Dependabot uses) over every manifest, and gates it in CI exactly like `audit-docs`.

This is increment 1 (detection). The *action* layer (auto-bumping security floors behind a trust gate — `takeover.deps`, already parsed with `securityOnly: true`) is increment 2, a later prompt. **No LLM anywhere in this increment.**

## Why osv-scanner

One static binary scans `pnpm-lock.yaml` (npm), `go.mod`, `Cargo.lock`, and `pom.xml` against the OSV database (which aggregates GHSA — the same source as Dependabot). It replaces needing three separate language scanners (govulncheck + cargo-audit + OWASP), none of which are installed in `dev` today. Deterministic JSON output. This is the right determinism-first tool.

## Step 1 — Install osv-scanner in the `dev` image

`Dockerfile`, `dev` stage: download the prebuilt `osv-scanner` release binary for linux/amd64 (it's a ~10–15 MB static Go binary — no Go toolchain needed) into `/usr/local/bin/osv-scanner`, `chmod +x`. Mirror the style of the existing extractor-binary `COPY`s, but here it's a `curl`/`wget` of a pinned release version (pin the version, e.g. a specific `v2.x.x` tag — do NOT use `@latest`, for reproducibility). Add a one-line `osv-scanner --version` smoke check. Keep it in `dev` (not `dev-full`) because CI runs `audit-deps` on `dev`. Rebuild: `docker compose build dev`.

If a pinned binary download is awkward, the fallback is `go install github.com/google/osv-scanner/v2/cmd/osv-scanner@<pinned>` in a builder stage + COPY — but prefer the release binary to avoid pulling the Go toolchain into `dev`.

## Step 2 — Engine module `packages/engine/src/audit-deps.ts`

Mirror `packages/engine/src/audit-deps.ts` on `audit-docs.ts` (same shape: typed check results, pure check functions, an orchestrator, zero LLM).

```ts
export type DepsCheckId = "npm-vulnerabilities" | "helper-manifest-vulnerabilities"
export type DepsSeverity = "critical" | "high" | "moderate" | "low" | "unknown"
export interface DepsVulnerability {
  package: string
  version: string
  id: string            // OSV/GHSA id
  severity: DepsSeverity
  manifest: string      // which file, repo-relative
  summary?: string
  fixedVersion?: string
}
export interface DepsCheckResult {
  id: DepsCheckId
  label: string
  passed: boolean
  advisory?: boolean    // excluded from allPassed (moderate/low only)
  vulnerabilities: DepsVulnerability[]
}
export interface AuditDepsResult { allPassed: boolean; checks: DepsCheckResult[] }
```

- `runOsvScanner(workDir, targets: string[]): Promise<OsvRaw>` — shell `osv-scanner --format json <targets...>` (non-throwing; osv-scanner exits 1 when vulns are found, so capture stdout regardless of exit code, same pattern as the audit handling in `static.ts`). Inject the runner for tests. If the binary is missing, degrade gracefully — return a check with `passed: true, advisory: true` and a "osv-scanner not available" note (so a dev without the rebuilt image doesn't hard-fail), but in CI (image has it) it runs for real.
- `parseOsvJson(raw): DepsVulnerability[]` — osv-scanner JSON shape is `{ results: [ { source: { path }, packages: [ { package: {name, ecosystem, version}, vulnerabilities: [ {id, summary, severity, database_specific...} ], groups: [...] } ] } ] }`. Map each to a `DepsVulnerability`, deriving `manifest` from `source.path` (relativize to workDir), and `severity` from the CVSS/`database_specific.severity` (normalize to the `DepsSeverity` union; GHSA severity strings like "HIGH"/"MODERATE" map directly).
- **Two checks, partitioning the same scan by manifest:**
  - `checkNpmVulnerabilities` — vulns whose `manifest` is `pnpm-lock.yaml`/`package.json`. **Hard fail** on any `critical`/`high`; `moderate`/`low` → still report but set the check `advisory` if ONLY moderate/low remain (mirror `--audit-level=high` semantics + the existing pnpm-audit gate). Decide: keep parity with `static.ts`'s `--audit-level=high` (hard-fail high+critical only).
  - `checkHelperManifestVulnerabilities` — vulns from `scripts/extract_go/go.mod`, `scripts/extract_rs/Cargo.lock`, `scripts/extract_java/pom.xml`. **This is the blind-spot closer.** Same severity gating. Note: Rust needs `Cargo.lock` — if `scripts/extract_rs/Cargo.lock` isn't committed, osv-scanner can't scan Cargo deps; either commit the lock or note Rust coverage as a known limitation in this increment.
- `auditDeps(workDir, opts?): Promise<AuditDepsResult>` — resolve the manifest target list, run osv-scanner once over the repo (or per-target), partition results into the two checks, compute `allPassed = checks.filter(c => !c.advisory).every(c => c.passed)` (same advisory exclusion as audit-docs). Pure aside from the injected shell.

Re-export the public types/functions from `packages/engine/src/types.ts`.

## Step 3 — CLI + CI

- `packages/cli/src/audit-deps.ts`: `formatAuditDepsResult(result)` — per-check ✓/✗ with the vulnerability list (package@version, id, severity, manifest, fixedVersion when known); CLI shim calls `auditDeps` from `@bollard/engine`, prints, `process.exit(result.allPassed ? 0 : 1)`. Mirror the `audit-docs` CLI shim. (Keep `formatAuditDepsResult` CLI-only; the pure logic stays in engine — same layering as audit-docs.)
- `packages/cli/src/index.ts`: route `if (command === "audit-deps")`; add to help text.
- `.github/workflows/bollard-verify.yml`: add a `Bollard audit-deps` step right after the `Bollard audit-docs` step, verbatim shape:
  ```yaml
  - name: Bollard audit-deps
    run: |
      docker compose run --rm dev sh -c \
        'pnpm --filter @bollard/cli run start -- audit-deps'
  ```
  This makes the helper-manifest vulns fail CI deterministically — Bollard now sees what Dependabot sees, in its own gate.

## Step 4 — Tests + validate + close out

- **Unit tests** `packages/engine/tests/audit-deps.test.ts` (stub the osv runner with fixture JSON — no real osv-scanner needed):
  - parse a multi-ecosystem osv JSON fixture → correct `DepsVulnerability[]` with manifests/severities.
  - a HIGH npm vuln → `npm-vulnerabilities` check fails, `allPassed: false`.
  - a HIGH go.mod vuln → `helper-manifest-vulnerabilities` fails (the blind-spot test — this is the one that proves the feature's reason for existing).
  - only-moderate vulns → check `advisory: true`, `allPassed` stays true (parity with `--audit-level=high`).
  - osv runner missing/error → graceful advisory pass, no crash.
  - clean scan → both checks pass.
- **Validate:**
  - `docker compose build dev` (osv-scanner baked in), then `docker compose run --rm dev run typecheck && … lint && … test` — full suite green + new tests.
  - `docker compose run --rm dev --filter @bollard/cli run start -- audit-deps` — runs osv-scanner for real on the repo. Expect **exit 0** (the 2026-06 overrides floor the known npm vulns; helper manifests are tiny — go.mod has zero deps, Cargo/pom are small). If it finds a real HIGH vuln, that's the feature working on day one (fix it: bump the manifest / add a floor) — same dogfood payoff as link-integrity's 49 links.
- **Close out:** `CLAUDE.md` (new `audit-deps` deterministic check + osv-scanner in dev image + the Dependabot-blind-spot rationale; bump test count), `spec/ROADMAP.md` (Stage 6 deps domain Layer 1 done), a short note in `spec/stage6-docs-integrity.md` or a new `spec/stage6-deps-integrity.md` design doc (two-layer model: audit-deps detect / curate-deps act — mirror the docs two-layer write-up). Archive this prompt. Commits: (1) Dockerfile + engine + CLI + CI + tests, (2) docs.

## Out of scope (increment 2 and beyond)

- The `curate-deps` blueprint / action layer (auto-bump security floors, regenerate lockfile, verify audit-clean + tests-green behind the `takeover.deps` trust gate). That's increment 2 — mostly deterministic, possibly LLM-free.
- Override-hygiene (detecting redundant `pnpm-workspace.yaml` overrides) — increment 2.
- `pnpm outdated` staleness reporting — optional later increment.
- Do NOT remove the existing `pnpm audit` check from `static.ts`/`verify` — `audit-deps` is additive (it adds the helper-manifest coverage + a unified view); leave the existing npm gate as-is to avoid behavior change.

## Watch-outs

- **Pin the osv-scanner version** in the Dockerfile — `@latest` makes builds non-reproducible and CI non-deterministic (a new advisory DB or tool change could flip CI red unexpectedly). Bump it deliberately, like a dependency.
- **Rust needs Cargo.lock.** If `scripts/extract_rs/Cargo.lock` isn't committed, osv-scanner skips Rust deps silently — verify what it actually scans (`osv-scanner` prints scanned sources) and either commit the lock or document Rust as a coverage gap for this increment.
- **osv-scanner exits non-zero on findings** — the runner must read stdout regardless of exit code (don't treat exit 1 as a tool failure).
- **Graceful degradation** so a contributor on an un-rebuilt `dev` image (no osv-scanner) gets an advisory skip, not a hard failure — but CI (rebuilt image) runs it for real.
