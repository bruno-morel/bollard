# Stage 3b — Workstream 3b: ADR-0002 (syn helper for Rust extraction)

> **Scope:** doc-only. One new file: `spec/adr/0002-syn-helper-for-rust-extraction.md`. No code changes, no test changes, no CLAUDE.md updates. ADR-0001 is the structural template — mirror its sectioning and tone.

## Context

Workstream 1 introduced a `bollard-extract-rs` helper binary (built from `scripts/extract_rs/`) that uses the `syn` crate to parse Rust source and emit `{signatures, types, warnings}` JSON. Workstream 3 wired it up as `RustSynExtractor`, replacing the regex stub. The rename from `RustExtractor` to `RustSynExtractor` made the strategy explicit in the type name.

This ADR captures the *why*. Future maintainers will ask:

- Why not `rustc --emit=metadata` and parse `.rmeta`?
- Why not shell out to `cargo rustc -- -Z unpretty=expanded`?
- Why a separate binary instead of a Node-side Rust parser (e.g. a WASM `syn` build)?
- Why is `rust-version = "1.80"` in `Cargo.toml` acceptable when the `dev` image ships a newer `rustc`?
- What precedent does this set for future native helpers (Java, Kotlin, C#)?

Without the ADR, the next person faced with a new language extractor will re-litigate all of these and probably pick a different answer for each one, fragmenting the helper-binary pattern.

## Files to create

### `spec/adr/0002-syn-helper-for-rust-extraction.md`

Follow the structure of `spec/adr/0001-deterministic-filters-for-llm-output.md`:

```
# ADR-0002: syn-based helper binary for Rust signature extraction

**Status:** Accepted
**Date:** 2026-04-08
**Deciders:** Bruno (maintainer)
**Supersedes:** —
**Related:** [spec/06-toolchain-profiles.md], workstreams 1 and 3

## Context
## Decision
## Options Considered
## Consequences
## Open Questions
```

### Section guidance

**Context** — cover:
- The Stage 3b goal: replace the regex stub in `packages/verify/src/extractors/rust.ts` with a real AST-backed extractor that produces `ExtractedSignature` and `ExtractedTypeDefinition` records matching the Python and Go extractors' output shape.
- The forces: Node-side parsing (the rest of Bollard is TypeScript) vs. leveraging Rust's own ecosystem; `dev` image boot time vs. runtime correctness; the pnpm-workspace precedent of "deterministic extractors, LLM fallback only for unknown languages" from Stage 2.
- The constraint: whatever we pick must work inside the multi-stage Dockerfile introduced in workstream 1, and must not bloat the `dev` image beyond the existing ~989 MB baseline (the honest 2.2 GB floor is `dev-full`, not `dev`).

**Decision** — state plainly:
- Rust signature extraction runs through a standalone static binary `bollard-extract-rs`, built from `scripts/extract_rs/` using the `syn` crate plus a thin `serde_json` emitter.
- The binary is built in a dedicated `rust-helper-builder` stage in the root `Dockerfile` and copied into both `dev` and `dev-full` as `/usr/local/bin/bollard-extract-rs`. The builder stage is discarded — neither runtime image carries the Rust toolchain for the purpose of building the helper (`dev-full` carries it for running project Rust code, not for rebuilding the helper).
- `RustSynExtractor` shells out to the binary via `execFile`, parses the JSON, and mirrors the Python/Go extractor pattern. Same `filterUnderWorkDir` guard, same `cwd === workDir` requirement, same graceful degradation on helper failure.
- `Cargo.toml` declares `rust-version = "1.80"` as an MSRV floor, not a lock. The builder stage uses whichever `rustc` rustup pulls in; as long as it's ≥ 1.80 the helper compiles. This is explicitly different from the pinned Node/pnpm versions because MSRV is Rust-idiomatic.

**Options Considered** — cover at least these four:

1. **`rustc --emit=metadata` + parse `.rmeta`** — rejected. `.rmeta` is an unstable internal format, `rustc -Z` flags are nightly-only, and the resulting data structures are oriented around incremental compilation, not signature extraction. Would pin Bollard to nightly Rust.

2. **`rust-analyzer` as a library** — rejected. `rust-analyzer` is the highest-fidelity option but is enormous (hundreds of MB when vendored), its internal API is explicitly not stable, and it's designed to run as an LSP server, not as a batch extractor. The startup cost alone would dominate the extract call.

3. **WASM-compiled `syn` called from Node** — rejected. Would eliminate the binary-on-PATH requirement and unify with the TypeScript stack, but `syn` pulls in `proc-macro2` and has enough transitively-linked C code (via `unicode-ident` etc.) that a clean WASM build is non-trivial. And the packaging story (how does pnpm ship a WASM blob inside `@bollard/verify`?) regresses the "one compose build, one dev image" property.

4. **Standalone `syn` binary, copied into `dev`** (chosen) — `syn` is the canonical Rust parsing crate, stable since 1.0, used by every major macro in the ecosystem. A few hundred lines of Rust wrap it into a CLI that takes positional file paths and emits JSON on stdout. Build cost is paid once per `docker compose build dev`, runtime cost is a single `execFile` per extraction. The binary is static (musl or glibc — workstream 1 picked glibc), has no runtime dependencies, and lives at `/usr/local/bin/bollard-extract-rs`.

**Consequences** — be explicit about the tradeoffs:

- **Positive:** Deterministic, fast, hallucination-free extraction (vs. the LLM fallback). Same pattern as Python and Go, which means one mental model for all three native extractors. Helper is cacheable in the Docker layer, so day-to-day `docker compose build dev` is fast after the first build.
- **Positive:** Sets a clean precedent for future native helpers (Java: `javaparser`, C#: `Roslyn`, Kotlin: `kotlinc`'s PSI). The pattern is: pick the language's canonical parsing library, wrap it in a CLI that matches `{signatures, types, warnings}`, build it in a discarded Dockerfile stage, copy the binary into `dev`.
- **Negative:** Every new native helper adds a builder stage to the root `Dockerfile`. At some point the cold-build time becomes painful. Workstream 1's single-build latency is already non-trivial. Mitigation: accept it; discipline the helper stages to be small and discrete.
- **Negative:** The MSRV-only policy (`rust-version = "1.80"`) means the helper can't use post-1.80 language features without bumping the floor. Workstream 3's current helper uses nothing exotic, so this is cheap today.
- **Negative:** The helper binary is distributed inside the `dev` image, not published as a crate. Running the test suite outside `dev` silently fails case 1–3 of the `RustSynExtractor` tests. This is acceptable because Bollard's mandatory workflow is Docker-first (see CLAUDE.md "Development via Docker Compose"), but it's worth calling out so a future contributor doesn't file a confusing bug.

**Open Questions** — leave these explicit rather than pretending they're solved:

- How does this generalize to Java / Kotlin / C#? Each of those has a heavier canonical parser (Roslyn especially) — the "small static binary in a discarded builder stage" assumption may not hold. Revisit when Wave 2 of the language rollout (per `spec/07-adversarial-scopes.md` §12.1) starts.
- Should `bollard-extract-rs` eventually read `Cargo.toml` to scope extraction to the workspace's public surface, mirroring what `buildContractContext` does for TypeScript today? That's the scope of workstream 7 (Rust contract graph).
- If `dev-full` ever carries a newer `rustc` than the `rust-helper-builder` stage uses, does that matter? Not today — the helper is pre-built into both images from the same builder stage.

## Out of scope

- **No code changes.** Do not touch `scripts/extract_rs/`, `packages/verify/src/extractors/rust.ts`, the `Dockerfile`, or any test file.
- **No CLAUDE.md update.** ADRs live under `spec/adr/` and are linked from design docs, not from CLAUDE.md.
- **No test count change.** This is a doc-only workstream; `docker compose run --rm dev run test` is not required.

## Validation

Sanity checks:

1. `ls spec/adr/` shows both `0001-...` and `0002-...`.
2. Markdown renders cleanly (headings, code fences balanced, no broken internal links).
3. The ADR does not reference files or symbols that don't exist. Spot-check: `scripts/extract_rs/`, `packages/verify/src/extractors/rust.ts`, `Dockerfile`, `spec/06-toolchain-profiles.md`, `spec/07-adversarial-scopes.md` all exist in the tree.

No build, lint, or test invocation required.

## Commit

```
Stage 3b: ADR-0002 — syn helper for Rust signature extraction

Captures why bollard-extract-rs uses syn + a standalone static
binary built in a discarded Dockerfile stage, rather than
rustc --emit=metadata, rust-analyzer-as-library, or a WASM build.
Sets the precedent for future native helpers.
```

## Reporting back

When done, report:
1. File path of the new ADR
2. Commit SHA
3. Anything you added or removed relative to the section guidance above (especially if the "Options Considered" list grew or shrank based on what you found in the actual code)
