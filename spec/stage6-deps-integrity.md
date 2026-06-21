# Stage 6 — Deps integrity (two-layer model)

Bollard maintains dependency hygiene across the npm workspace **and** polyglot helper manifests under `scripts/extract_{go,rs,java}/`. Layer 1 detects; Layer 2 acts (increment 2, behind `takeover.deps`).

## Motivation

The 2026-06 dependency refresh left `pnpm audit --audit-level=high` clean while Dependabot reported open vulns in helper manifests — because `pnpm audit` only scans the npm tree. Nothing scanned `go.mod`, `Cargo.lock`, or `pom.xml` until this layer.

## Layer 1 — `bollard audit-deps` (deterministic)

**Detects** vulnerabilities via [osv-scanner](https://github.com/google/osv-scanner) against the OSV/GHSA database (same source as Dependabot). Zero LLM.

### Scanned manifests

| Path | Ecosystem |
|------|-----------|
| `pnpm-lock.yaml` | npm (workspace) |
| `scripts/extract_go/go.mod` | Go — **skipped when stdlib-only** (no `require` directives; avoids Go toolchain stdlib noise) |
| `scripts/extract_rs/Cargo.lock` | Rust |
| `scripts/extract_java/pom.xml` | Maven |

### Checks

Hard fail (exit 1) on **critical** or **high** severity in either partition:

1. **npm-vulnerabilities** — findings from `pnpm-lock.yaml`
2. **helper-manifest-vulnerabilities** — findings from helper manifests (the Dependabot blind-spot closer)

Advisory (report only, excluded from exit code): **moderate** and **low** only — parity with `pnpm audit --audit-level=high`.

Graceful degradation: if `osv-scanner` is not installed (un-rebuilt `dev` image), a single advisory skip check passes; CI with the rebuilt image runs for real.

### Tooling

- **osv-scanner v2.3.5** pinned in the `dev` Docker image (`/usr/local/bin/osv-scanner`)
- Invocation: `osv-scanner scan source --format json` with `-L` for lockfiles
- Implementation: `@bollard/engine` (`audit-deps.ts`); CLI shim + `formatAuditDepsResult`
- CI: `.github/workflows/bollard-verify.yml` (after `audit-docs`)

`pnpm audit` in `bollard verify` remains unchanged — `audit-deps` is additive.

## Layer 2 — `bollard curate-deps` (future, increment 2)

**Fixes** security findings the deterministic layer surfaces: auto-bump security floors, regenerate lockfiles, verify audit-clean + tests-green. Gated by `takeover.deps` (`securityOnly: true` default). Mostly deterministic; no LLM required for CVE patch bumps.

Config types and YAML parsing for `takeover.deps` already ship (Stage 6 Phase 0). Blueprint wiring is deferred.

See [archive/curate-deps-increment1-audit-deps.md](./archive/curate-deps-increment1-audit-deps.md) for the Layer 1 implementation prompt.
