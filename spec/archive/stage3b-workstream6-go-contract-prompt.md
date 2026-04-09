# Stage 3b — Workstream 6: Go contract graph provider

> **Scope:** implement `GoContractProvider` inside `packages/verify/src/contract-extractor.ts`, register it in `PROVIDERS`, and add tests. Mirrors the workstream 5 pattern: workspace discovery → public surface → signature extraction → edge extraction → `ContractContext`.

## Design rationale

Go's module and package system is more uniform than Python's, which makes the provider simpler:

- **Workspace discovery:** `go.work` defines a multi-module workspace (Go 1.18+). Each `use` directive points at a module directory containing `go.mod`. For single-module repos (no `go.work`), the root `go.mod` itself is the sole module.
- **Public surface:** Go's visibility rule is capitalization — exported identifiers start with an uppercase letter. The `bollard-extract-go` helper already filters for exported-only symbols. The contract provider doesn't need an `__init__.py`-style closure; it just trusts the helper's output. However, the provider should filter to non-test files and non-internal packages (`internal/` directories are package-private in Go).
- **Import edges:** Go imports are explicit `import "module/path/package"` statements. Cross-module edges are imports where the module path prefix matches a known module from the workspace.

## Files to change

### 1. `packages/verify/src/contract-extractor.ts` — add `GoContractProvider`

Add the provider class after `PythonContractProvider`. Register it in `PROVIDERS`:

```typescript
const PROVIDERS: Partial<Record<LanguageId, ContractGraphProvider>> = {
  typescript: new TypeScriptContractProvider(),
  python: new PythonContractProvider(),
  go: new GoContractProvider(),
}
```

Internal helpers needed (all private to the module):

#### a. Go module discovery

```
discoverGoModules(workDir: string): Promise<Map<string, string>>
```

Returns `Map<modulePath, moduleRootDir>` where `modulePath` is the module path from `go.mod` (e.g. `github.com/user/project/services/auth`).

Discovery:

1. **Check for `go.work`** in `workDir`. If found, parse `use` directives:
   ```
   use (
       ./services/auth
       ./services/billing
       ./pkg/shared
   )
   ```
   or single-line `use ./services/auth`. For each `use` path, resolve to absolute, then read `go.mod` in that directory to get the module path from the `module` directive.

2. **Fallback: root `go.mod`** — if no `go.work`, read `go.mod` in `workDir`. This gives a single-module workspace. The module path comes from the `module` directive.

3. **Bail** — if neither exists, return empty map + warn.

Parsing: `go.mod` and `go.work` have simple line-oriented grammars. No dependency needed:
- `go.mod`: first non-comment line matching `module <path>` gives the module path.
- `go.work`: lines matching `use <path>` or inside a `use (...)` block give module directories.

#### b. Go package listing

```
listGoPackages(moduleRoot: string): Promise<{ dir: string; files: string[] }[]>
```

Walk `moduleRoot` looking for directories containing `.go` files (excluding `*_test.go`, `vendor/`, `testdata/`, and `internal/` subtrees). Each such directory is a Go package. Return the directory path and the list of non-test `.go` files in it.

**Why exclude `internal/`:** Go enforces that `internal/` packages are only importable by code within the parent of `internal/`. They are not part of the module's public contract surface — same conceptual role as the TypeScript re-export closure and the Python `__all__` filter.

#### c. Go import edge extraction

```
parseGoImports(fileContent: string): string[]
```

Regex-based extraction of import paths from Go source:

- Single import: `import "path/to/pkg"` → `["path/to/pkg"]`
- Grouped import:
  ```go
  import (
      "fmt"
      "path/to/pkg"
      alias "other/pkg"
  )
  ```
  → `["fmt", "path/to/pkg", "other/pkg"]`

Strip aliases (named imports), blank identifiers (`_`), and dot imports (`.`). Only collect imports whose path prefix matches a known module path from the discovery step — these are the cross-module edges.

Matching rule: import path `P` belongs to module `M` if `P === M` or `P.startsWith(M + "/")`. This handles subpackage imports like `github.com/user/project/services/auth/middleware` belonging to module `github.com/user/project/services/auth`.

#### d. Signature extraction

Reuse `GoAstExtractor` (from workstream 2). Instantiate one inside `build()`. The helper already filters to exported symbols only — the provider just needs to exclude `internal/` and test files before passing paths to the extractor.

#### e. Putting it together: `GoContractProvider.build()`

```
1. modules = await discoverGoModules(workDir)
2. if modules.size === 0 → return empty + warn
3. for each (modulePath, moduleRoot) of modules:
   a. packages = await listGoPackages(moduleRoot)
   b. allFiles = packages.flatMap(p => p.files)
   c. extractor = new GoAstExtractor(warn)
   d. result = await extractor.extract(allFiles, profile, workDir)
   e. errorTypes = result.types.filter(t => t.name.endsWith("Error")).map(t => t.name)
   f. modules.push({
        id: modulePath,
        language: "go",
        rootPath: moduleRoot,
        publicExports: result.signatures,
        errorTypes
      })
4. Build edges:
   a. for each (modulePath, moduleRoot) of modules:
      for each .go file (non-test, non-internal):
        imports = parseGoImports(fileContent)
        for each import where path prefix matches a known module:
          upsert edge { from: modulePath, to: targetModulePath, importedSymbols: [] }
   b. Note: Go imports reference packages, not individual symbols — so
      `importedSymbols` will contain the package-level import name (last
      segment of the import path), not individual function names. This is
      less granular than TypeScript/Python but accurate to Go's semantics.
5. affectedEdges = edges where from or to is in the touched set
6. return { modules, edges, affectedEdges }
```

**`importedSymbols` granularity note:** TypeScript and Python import individual symbols (`import { foo } from "pkg"`, `from pkg import foo`), so their edges list specific names. Go imports entire packages (`import "module/pkg"`), so listing individual consumed symbols would require full AST analysis of usage sites — out of scope for Stage 3b. Instead, `importedSymbols` contains the package name (last path segment, e.g. `"auth"` for `import "github.com/user/project/services/auth"`). The contract-tester agent already handles varying granularity in its prompt.

### 2. `packages/verify/tests/contract-extractor.test.ts` — add Go provider tests

Add a `describe("GoContractProvider")` block. Use temp-dir fixtures.

Required cases (5 total):

1. **Multi-module workspace via go.work** — create:
   ```
   go.work          → use ( ./svc/auth  ./svc/billing )
   svc/auth/go.mod  → module example.com/myapp/svc/auth
   svc/auth/auth.go → package auth\nfunc Login(user string) error { return nil }
   svc/billing/go.mod     → module example.com/myapp/svc/billing
   svc/billing/billing.go → package billing\nimport "example.com/myapp/svc/auth"\nfunc Charge() { auth.Login("x") }
   ```
   Assert: 2 modules (`example.com/myapp/svc/auth`, `example.com/myapp/svc/billing`), 1 edge (billing → auth), auth's publicExports includes a signature for `Login`.

2. **Single-module fallback (no go.work)** — create:
   ```
   go.mod     → module example.com/mylib
   mylib.go   → package mylib\nfunc Hello() string { return "hi" }
   ```
   Assert: 1 module, 0 edges, module's publicExports includes `Hello`.

3. **`internal/` excluded from public surface** — create:
   ```
   go.mod            → module example.com/myapp
   api/handler.go    → package api\nfunc Handle() {}
   internal/secret.go → package secret\nfunc Hidden() {}
   ```
   Assert: module's publicExports includes `Handle` but does NOT include `Hidden`. No `internal/` files in the extraction input.

4. **Empty workspace returns empty graph + warning** — point at an empty temp dir. Assert: empty `ContractContext` and warn invoked.

5. **`affectedFiles` filters edges** — use fixture from test 1, pass `affectedFiles: ["svc/auth/auth.go"]`. Assert: `affectedEdges` includes the billing→auth edge.

### 3. `CLAUDE.md`

- **"Known limitations"** — update `buildContractContext` bullet: "TypeScript and Python" → "TypeScript, Python, and Go".
- **Test count** — bump to whatever `docker compose run --rm dev run test` reports. Expect 491 → 496 (+5).
- **File tree comment** — update to "TS + Python + Go workspace graph" or similar.

## Out of scope

- Rust contract graph — workstream 7.
- Symbol-level `importedSymbols` for Go (would require full usage-site analysis) — Stage 4 candidate.
- `vendor/` directory handling (Go vendor mode) — skip `vendor/` in package listing, don't resolve vendored imports.
- `go.sum` parsing — not needed for contract graph.
- `replace` directives in `go.mod` — Stage 4. For now, only `module` and `use` directives are parsed.
- Splitting `contract-extractor.ts` into multiple files — still one file, split at WS7 or later if it gets unwieldy.

## Validation

```bash
docker compose build dev
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

Expected: typecheck + lint clean. Test count `491 passed / 2 skipped` → `496 passed / 2 skipped` (+5). The 2 skipped are LLM live smoke tests.

## Commit

One commit, one logical change:

```
Stage 3b: add GoContractProvider to buildContractContext

- Discover modules via go.work (multi-module) or root go.mod (single)
- Exclude internal/ packages from public surface
- Cross-module edge extraction from import statements
- Package-level importedSymbols (Go imports packages, not symbols)
- Register in PROVIDERS map; Go projects now get contract graphs
- 5 tests: go.work workspace, single-module, internal/ exclusion,
  empty workspace, affectedFiles filtering
- Update CLAUDE.md known limitations + test count
```

## Reporting back

When done, report:
1. Test count before → after
2. Files changed
3. Commit SHA
4. Any deviations from the prompt, especially:
   - Did the `go.work` / `go.mod` line-based parsing work for the fixtures?
   - Did `GoAstExtractor` work when invoked from the provider, or did it need `cwd` adjustments?
   - How did `internal/` exclusion interact with the extractor's own `filterUnderWorkDir`?
   - Did you need to handle the `go.work` `use` directive with or without the parenthesized block syntax?
