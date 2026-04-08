# ADR-0002: syn-based helper binary for Rust signature extraction

**Status:** Accepted
**Date:** 2026-04-08
**Deciders:** Bruno (maintainer)
**Supersedes:** —
**Related:** [spec/06-toolchain-profiles.md](../06-toolchain-profiles.md), [spec/07-adversarial-scopes.md](../07-adversarial-scopes.md), Stage 3b workstreams 1 and 3

## Context

Stage 3b's goal for Rust is the same as for Python and Go: replace the regex-stub extractor in `packages/verify/src/extractors/rust.ts` with a real AST-backed extractor that produces `ExtractedSignature` and `ExtractedTypeDefinition` records matching the output shape of the Python and Go extractors. The output feeds the boundary-tester and contract-tester agents — if it's wrong, hallucinated, or incomplete, every downstream adversarial test is built on sand.

The forces:

- **Node-side parsing vs. Rust's own ecosystem.** The rest of Bollard is TypeScript. Keeping extraction in TypeScript would mean writing a Rust parser in JS (no mature option exists) or compiling an existing Rust parser to WASM and calling it from Node. Alternatively, we can shell out to a Rust binary that uses the language's canonical parsing crate — `syn` — and emits JSON.
- **`dev` image boot time vs. runtime correctness.** The helper binary must be available inside the Docker image without requiring the user to install a Rust toolchain on the host. Build cost is paid once per `docker compose build dev`; runtime cost is a single `execFile` per extraction call.
- **The deterministic-extractor precedent.** Stage 2 established that deterministic extractors are preferred for known languages, with LLM fallback reserved for unknown languages (`getExtractor` routes TS/Python/Go/Rust to deterministic extractors; unknown without a provider throws `PROVIDER_NOT_FOUND`). Whatever we pick for Rust must fit this pattern.
- **The Dockerfile constraint from workstream 1.** Workstream 1 introduced multi-stage builds with `go-helper-builder` and `rust-helper-builder` stages. The builder stages are discarded — neither runtime image (`dev` or `dev-full`) carries the build toolchain for the purpose of building helpers. The Rust helper must build inside this existing infrastructure without bloating the `dev` image beyond its ~989 MB baseline. (The ~2.2 GB floor is `dev-full`, which carries full Go + Rust toolchains for running project code, not for rebuilding helpers.)

## Decision

Rust signature extraction runs through a standalone static binary, `bollard-extract-rs`, built from `scripts/extract_rs/` using the `syn` crate (with features `full`, `extra-traits`, `printing`) plus `serde_json` for output serialization. Dependencies: `syn`, `proc-macro2` (with `span-locations`), `quote`, `serde` (with `derive`), `serde_json`.

The binary is built in a dedicated `rust-helper-builder` stage in the root `Dockerfile` (`FROM rust:1.80-slim-bookworm`) and copied into `dev` at `/usr/local/bin/bollard-extract-rs`. `dev-full` extends `dev`, so it inherits the pre-built binary without a second `COPY`. The builder stage is discarded — `dev-full` carries a full Rust toolchain via `rustup` for running project Rust code, not for rebuilding the helper.

`RustSynExtractor` (in `packages/verify/src/extractors/rust.ts`) shells out to the binary via `execFile` (promisified), parses the JSON stdout, and mirrors the Python/Go extractor pattern: same `filterUnderWorkDir` guard to drop paths outside the work directory, same `cwd` requirement, same graceful degradation on helper failure (returns empty extraction with optional `warn` callback).

The effective MSRV floor is Rust 1.80, set by the Dockerfile base image tag (`rust:1.80-slim-bookworm`), not by a `rust-version` field in `Cargo.toml`. This is a deliberate choice: the helper's minimum supported Rust version is pinned at the Docker layer, where it's visible in the build log and tied to a specific Debian release. As long as the builder image tag is ≥ 1.80 the helper compiles. This differs from the pinned Node/pnpm versions (which are explicit in `package.json`) because MSRV-via-base-image is Rust-idiomatic for projects that don't publish to crates.io.

## Options Considered

### Option 1: `rustc --emit=metadata` + parse `.rmeta`

Use `rustc` directly to emit metadata (`.rmeta`) files containing type and signature information, then parse those from Node.

| Dimension | Assessment |
|-----------|------------|
| Complexity | High — `.rmeta` is an internal compiler format |
| Runtime deps | Requires `rustc` at extraction time |
| Stability | Poor — `.rmeta` format is explicitly unstable |
| Accuracy | High (compiler-derived) |

**Rejected.** `.rmeta` is an unstable internal format oriented around incremental compilation, not signature extraction. The `-Z` flags needed to control its output are nightly-only. Adopting this would pin Bollard to nightly Rust, contradicting the "deterministic, stable" extractor requirement. The format has no public specification and changes between compiler versions without notice.

### Option 2: `rust-analyzer` as a library

Import `rust-analyzer`'s analysis engine as a Rust library, build it into the helper binary, and use its semantic model for extraction.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Very high — enormous dependency tree |
| Runtime deps | Self-contained (statically linked) |
| Stability | Poor — internal API is explicitly not stable |
| Accuracy | Highest (full semantic analysis) |

**Rejected.** `rust-analyzer` is the highest-fidelity option but is enormous (hundreds of MB when vendored). Its internal API is explicitly unstable — the maintainers reserve the right to break it between any two releases. It is designed to run as an LSP server with incremental analysis, not as a batch CLI. The startup cost alone would dominate the extraction call, and the dependency tree would multiply the builder-stage build time by an order of magnitude.

### Option 3: WASM-compiled `syn` called from Node

Compile `syn` to WebAssembly, bundle the `.wasm` blob inside `@bollard/verify`, and call it from TypeScript without a binary-on-PATH requirement.

| Dimension | Assessment |
|-----------|------------|
| Complexity | High — WASM build tooling for `syn`'s dependency tree |
| Runtime deps | None beyond Node |
| Stability | Good (same `syn` crate) |
| Accuracy | Same as Option 4 |

**Rejected.** Would eliminate the binary-on-PATH requirement and unify with the TypeScript stack, but `syn` pulls in `proc-macro2` and has enough transitively linked code (via `unicode-ident`, etc.) that a clean WASM build is non-trivial. The packaging story — how does pnpm ship a WASM blob inside `@bollard/verify`? — regresses the "one `compose build`, one `dev` image" property. Every `pnpm install` would need to handle a platform-specific binary or a WASM artifact, adding a new failure mode to the developer onboarding path.

### Option 4: Standalone `syn` binary, copied into `dev` (chosen)

A few hundred lines of Rust wrap `syn` into a CLI that takes positional file paths and emits `{signatures, types, warnings}` JSON on stdout. Built once per `docker compose build dev` in a discarded builder stage.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low — thin wrapper around a stable, canonical crate |
| Runtime deps | None (static binary) |
| Stability | Excellent — `syn` is stable since 1.0, used by every major proc-macro |
| Accuracy | High (full syntactic analysis; no semantic resolution) |

**Chosen.** `syn` is the canonical Rust parsing crate — stable, fast, and battle-tested across the entire Rust ecosystem. The binary has no runtime dependencies, lives at `/usr/local/bin/bollard-extract-rs`, and is cacheable in a Docker layer. Day-to-day `docker compose build dev` is fast after the first build because the builder stage's dependency layer is cached. The pattern is identical to the Go helper (`bollard-extract-go`), giving one mental model for all native extractors.

The known limitation is that `syn` performs syntactic analysis, not semantic analysis. It parses `fn` signatures, `struct`/`enum`/`trait` definitions, and `impl` blocks, but does not resolve types across module boundaries or evaluate `cfg` attributes. For the purposes of signature extraction (feeding the adversarial testers), syntactic accuracy is sufficient — the contract-tester's grounding verifier (ADR-0001) catches any downstream hallucinations that arise from incomplete type information.

## Consequences

**Positive:**

- Deterministic, fast, hallucination-free extraction. The `syn` parser either parses the file correctly or returns a parse error — there is no "mostly right" failure mode, unlike LLM-based extraction.
- Same pattern as Go (`scripts/extract_go/`) and Python (inline script) helpers: pick the language's canonical parsing library, wrap it in a CLI that matches the `{signatures, types, warnings}` output shape, build it in a discarded Dockerfile stage, copy the binary into `dev`. One mental model for all three native extractors.
- Helper is cacheable in the Docker layer. The `rust-helper-builder` stage only rebuilds when `Cargo.toml` or `src/` changes.
- Sets a clean precedent for future native helpers. The pattern for a new language is: canonical parser library → thin CLI wrapper → discarded builder stage → binary in `dev`.

**Negative:**

- Every new native helper adds a builder stage to the root `Dockerfile`. At some point the cold-build time becomes painful (workstream 1's combined Go + Rust build is already non-trivial). Mitigation: accept it; keep helper stages small and discrete; Docker layer caching covers the common case.
- The effective MSRV floor (Rust 1.80 via the Docker base image) means the helper cannot use post-1.80 language features without bumping the base image tag. The current helper uses nothing exotic, so this is cheap today.
- The helper binary is distributed inside the `dev` image, not published as a crate or npm package. Running the `RustSynExtractor` tests outside the Docker environment silently degrades (the binary is not on PATH, so the extractor returns empty results via its graceful-failure path). This is acceptable because Bollard's mandatory workflow is Docker-first (see CLAUDE.md "Development via Docker Compose"), but it is worth calling out so a future contributor doesn't file a confusing bug when tests pass locally but produce no extraction output.
- Syntactic-only analysis means `syn` cannot resolve type aliases, cross-module references, or conditional compilation (`#[cfg(...)]`). For Stage 3b's scope (signature extraction for adversarial test generation), this is acceptable — the grounding verifier (ADR-0001) catches downstream issues. For a future Rust contract graph (workspace-level edge extraction), deeper analysis may be needed.

**Precedent for future helpers:**

The pattern established by the Go and Rust helpers is:

1. Pick the language's canonical, stable parsing library (Go: `go/ast`; Rust: `syn`).
2. Write a thin CLI wrapper that reads file paths as positional args and emits `{signatures, types, warnings}` JSON on stdout.
3. Build the wrapper in a dedicated Dockerfile stage named `<lang>-helper-builder`, starting from the language's official slim image.
4. Copy the binary into `/usr/local/bin/bollard-extract-<lang>` in the `dev` stage. `dev-full` inherits it.
5. On the TypeScript side, create a `<Lang>Extractor` class that implements `SignatureExtractor`, shells out via `execFile`, parses JSON, and applies `filterUnderWorkDir`.

This pattern holds for languages where the canonical parser is a native library (compiled to a static binary). It may not hold for languages where the canonical parser is a heavyweight runtime (e.g., Roslyn for C#, which requires the .NET runtime). See Open Questions.

## Open Questions

- **How does this generalize to Java / Kotlin / C#?** Each of those has a heavier canonical parser. Java's `javaparser` is a Java library (requires a JVM). Kotlin's PSI layer is part of the Kotlin compiler (also JVM). C#'s Roslyn requires the .NET runtime. The "small static binary in a discarded builder stage" assumption may not hold — the builder stage would need a JVM or .NET SDK, and the resulting binary may not be static. Revisit when Wave 2 of the language rollout (per [spec/07-adversarial-scopes.md](../07-adversarial-scopes.md) §12.1) starts.
- **Should `bollard-extract-rs` eventually read `Cargo.toml` to scope extraction to the workspace's public surface?** Today it extracts signatures from every file it is given. For the contract graph (workspace-level edge extraction, Stage 3b+), the extractor may need to understand which items are `pub` at the crate root vs. `pub(crate)` or private. That scoping logic would mirror what `buildContractContext` does for TypeScript's `package.json` `exports["."]` re-export closure.
- **If `dev-full` ever carries a newer `rustc` than the `rust-helper-builder` stage uses, does that matter?** Not today — the helper is pre-built into `dev` from the builder stage, and `dev-full` inherits it. The `rustc` in `dev-full` is for running project Rust code (`cargo test`, `cargo build`), not for rebuilding the helper. A version mismatch would only matter if the helper needed to link against `dev-full`'s Rust standard library, which it does not.
- **Should `Cargo.toml` declare an explicit `rust-version` field?** Currently the MSRV is implicit in the Dockerfile base image tag. Adding `rust-version = "1.80"` to `Cargo.toml` would make it discoverable by `cargo` tooling (e.g., `cargo msrv`) and would cause `cargo build` to fail fast with a clear error if someone attempted a build with an older `rustc`. The downside is maintaining two sources of truth (Dockerfile tag + manifest field). Low priority — revisit if the MSRV needs to be bumped.
