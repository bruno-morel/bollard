# Stage 3b — Workstream 7: Rust contract graph provider + file split

> **Scope:** two logical changes in one workstream: (1) split `contract-extractor.ts` (1053 lines, 3 providers) into a `contract-providers/` directory with one file per provider plus a shared types/router module, and (2) implement `RustContractProvider` in the new structure. The split is a mechanical move (no behavior change); the Rust provider is new behavior.

## Part A: File split

### Target structure

```
packages/verify/src/
  contract-extractor.ts            ← KEPT: re-exports types + router
  contract-providers/
    types.ts                       ← ModuleNode, ContractEdge, ContractContext, ContractGraphProvider, filterByPublicSurface
    typescript.ts                  ← TypeScriptContractProvider + TS-specific helpers
    python.ts                      ← PythonContractProvider + Python-specific helpers
    go.ts                          ← GoContractProvider + Go-specific helpers
    rust.ts                        ← NEW: RustContractProvider + Rust-specific helpers
```

### Rules

- **`contract-extractor.ts` becomes a thin barrel:**
  ```typescript
  export type { ModuleNode, ContractEdge, ContractContext, ContractGraphProvider } from "./contract-providers/types.js"
  export { buildContractContext } from "./contract-providers/types.js"
  ```
  Every existing import site (`import { buildContractContext } from "../contract-extractor.js"`) continues to work without edits. **No call site changes.** This is the non-negotiable constraint.

- **`contract-providers/types.ts` holds:**
  - The four exported interfaces (`ModuleNode`, `ContractEdge`, `ContractContext`, `ContractGraphProvider`)
  - The shared `filterByPublicSurface` helper (used by TS, Python, and will be used by Rust)
  - The `PROVIDERS` map
  - The `buildContractContext` router function
  - The `LanguageId` and `ToolchainProfile` type imports

- **Each provider file exports only its class** (for registration in `types.ts`). All language-specific helpers stay private inside the provider file.

- **Registration:** `types.ts` imports the provider classes and populates `PROVIDERS`:
  ```typescript
  import { TypeScriptContractProvider } from "./typescript.js"
  import { PythonContractProvider } from "./python.js"
  import { GoContractProvider } from "./go.js"
  import { RustContractProvider } from "./rust.js"

  const PROVIDERS: Partial<Record<LanguageId, ContractGraphProvider>> = {
    typescript: new TypeScriptContractProvider(),
    python: new PythonContractProvider(),
    go: new GoContractProvider(),
    rust: new RustContractProvider(),
  }
  ```

- **The `typescript` import:** `TypeScriptContractProvider` uses the `typescript` package (`ts.createSourceFile`, etc.). That import moves to `contract-providers/typescript.ts`. The `typescript` dep is already in `@bollard/verify`'s `package.json` — no new dependency.

- **Verify the barrel works:** after the split, run `docker compose run --rm dev run typecheck` to confirm no import path breaks. Every consumer of `buildContractContext` imports from `../contract-extractor.js` or `./contract-extractor.js` — the barrel re-export keeps those paths stable.

### Validation of the split (before adding Rust)

The file split is a mechanical refactor. To verify it:

1. `docker compose run --rm dev run typecheck` — must pass (no broken imports)
2. `docker compose run --rm dev run test` — must pass with **496 passed / 2 skipped** (identical to pre-split)
3. Optionally: `bollard contract` diff against pre-split output (same technique as WS4)

You may commit the split separately before adding the Rust provider, or combine both into one commit. Two commits is cleaner but not required.

## Part B: `RustContractProvider`

### Design

Rust's workspace model:

- **`Cargo.toml` with `[workspace]`** at the repo root. The `members` array lists crate directories (supports globs like `crates/*`).
- Each member directory has its own `Cargo.toml` with `[package] name = "..."`.
- Single-crate repos: just a root `Cargo.toml` with `[package]` and no `[workspace]`.

Public surface:

- Rust's visibility rules: `pub` items are public. Items without `pub` are private to the module.
- The `bollard-extract-rs` helper already filters to `pub` items only.
- `pub(crate)` items are crate-internal — they should be excluded. The helper emits them as `pub(crate)` in the signature string, so the provider can filter them out by checking if the signature contains `pub(crate)`.
- Files in directories that are not re-exported via `mod` in `lib.rs` or `main.rs` are technically unreachable, but for Stage 3b, include all non-test `.rs` files in `src/`. Deeper module-graph resolution is Stage 4.

Import edges:

- Rust `use` statements: `use cratename::module::Item;`, `use cratename::*;`
- External crate references: `extern crate name;` (rare in modern Rust, mostly implicit)
- Cross-crate edges: a `use` statement where the first path segment matches a workspace member's crate name. Crate names use underscores (`my_crate`), but `Cargo.toml` `[package] name` may use hyphens (`my-crate`). Rust normalizes hyphens to underscores in code, so match against both.

### Helpers

Add these to `contract-providers/rust.ts`:

#### a. Cargo workspace discovery

```
discoverCargoCrates(workDir: string): Promise<Map<string, string>>
```

Returns `Map<crateName, crateRootDir>`.

1. **Read root `Cargo.toml`** in `workDir`. If it has a `[workspace]` section with `members = [...]`, resolve each member pattern:
   - Literal paths: `"crates/auth"` → resolve to `workDir/crates/auth`
   - Glob paths: `"crates/*"` → list directories matching the glob (simple `*` wildcard only — no `**` or `?` needed for Stage 3b). For each resolved directory, read its `Cargo.toml` and extract `[package] name`.
2. **Fallback: root `[package]`** — if no `[workspace]` section, read `[package] name` from the root `Cargo.toml`. Single-crate repo.
3. **Bail** — no `Cargo.toml` → return empty + warn.

TOML parsing: same minimal line-by-line approach as the Python provider. Track section headers (`[workspace]`, `[package]`), extract `name = "..."` and `members = [...]`. For `members`, handle both single-line `members = ["a", "b"]` and multi-line:
```toml
members = [
    "crates/auth",
    "crates/billing",
]
```

#### b. Crate source listing

```
listCrateSourceFiles(crateRoot: string): Promise<string[]>
```

Walk `crateRoot/src/` for `.rs` files, excluding `*_test.rs`, `tests/`, `benches/`, `examples/`, and `target/`. Include `lib.rs`, `main.rs`, and all module files.

#### c. Rust import edge extraction

```
parseRustUseStatements(fileContent: string): string[]
```

Regex-based extraction of `use` paths:

- `use foo::bar::Baz;` → `"foo"`
- `use foo::*;` → `"foo"`
- `use foo::{Bar, Baz};` → `"foo"`

Only the first path segment matters (that's the crate name). Collect unique first segments, then match against known crate names from discovery. Skip `std`, `core`, `alloc`, `self`, `super`, `crate` (these are language-level, not workspace crates).

Handle the hyphen/underscore normalization: if a `Cargo.toml` declares `name = "my-crate"`, code references it as `my_crate`. Build a lookup that maps both `my_crate` and `my-crate` to the same crate ID.

#### d. `pub(crate)` filtering

After `RustSynExtractor.extract()` returns, filter out signatures and types where the signature/definition string contains `pub(crate)`. These are crate-internal and should not appear in the public contract surface.

#### e. Putting it together: `RustContractProvider.build()`

```
1. crates = await discoverCargoCrates(workDir)
2. if crates.size === 0 → return empty + warn
3. for each (name, root) of crates:
   a. files = await listCrateSourceFiles(root)
   b. extractor = new RustSynExtractor(warn)
   c. result = await extractor.extract(files, profile, workDir)
   d. signatures = result.signatures.filter(s => !s.signatures.includes("pub(crate)"))
   e. types = result.types.filter(t => !t.definition.includes("pub(crate)"))
   f. errorTypes = types.filter(t => t.name.endsWith("Error")).map(t => t.name)
   g. modules.push({ id: name, language: "rust", rootPath: root, publicExports: signatures, errorTypes })
4. Build edges:
   a. Build crateName → crateId lookup (both hyphenated and underscored forms)
   b. for each (name, root) of crates:
      for each .rs file:
        usePaths = parseRustUseStatements(content)
        for each firstSegment in usePaths:
          if matches a known crate (via normalized lookup):
            upsert edge { from: name, to: targetCrateName, importedSymbols: [firstSegment] }
   c. Like Go, Rust `use` imports modules/items from a crate, but the first
      segment is always the crate name. `importedSymbols` will contain the
      crate name, not individual items. Same granularity as Go.
5. affectedEdges = edges where from or to is in the touched set
6. return { modules, edges, affectedEdges }
```

### Tests

Add a `describe("RustContractProvider")` block in `contract-extractor.test.ts`. 5 cases:

1. **Cargo workspace with cross-crate import** — create:
   ```
   Cargo.toml       → [workspace]\nmembers = ["crates/auth", "crates/billing"]
   crates/auth/Cargo.toml  → [package]\nname = "auth"
   crates/auth/src/lib.rs  → pub fn login(user: &str) -> bool { true }
   crates/billing/Cargo.toml    → [package]\nname = "billing"
   crates/billing/src/lib.rs    → use auth::login;\npub fn charge() { login("x"); }
   ```
   Assert: 2 modules ("auth", "billing"), 1 edge (billing → auth), auth's publicExports includes `login`.

2. **Single-crate fallback (no `[workspace]`)** — create:
   ```
   Cargo.toml     → [package]\nname = "mylib"
   src/lib.rs     → pub fn hello() -> String { String::from("hi") }
   ```
   Assert: 1 module, 0 edges, publicExports includes `hello`.

3. **`pub(crate)` filtered from public surface** — create:
   ```
   Cargo.toml     → [package]\nname = "mylib"
   src/lib.rs     → pub fn public_fn() {}\npub(crate) fn internal_fn() {}
   ```
   Assert: publicExports includes a signature for `public_fn` but NOT `internal_fn`. (This depends on whether `bollard-extract-rs` emits `pub(crate)` items — if it doesn't, the filter is a no-op and this test verifies the helper already excludes them. Either way, assert the absence of `internal_fn`.)

4. **Empty workspace returns empty graph + warning** — empty temp dir. Assert: empty `ContractContext` + warn.

5. **Hyphen/underscore normalization** — create:
   ```
   Cargo.toml              → [workspace]\nmembers = ["crates/my-crate", "crates/consumer"]
   crates/my-crate/Cargo.toml   → [package]\nname = "my-crate"
   crates/my-crate/src/lib.rs   → pub fn do_stuff() {}
   crates/consumer/Cargo.toml   → [package]\nname = "consumer"
   crates/consumer/src/lib.rs   → use my_crate::do_stuff;\npub fn run() { do_stuff(); }
   ```
   Assert: edge from consumer → my-crate exists (the `use my_crate::` in code matches `name = "my-crate"` in Cargo.toml via underscore normalization).

### CLAUDE.md updates

- **"Known limitations"** — update `buildContractContext` bullet: "TypeScript, Python, and Go" → "TypeScript, Python, Go, and Rust". Drop the "other languages return an empty graph" qualifier if all five supported languages now have providers (TypeScript, Python, Go, Rust — but JavaScript is still missing; keep the qualifier for non-supported languages).
- **Test count** — bump. Expect 496 → 501 (+5 from Rust provider tests).
- **File tree** — update the `contract-extractor.ts` entry to show the new `contract-providers/` directory structure.
- **"Stage 3a → Stage 3b follow-ups"** — mark "Contract graph beyond TypeScript" as Done (workstreams 5/6/7).

## Commit strategy

Two commits recommended (but one combined is acceptable):

**Commit 1 (split):**
```
Stage 3b: split contract-extractor.ts into per-provider files

- Move TypeScriptContractProvider to contract-providers/typescript.ts
- Move PythonContractProvider to contract-providers/python.ts
- Move GoContractProvider to contract-providers/go.ts
- Shared types + router in contract-providers/types.ts
- contract-extractor.ts becomes a barrel re-export
- No behavior change; all call sites unchanged

496 passed / 2 skipped (identical to pre-split)
```

**Commit 2 (Rust provider):**
```
Stage 3b: add RustContractProvider to buildContractContext

- Discover crates via Cargo.toml [workspace] members or root [package]
- Filter pub(crate) items from public surface
- Hyphen/underscore normalization for cross-crate edge matching
- 5 tests: workspace, single-crate, pub(crate) filter, empty, hyphen
- Update CLAUDE.md: limitations, test count, file tree, follow-ups
```

## Out of scope

- JavaScript contract provider (JS projects without TypeScript get the "not implemented" empty graph — Stage 4).
- Deep module-graph resolution for Rust (following `mod` declarations in `lib.rs` to determine true public surface) — Stage 4.
- `build.rs` / proc-macro analysis — Stage 4.
- `[workspace.dependencies]` / shared dependency resolution — not needed for contract edges.
- Splitting the test file (`contract-extractor.test.ts`) — one test file is still manageable. Split when it isn't.

## Validation

```bash
docker compose build dev
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

Expected: typecheck + lint clean. Test count `496 passed / 2 skipped` → `501 passed / 2 skipped` (+5).

## Reporting back

When done, report:
1. Test count before → after
2. Files changed (list the new directory structure)
3. Commit SHA(s)
4. Deviations, especially:
   - Did `contract-extractor.ts` barrel re-export work without any call-site changes?
   - Did `bollard-extract-rs` emit `pub(crate)` items, or does the helper already filter them?
   - Did the hyphen/underscore normalization work as described, or was a different approach needed?
   - Any Biome lint issues with the new file structure (import ordering, etc.)?
