# Stage 3b validation results

Validation run: 2026-04-09 (Docker Compose, repo mounted at `/app`).

## Baseline


| Check                                       | Result                                    |
| ------------------------------------------- | ----------------------------------------- |
| `docker compose build dev`                  | OK                                        |
| `docker compose run --rm dev run typecheck` | OK                                        |
| `docker compose run --rm dev run lint`      | OK (119 files, 0 errors)                  |
| `docker compose run --rm dev run test`      | **523 passed**, **2 skipped** (525 total) |


Skips: 2 LLM live smoke tests (no key in CI).

## Check 1 — Dev image helpers

**Pass.**

```
bollard-extract-go 0.1.0
bollard-extract-rs 0.1.0
Python 3.11.2
```

All three binaries on PATH, exit 0.

## Check 2 — `dev-full` image (compose profile `full`)

**Pass.**

```
go version go1.22.6 linux/arm64
rustc 1.94.1 (e408947bf 2026-03-25)
Python 3.11.2
pytest 9.0.3
ruff 0.15.10
```

Image size: **2.23 GB** (`bollard-dev-full:latest`).

Build time: ~42s (cached layers).

## Check 3 — Extractors (all four languages)

**Pass.** Per-language test counts:


| Language   | Extractor             | Tests |
| ---------- | --------------------- | ----- |
| TypeScript | `TsCompilerExtractor` | 2     |
| Python     | `PythonAstExtractor`  | 2     |
| Go         | `GoAstExtractor`      | 4     |
| Rust       | `RustSynExtractor`    | 4     |


All 12 extractor tests passed.

## Check 4 — Helper binary integration

**Pass.** 3 tests:

- `bollard-extract-go helper` — extracts exported items and skips private ones from a Go file
- `bollard-extract-rs helper` — extracts pub items and skips private ones from a Rust file
- `helper error handling` — returns empty signatures with warnings for unparseable files

## Check 5 — Contract graph providers (all four languages)

**Pass.** 22 tests across all providers:


| Provider                             | Tests |
| ------------------------------------ | ----- |
| `buildContractContext` (router + TS) | 7     |
| `PythonContractProvider`             | 5     |
| `GoContractProvider`                 | 5     |
| `RustContractProvider`               | 5     |


## Check 6 — Contract graph on Bollard itself (TypeScript baseline)

**Pass.**

```
Modules: 8
Edges: 18
Affected edges: 0
  @bollard/agents: 1 exports, lang=typescript
  @bollard/blueprints: 1 exports, lang=typescript
  @bollard/cli: 9 exports, lang=typescript
  @bollard/detect: 1 exports, lang=typescript
  @bollard/engine: 7 exports, lang=typescript
  @bollard/llm: 1 exports, lang=typescript
  @bollard/mcp: 1 exports, lang=typescript
  @bollard/verify: 1 exports, lang=typescript
```

Identical to Stage 3a baseline (8 modules, 18 edges, all `language: "typescript"`).

## Check 7 — Risk gate (polyglot)

**Pass.** 16 `scanDiffForExportChanges` tests:

- 2 TypeScript baseline (added export, no export changes)
- 6 Python (top-level def, indented def, `__all__`, re-export, async def, top-level class)
- 4 Go (exported func, unexported func, exported type, exported method)
- 4 Rust (pub fn, private fn, pub struct, pub(crate))

## Check 8 — Test summary parsers (polyglot)

**Pass.** 8 `parseSummary` tests:

- Vitest: pass+fail, pass-only
- pytest: pass+fail, pass-only
- `go test`: all-pass multi-package, mixed pass/fail
- `cargo test`: all-pass, fail with named failures

## Check 9 — `implement-feature` self-test (TypeScript)

**Pass.** Full 18-node pipeline ran against `CostTracker.subtract()` task.

Pre-run: `subtract()` temporarily removed from `cost-tracker.ts` and its tests (506 pass / 2 skip baseline).


| Metric                      | Value                                                                      |
| --------------------------- | -------------------------------------------------------------------------- |
| Run ID                      | `20260409-2054-run-bccad4`                                                 |
| Branch                      | `bollard/20260409-2054-run-bccad4`                                         |
| Nodes                       | **18/18 passed** (first attempt, 0 retries)                                |
| `verify-claim-grounding`    | 6 proposed / 6 grounded / **0 dropped**                                    |
| `contract_grounding_result` | `{"proposed":6,"grounded":6,"dropped":0,"dropRate":0,"droppedSymbols":[]}` |
| Coder turns                 | 42/60                                                                      |
| Cost                        | **$1.40**                                                                  |
| Duration                    | **222s** (~3m 42s)                                                         |


Node-by-node:


| #   | Node                    | Type          | Status | Time   | Cost  |
| --- | ----------------------- | ------------- | ------ | ------ | ----- |
| 1   | create-branch           | deterministic | ok     | 14ms   | —     |
| 2   | generate-plan           | agentic       | ok     | 19.3s  | $0.09 |
| 3   | approve-plan            | human_gate    | ok     | auto   | —     |
| 4   | implement               | agentic       | ok     | 154.1s | $1.21 |
| 5   | static-checks           | deterministic | ok     | 869ms  | —     |
| 6   | extract-signatures      | deterministic | ok     | 18ms   | —     |
| 7   | generate-tests          | agentic       | ok     | 21.4s  | $0.04 |
| 8   | write-tests             | deterministic | ok     | 9ms    | —     |
| 9   | run-tests               | deterministic | ok     | 4.6s   | —     |
| 10  | assess-contract-risk    | deterministic | ok     | 154ms  | —     |
| 11  | extract-contracts       | deterministic | ok     | 396ms  | —     |
| 12  | generate-contract-tests | agentic       | ok     | 20.8s  | $0.07 |
| 13  | verify-claim-grounding  | deterministic | ok     | 3ms    | —     |
| 14  | write-contract-tests    | deterministic | ok     | 6ms    | —     |
| 15  | run-contract-tests      | deterministic | ok     | 557ms  | —     |
| 16  | docker-verify           | deterministic | ok     | 2ms    | —     |
| 17  | generate-diff           | deterministic | ok     | 7ms    | —     |
| 18  | approve-pr              | human_gate    | ok     | auto   | —     |


Surviving contract claims (6/6 grounded): negative input validation (c1), underflow validation (c2), snapshot consistency (c3), PipelineContext parameter (c4), zero-amount resilience (c5), NaN/Infinity validation (c6).

Post-run cleanup: `git checkout main`, branch deleted, `.bollard` artifacts removed, test count restored to **523 passed / 2 skipped**.

## Check 10 — Contract graph providers on real fixtures

**Pass** (with known gap).


| Language | Modules | Edges | Notes                                                                         |
| -------- | ------- | ----- | ----------------------------------------------------------------------------- |
| Python   | 2       | 1     | Root `pyproject.toml` added for detection                                     |
| Go       | 2       | 1     | Root `go.mod` added — `detectToolchain` requires root `go.mod`, not `go.work` |
| Rust     | 2       | 1     | Cargo workspace detected correctly                                            |


**Known gap:** `detectToolchain` for Go only checks for `go.mod` at the workspace root. A `go.work`-only layout (no root `go.mod`) is not detected. The `GoContractProvider` itself works correctly (validated by Check 5 unit tests). Detection gap noted for Stage 3c.

## Check 11 — ADR-0002 exists

**Pass.**

```
spec/adr/
  0001-deterministic-filters-for-llm-output.md
  0002-syn-helper-for-rust-extraction.md
```

Frontmatter: `Status: Accepted`, `Date: 2026-04-08`, `Deciders: Bruno (maintainer)`.

## Check 12 — File structure audit

**Pass.**

```
contract-extractor.ts (barrel): 7 lines
contract-providers/go.ts: 248 lines
contract-providers/python.ts: 445 lines
contract-providers/rust.ts: 284 lines
contract-providers/types.ts: 71 lines
contract-providers/typescript.ts: 319 lines
Total: 1367 lines across 5 provider files
```

No provider class in the barrel (`grep -c "class TypeScriptContractProvider"` returns 0).

## Stage 3b commit log

Stage 3b spans workstreams 1–10. Commits on `main`:


| Commit    | WS  | Summary                                                                               |
| --------- | --- | ------------------------------------------------------------------------------------- |
| `cb37b8b` | —   | Stage 3a+: contract-scope risk gate skeleton                                          |
| `663dd14` | —   | Stage 3a+: risk-gate measurement correctness                                          |
| `b43e0e3` | 1   | Polyglot dev image + slim dev-full (2.43GB → 2.24GB)                                  |
| `122ca6b` | 3   | Rewrite Rust extractor to shell out to bollard-extract-rs                             |
| `4274ffc` | 3b  | ADR-0002 — syn helper for Rust signature extraction                                   |
| `bb3f9d5` | 4   | Refactor buildContractContext into ContractGraphProvider                              |
| `d5d116a` | 6   | Add GoContractProvider to buildContractContext                                        |
| `8d05523` | 4+5 | Split contract-extractor.ts into per-provider files (includes PythonContractProvider) |
| `6676004` | 7   | Add RustContractProvider to buildContractContext                                      |
| `0e0a6b1` | 1b  | Cleanup gitignore, worktree ref, and Go extractor tweaks                              |
| `d3ee41c` | 8   | Polyglot risk gate + test summary parsers                                             |


Workstream 2 (Go extractor) was integrated into the dev image commit (`b43e0e3`). Workstream 9 (checkpoint sanity) was a manual check pass. Workstream 10 is this document.

## Known gaps (intentional / follow-up)

- `**detectToolchain` for `go.work`-only layouts:** Go detection requires `go.mod` at the root. A `go.work` without root `go.mod` does not trigger Go detection. The `GoContractProvider` handles multi-module workspaces correctly once detected. Stage 3c candidate.
- **Per-language mutation testing:** Stryker (JS/TS), mutmut (Python), cargo-mutants (Rust) not yet implemented. Stage 3c.
- **Semantic review agent:** Stage 3c.
- **Streaming LLM responses:** Deferred to Stage 3c/4 (spinner + telemetry covers basic UX).
- **Behavioral-scope adversarial testing:** Stage 4.
- **Git rollback on coder max-turns failure:** Stage 4.
- **Verification summary batching:** Stage 4.
- **JavaScript contract graph provider:** Stage 4 (shares TS tooling but needs its own detection path).
- **Docker-verify node:** Gracefully degrades when Docker-in-Docker unavailable (exit 0 with skip). Full isolation validated in Stage 2.

## Stage 3b status

**GREEN.** All 12 checks pass. Full 18-node `implement-feature` self-test completed with 6/6 grounded contract claims and zero drops. Test suite stable at 523 passed / 2 skipped. Four deterministic extractors, four contract graph providers, polyglot risk gate, and polyglot test summary parsers all validated.