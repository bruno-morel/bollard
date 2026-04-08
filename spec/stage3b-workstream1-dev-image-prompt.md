# Stage 3b — Workstream 1: Polyglot Dev Image (`dev` + `dev-full` split)

> Cursor/Claude Code prompt for the first workstream of Stage 3b. Builds the multi-stage Docker setup, the `dev-full` compose profile, the two native extractor helpers (Go via `go/ast`, Rust via `syn`), and flips the Stage 3a `it.skipIf` extractor tests to unconditional.
>
> **Unblocker for everything else in Stage 3b.** Workstreams 2–10 all depend on `dev-full` existing and the helper binaries being on PATH.
>
> **Out of scope for this pass:** the extractor *rewrites* themselves (workstreams 2 and 3 replace `extractors/go.ts` and `extractors/rust.ts` to consume the new helpers), the polyglot contract graph (workstreams 4–7), risk-gate/parser depolyglotting (workstream 8), grounding log event (workstream 9), Python/Go/Rust self-test validation (workstream 10).

## Source of truth

Read these BEFORE writing any code:
- `CLAUDE.md` — current Docker/compose setup, "Known limitations (post Stage 3a)" section, Stage 3a → 3b follow-ups list
- `spec/06-toolchain-profiles.md` — three-layer verification, why Docker is the isolation boundary (Principle 9)
- `packages/verify/src/extractors/go.ts`, `packages/verify/src/extractors/rust.ts` — the shallow stubs to be replaced in later workstreams; this workstream only builds the helpers they'll call
- `packages/verify/tests/type-extractor.test.ts` — find the two `it.skipIf(...)` blocks marked `TODO(stage-3b)`

When in doubt, the spec and `CLAUDE.md` win. If this prompt disagrees with either, stop and flag it.

## Non-negotiables (carry over from Stage 0–3a)

- Run **everything** through `docker compose run --rm dev ...` (or `docker compose --profile full run --rm dev-full ...` for the new image) — never bare `pnpm`/`node`/`tsc`/`vitest`/`biome`/`go`/`cargo` on the host.
- TypeScript strict mode, `exactOptionalPropertyTypes`, no `any`, named exports only, no semicolons (Biome).
- All errors via `BollardError` with codes; never raw `Error`.
- Tests for every source file, in `packages/<pkg>/tests/`.
- No new TypeScript runtime dependencies. Native helpers (`scripts/extract_go/`, `scripts/extract_rs/`) are allowed to pull in Go stdlib and `syn`/`serde`/`serde_json` respectively — those are build-time, not runtime TS deps.
- Path-traversal protection for any new tool/extractor that touches the filesystem. The helpers will be called later from workstreams 2–3 with `filterUnderWorkDir`-sanitized paths; helpers themselves must still refuse absolute paths that escape their arg list and must not open network sockets.

## Goal

After this pass:

1. `docker compose build dev` still produces the fast day-to-day image (Node 22 + pnpm + python3 + the two new extractor binaries). **No Go or Rust toolchain at runtime.** Image size delta vs. current `dev` ≤ 30 MB.
2. `docker compose --profile full build dev-full` produces the heavy validation image (`dev` + full `golang-1.22` + `rustc`/`cargo` stable + `pytest`/`ruff` unchanged). Used for Stage 3b validation runs and any pipeline that needs to actually compile/run Go or Rust project code.
3. `bollard-extract-go` and `bollard-extract-rs` are on PATH in both images. Each accepts a list of file paths as positional args and emits a single JSON document on stdout in the exact shape already used by `scripts/extract_python.py`:
   ```json
   { "signatures": [ExtractedSignature, ...], "types": [ExtractedTypeDefinition, ...] }
   ```
   Shape must match `packages/verify/src/type-extractor.ts`'s `ExtractedSignature` and `ExtractedTypeDefinition` interfaces verbatim (`filePath`, `signatures`, `types`, `imports` for the first; `name`, `kind`, `definition`, `filePath` for the second).
4. The two `it.skipIf(...)` extractor tests in `packages/verify/tests/type-extractor.test.ts` become **unconditional** `it(...)` calls. `TODO(stage-3b)` markers removed. They run green on `dev` (because the helpers are present) and green on `dev-full`.
5. `CLAUDE.md` "Known limitations" and "Stage 3a → Stage 3b follow-ups" entries for the "Dev image Go/Rust gap" are removed/updated. Test counts updated in "Current Test Stats".

Workstreams 2 and 3 will replace the TypeScript bodies of `extractors/go.ts` and `extractors/rust.ts` to shell out to the helpers. **Do not touch those files in this workstream** — leave the shallow stubs in place so nothing regresses. The unconditional tests added in step 4 target the helpers directly via `execFile`, not via the TS extractor classes.

---

## Phase 1 — Multi-stage `Dockerfile`

**File:** `Dockerfile` (rewrite; current file is single-stage)

### 1.1 Target structure

Four named stages:

```dockerfile
# syntax=docker/dockerfile:1.7

# ──────────────────────────────────────────────────────────────
# Stage A — Go helper builder
# Builds scripts/extract_go/ into a static binary. Discarded after copy.
# ──────────────────────────────────────────────────────────────
FROM golang:1.22-bookworm AS go-helper-builder
WORKDIR /src
COPY scripts/extract_go/go.mod scripts/extract_go/go.sum* ./
RUN go mod download
COPY scripts/extract_go/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/bollard-extract-go .

# ──────────────────────────────────────────────────────────────
# Stage B — Rust helper builder
# Builds scripts/extract_rs/ into a release binary. Discarded after copy.
# ──────────────────────────────────────────────────────────────
FROM rust:1.80-slim-bookworm AS rust-helper-builder
WORKDIR /src
COPY scripts/extract_rs/Cargo.toml scripts/extract_rs/Cargo.lock* ./
# Pre-warm the dep cache with a stub main so cargo can fetch/compile deps
RUN mkdir src && echo 'fn main(){}' > src/main.rs && cargo build --release && rm -rf src target/release/bollard-extract-rs
COPY scripts/extract_rs/src ./src
RUN cargo build --release && cp target/release/bollard-extract-rs /out/bollard-extract-rs

# ──────────────────────────────────────────────────────────────
# Stage C — dev (fast, day-to-day)
# Node 22 + pnpm + python3 + helper binaries. No Go or Rust toolchain.
# ──────────────────────────────────────────────────────────────
FROM node:22-slim AS dev
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git ca-certificates \
        python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY --from=go-helper-builder   /out/bollard-extract-go /usr/local/bin/bollard-extract-go
COPY --from=rust-helper-builder /out/bollard-extract-rs /usr/local/bin/bollard-extract-rs
RUN bollard-extract-go  --version && bollard-extract-rs --version   # smoke check
WORKDIR /app
ENTRYPOINT ["pnpm"]

# ──────────────────────────────────────────────────────────────
# Stage D — dev-full (Stage 3b validation)
# Extends dev with full Go 1.22 and Rust stable toolchains so the
# pipeline can actually run `go test` / `cargo test` / `pytest`
# against Python/Go/Rust self-test fixtures.
# ──────────────────────────────────────────────────────────────
FROM dev AS dev-full
ENV GOPATH=/go GOTOOLCHAIN=local PATH=/usr/local/go/bin:/go/bin:/root/.cargo/bin:$PATH
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl build-essential pkg-config \
    && rm -rf /var/lib/apt/lists/*
# Go 1.22 from upstream tarball (keeps image reproducible across arches)
RUN ARCH=$(dpkg --print-architecture) \
    && case "$ARCH" in \
         amd64) GO_ARCH=amd64 ;; \
         arm64) GO_ARCH=arm64 ;; \
         *) echo "unsupported arch $ARCH" && exit 1 ;; \
       esac \
    && curl -fsSL "https://go.dev/dl/go1.22.6.linux-${GO_ARCH}.tar.gz" | tar -C /usr/local -xz \
    && go version
# Rust stable via rustup (minimal profile — no docs/src)
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal \
    && rustc --version && cargo --version
# Python dev deps used by self-test fixtures
RUN pip3 install --break-system-packages --no-cache-dir pytest ruff
WORKDIR /app
ENTRYPOINT ["pnpm"]
```

### 1.2 Size budget

- `dev` target: must stay within ~30 MB of the current single-stage image. Verify with `docker images --format "{{.Repository}}:{{.Tag}} {{.Size}}"` before/after. The two helper binaries are each ~5–10 MB static.
- `dev-full`: expect ~1.0–1.3 GB. That's fine — it's opt-in.

### 1.3 `--version` flag on helpers

Both helpers must accept `--version` and print a single-line version string (used by the `RUN` smoke check in stage C). See Phases 2 and 3 below for the flag plumbing.

---

## Phase 2 — `scripts/extract_go/` Go helper

**New directory:** `scripts/extract_go/` with `main.go`, `go.mod`, `extract.go`, and a tiny `extract_test.go`.

### 2.1 `go.mod`

```
module github.com/anthropics/bollard/scripts/extract_go

go 1.22
```

No external deps. Only `go/ast`, `go/parser`, `go/token`, `go/types`, `encoding/json`, `os`, `path/filepath`, `strings`.

### 2.2 CLI shape

```
bollard-extract-go [--version] <file1.go> [<file2.go> ...]
```

- `--version` → print `bollard-extract-go 0.1.0` and exit 0.
- Any arg outside the cwd tree (resolved path doesn't start with the cwd) → print a JSON warning to stderr, skip the file, do not error out. The caller (`extractors/go.ts`, workstream 2) has already filtered, this is belt-and-braces.
- Files that don't parse → emit `{"signatures": [], "types": [], "warnings": ["<file>: <err>"]}` on stdout and exit 0. Never exit non-zero for recoverable errors.
- Unrecoverable errors (no args, helper bug) → exit 1, plain-text error to stderr.

### 2.3 What to extract

For each input file:

**`ExtractedSignature` (one per file):**
- `filePath`: absolute path
- `signatures`: one line per exported top-level decl. Formats:
  - `func Name(param Type, ...) ReturnType`
  - `func (recv Receiver) Method(param Type, ...) ReturnType`
  - `type Name struct { ... }` / `type Name interface { ... }` / `type Name = OtherType` / `type Name OtherType` (type alias vs. named type distinction preserved)
  - `const Name Type = value` / `var Name Type = value` (values omitted for non-literal exprs)
  - Only items where the identifier starts with an uppercase letter (Go's export rule). Private items skipped.
- `types`: pretty-printed field/method lists for exported structs and interfaces (the payload, not the header line). Empty string if none.
- `imports`: one line per import, `"path"` or `alias "path"`.

**`ExtractedTypeDefinition[]` (one per exported type decl):**
- `name`: type name
- `kind`: `"interface"` for interface types, `"type"` for struct/alias/named-type, `"enum"` for a set of exported `const` declarations of a single named integer-kind type (Go's idiomatic enum pattern — detect via `iota` or shared type in a `const ( ... )` block), `"const"` for a single exported const that isn't part of an enum block
- `definition`: the textual form of the declaration including field types, tags, and method signatures (no method bodies — Go interfaces don't have bodies anyway)
- `filePath`: absolute path

### 2.4 Implementation notes

- Use `parser.ParseFile(fset, path, nil, parser.ParseComments)` per file. Do **not** invoke `go/types` type-checking — it requires a full package load and would make the helper slow and cwd-sensitive. Syntactic extraction is enough for Stage 3b; workstream 2 can add `go/packages` later if we need cross-file type resolution within a package.
- Use `printer.Fprint` on the AST nodes to get the pretty-printed declarations, so generics, `~T` constraints, and embedded fields all round-trip correctly.
- Strip method bodies: for `*ast.FuncDecl`, clear `.Body` before printing the signature line.
- Enum detection heuristic: within a `GenDecl` of kind `token.CONST`, if two or more exported identifiers share the same declared type OR any spec uses `iota`, group them under a single `ExtractedTypeDefinition` with `kind: "enum"` and `name` equal to the shared type (or the file-local group name if untyped). This is approximate — acceptable for Stage 3b.

### 2.5 `extract_test.go`

Three tiny fixture cases verifying JSON output shape for:
1. A file with one exported func and one unexported func → only the exported one appears.
2. A file with an exported struct + interface + type alias → all three appear in `types[]` with correct `kind`.
3. A file that fails to parse → `signatures: []`, `types: []`, `warnings` populated, exit 0.

Run via `go test ./...` inside the Go builder stage during `docker compose build` — add the test step as a `RUN` before the final `go build`.

---

## Phase 3 — `scripts/extract_rs/` Rust helper

**New directory:** `scripts/extract_rs/` with `Cargo.toml`, `Cargo.lock` (checked in for reproducible builds), `src/main.rs`, `src/extract.rs`, and a tiny `tests/extract.rs`.

### 3.1 `Cargo.toml`

```toml
[package]
name = "bollard-extract-rs"
version = "0.1.0"
edition = "2021"
rust-version = "1.80"

[[bin]]
name = "bollard-extract-rs"
path = "src/main.rs"

[dependencies]
syn = { version = "2", features = ["full", "extra-traits", "printing"] }
proc-macro2 = { version = "1", features = ["span-locations"] }
quote = "1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[profile.release]
lto = true
codegen-units = 1
strip = true
```

No other deps. No tokio/async. No networking.

### 3.2 CLI shape

Mirror the Go helper:

```
bollard-extract-rs [--version] <file1.rs> [<file2.rs> ...]
```

Same error semantics: `--version` → print and exit 0; file not found / parse error → stdout JSON with warnings, exit 0; bug → exit 1.

### 3.3 What to extract

For each input file, parse with `syn::parse_file(&contents)?`, then walk the top-level `Items`. Only `pub` (or `pub(crate)` / `pub(super)` → treat as exported for Stage 3b; flag it in a comment) items are emitted.

**`ExtractedSignature` (one per file):**
- `filePath`
- `signatures`: one line per exported item. Formats:
  - `pub fn name<G: Bound>(param: Type, ...) -> ReturnType where W: Bound`
  - `pub async fn ...`
  - `pub const NAME: Type = <expr>` (expr kept for literals, replaced with `...` otherwise)
  - `pub static NAME: Type = <expr>`
  - `pub struct Name<G>` (header only — fields go in `types`)
  - `pub enum Name<G>` (header only — variants in `types`)
  - `pub trait Name<G>: Bound` (header only — methods in `types`)
  - `pub type Name<G> = OtherType`
  - `pub use path::Item` (re-exports — important for contract graph in workstream 7)
- `types`: empty string (all structured type info lives in `types[]` below)
- `imports`: `use` statements (non-`pub`), one per line

**`ExtractedTypeDefinition[]`:**
- `pub struct Foo { ... }` → `kind: "type"`, `definition` includes the full field list with types and `#[derive]` attrs if present
- `pub enum Foo { ... }` → `kind: "enum"`, `definition` includes all variants (tuple, struct, unit)
- `pub trait Foo { ... }` → `kind: "interface"`, `definition` includes method signatures (no default-impl bodies) and associated types/consts
- `pub type Foo = Bar` → `kind: "type"`
- `pub const NAME: T = <expr>` → `kind: "const"`

Use `syn`'s `ToTokens` to pretty-print each item, then run a small regex pass to strip function/trait-method bodies (`{ ... }` after the signature). Keep attributes, generics, where clauses, and lifetimes intact.

### 3.4 Implementation notes

- One file = one `syn::File` parse. No cross-file resolution in this workstream — that's workstream 7 (Rust contract graph).
- For `pub(crate)` / `pub(super)` visibility, include but add a `visibility` hint at the end of the signature line, e.g. `pub(crate) fn foo(...)`. The contract-tester prompt will ignore it for now; workstream 7 can use it to prune the graph.
- Parse errors: capture `syn::Error::to_string()` into the `warnings` array; do not crash.
- Rust build reproducibility: commit `Cargo.lock`. The Rust builder stage uses `--frozen` to enforce it.

### 3.5 `tests/extract.rs`

Three cases:
1. File with one `pub fn` and one private `fn` → only `pub` appears.
2. File with `pub struct` (generic, with derive attrs), `pub enum` (mixed variants), `pub trait` (with associated type + method) → all three in `types[]` with correct `kind` and full definitions.
3. File that fails to parse → empty `signatures`/`types`, `warnings` populated, exit 0.

Wired into `cargo test` in the Rust builder stage as a `RUN cargo test --release` step before `cargo build --release` (or reuse the build with `cargo test --release` since that also builds).

---

## Phase 4 — `compose.yaml` profile split

**File:** `compose.yaml` (extend — do not rewrite the existing `dev` service beyond pointing it at the new target).

### 4.1 Service definitions

```yaml
services:
  dev:
    build:
      context: .
      target: dev
    volumes:
      - .:/app
      - bollard-node-modules:/app/node_modules
      - bollard-pnpm-store:/root/.local/share/pnpm/store
    environment:
      - ANTHROPIC_API_KEY
      - OPENAI_API_KEY
      - GOOGLE_API_KEY
      - BOLLARD_AUTO_APPROVE
    entrypoint: ["pnpm"]

  dev-full:
    profiles: ["full"]
    build:
      context: .
      target: dev-full
    volumes:
      - .:/app
      - bollard-node-modules-full:/app/node_modules
      - bollard-pnpm-store-full:/root/.local/share/pnpm/store
      - bollard-go-cache:/root/.cache/go-build
      - bollard-cargo-cache:/root/.cargo/registry
    environment:
      - ANTHROPIC_API_KEY
      - OPENAI_API_KEY
      - GOOGLE_API_KEY
      - BOLLARD_AUTO_APPROVE
    entrypoint: ["pnpm"]

volumes:
  bollard-node-modules:
  bollard-pnpm-store:
  bollard-node-modules-full:
  bollard-pnpm-store-full:
  bollard-go-cache:
  bollard-cargo-cache:
```

Notes:
- `dev-full` gets its own `node_modules` and `pnpm-store` volumes so the two images don't fight over binary compatibility (different base layers, same Node major, but better safe).
- `bollard-go-cache` and `bollard-cargo-cache` persist compiled Go/Rust artifacts *for the project code the pipeline runs against*, not for the helpers (those are baked into the image).
- `profiles: ["full"]` means `docker compose build` and `docker compose run dev …` both ignore `dev-full`. To use it: `docker compose --profile full build dev-full` and `docker compose --profile full run --rm dev-full run test`.

### 4.2 Documentation update

Add a new subsection to `CLAUDE.md` under "Development via Docker Compose (Mandatory)":

```markdown
### Two images: `dev` and `dev-full`

Bollard ships two Docker targets:

- **`dev`** (default, fast): Node 22 + pnpm + python3 + pre-built Go/Rust extractor helpers. Use this for day-to-day TS development, unit tests, and any pipeline run that doesn't touch Go or Rust project code. Built by `docker compose build dev`.
- **`dev-full`** (opt-in via compose profile `full`): extends `dev` with full Go 1.22 and Rust stable toolchains plus `pytest`/`ruff`. Required for Stage 3b validation runs and any pipeline that runs `go test` / `cargo test` / `pytest` against project code. Built by `docker compose --profile full build dev-full`. Run with `docker compose --profile full run --rm dev-full …`.

CI runs the fast suite on `dev` and the Stage 3b validation suite on `dev-full`. Day-to-day contributors never need to build `dev-full` unless they're working on polyglot pipeline runs.
```

---

## Phase 5 — Flip `it.skipIf` extractor tests

**File:** `packages/verify/tests/type-extractor.test.ts`

### 5.1 Find and flip

Locate the two `it.skipIf(...)` blocks marked `TODO(stage-3b)` — one for Go, one for Rust (and possibly one for Python that's already unconditional). Replace each with an unconditional `it(...)` block.

### 5.2 Change what they test

The current skip predicate checks for `go` / `rustc` on PATH. The new world has `bollard-extract-go` / `bollard-extract-rs` on PATH in both images, but **not** `go` / `rustc` in the `dev` image. Rewrite the tests so they:

1. Are unconditional (`it(...)`, no `skipIf`).
2. Target the helper binaries directly via `execFile`, not via the TS `GoAstExtractor` / `RustExtractor` classes (those classes still contain the shallow Stage 2 implementations until workstreams 2–3 land — do not touch them in this workstream).
3. Write a tiny fixture file to a temp dir, run the helper with the fixture as argv, parse the JSON, assert on the shape: `signatures` is an array, `types` is an array, at least one exported item was captured for each fixture.
4. Leave a `// TODO(workstream-2/3): replace with GoAstExtractor/RustExtractor assertions once those classes shell out to the helpers` comment so the follow-on workstream has a clear anchor.

### 5.3 New test file locations for helpers

Because we're shelling out to new binaries, add a dedicated `packages/verify/tests/extractor-helpers.test.ts` with the fixture-driven tests above. Keep the existing `type-extractor.test.ts` focused on the TS extractor classes. Delete the skipped blocks in `type-extractor.test.ts` entirely (they were placeholders for this exact moment).

### 5.4 Fixture files

Add under `packages/verify/tests/fixtures/extractor-helpers/`:
- `go/sample.go` — exported func + unexported func + exported struct + exported interface
- `rust/sample.rs` — `pub fn` + private `fn` + `pub struct` with generics + `pub enum` + `pub trait`

Keep them ≤ 30 lines each. Their purpose is to prove the helpers parse *anything*, not to exhaustively cover Go/Rust syntax — workstreams 2 and 3 will add semantic coverage.

---

## Phase 6 — `CLAUDE.md` updates

Edit `CLAUDE.md` to reflect the new state:

1. **"Known limitations (post Stage 3a)" section** — remove the "Dev image Go/Rust gap" bullet. Replace with: "Extractor *rewrites* for Go and Rust still use Stage 2 stubs — workstreams 2–3 will wire them through the new helpers."
2. **"Stage 3a → Stage 3b follow-ups" section** — strike through or mark the "Go / Rust in the dev image" item as ✅ done.
3. **"Current Test Stats" section** — run `docker compose run --rm dev run test` and update the authoritative count. Expected delta: +3 tests from the new `extractor-helpers.test.ts` file. No tests should regress.
4. **"Development via Docker Compose (Mandatory)" section** — add the "Two images: `dev` and `dev-full`" subsection from Phase 4.2.
5. **"Project Structure" section** — add `scripts/extract_go/` and `scripts/extract_rs/` to the tree, and note the new `Dockerfile` stages.

---

## Phase 7 — Validation checklist

Before declaring workstream 1 done, run all of these from a clean checkout:

```bash
# Fast image builds and tests green
docker compose build dev
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test

# Helpers are on PATH in the fast image
docker compose run --rm --entrypoint sh dev -c 'bollard-extract-go --version && bollard-extract-rs --version'

# Full image builds (will take several minutes — expected)
docker compose --profile full build dev-full

# Full image has Go and Rust toolchains
docker compose --profile full run --rm --entrypoint sh dev-full -c 'go version && cargo --version && rustc --version && pytest --version && ruff --version'

# Full image still passes the existing test suite
docker compose --profile full run --rm dev-full run test

# Size sanity check
docker images | grep bollard
```

Expected outcomes:
- All typecheck / lint / test invocations exit 0 on both images.
- `dev` image ≤ current image size + 30 MB.
- `dev-full` image in the 1.0–1.3 GB range.
- Test count increases by exactly +3 (new helper tests), no regressions.
- The two `TODO(stage-3b)` markers are gone from `packages/verify/tests/type-extractor.test.ts`.

## Commit plan

Land as **one commit** on `main`:

```
Stage 3b: dev + dev-full split, Go/Rust extractor helpers, unblock extractor tests

- Multi-stage Dockerfile: go-helper-builder, rust-helper-builder, dev, dev-full
- scripts/extract_go: go/ast helper emitting ExtractedSignature + ExtractedTypeDefinition JSON
- scripts/extract_rs: syn-based helper with the same JSON shape
- compose.yaml: dev-full service behind `full` profile
- packages/verify/tests/extractor-helpers.test.ts: unconditional helper tests
- Remove Stage 3a TODO(stage-3b) it.skipIf blocks from type-extractor.test.ts
- CLAUDE.md: document the split, update limitations and test counts
```

Do **not** bundle workstreams 2 or 3 into this commit. The TS extractor classes (`packages/verify/src/extractors/go.ts`, `rust.ts`) are untouched in this workstream — they still emit the shallow Stage 2 output. Workstreams 2 and 3 will replace their bodies to shell out to the helpers, and are their own commits.

## Open questions to flag if you hit them

1. If the Go builder stage's `go mod download` is slow because of the proxy, switch to `GOFLAGS=-mod=mod` — do **not** vendor deps (we have none).
2. If `syn` 2.x changes API shape before you build this, pin to `=2.0.x` and note it in the ADR that workstream 3 will write.
3. If the `dev-full` image crosses 1.5 GB, stop and flag it — something is bundled that shouldn't be (likely Rust docs or the full `build-essential` chain). The `--profile minimal` rustup flag and `--no-install-recommends` on apt should keep it well under.
4. If the fast `dev` image grows by more than 30 MB, the helpers are probably dynamically linked. Re-check that the Go builder uses `CGO_ENABLED=0` and that the Rust `[profile.release]` block in Cargo.toml is present and `strip = true`.

When workstream 1 is green against the full validation checklist, stop. Report image sizes, test counts, and the commit SHA. Workstream 2 (Go extractor rewrite) is next.
