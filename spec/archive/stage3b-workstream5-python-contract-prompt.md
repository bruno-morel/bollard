# Stage 3b — Workstream 5: Python contract graph provider

> **Scope:** implement `PythonContractProvider` inside `packages/verify/src/contract-extractor.ts`, register it in the `PROVIDERS` map, and add tests. This is the first non-TypeScript contract graph — it transforms `buildContractContext` from "TypeScript-only" to "TypeScript + Python." Go (WS6) and Rust (WS7) follow the same pattern.

## Design rationale

The Python contract graph answers the same question as the TypeScript one: "what public symbols does each package export, and which packages import which?" The inputs are different (no `pnpm-workspace.yaml`, no `package.json`, no TS Compiler API) but the output shape is identical: `ContractContext { modules: ModuleNode[], edges: ContractEdge[], affectedEdges: ContractEdge[] }`.

Python monorepo layouts vary widely. Stage 3b targets the two most common patterns:

1. **Multi-package repo with pyproject.toml per package** — e.g. a `packages/` directory where each subdirectory has its own `pyproject.toml` with `[project] name = "..."`. This mirrors the pnpm-workspace model.
2. **Single-package repo with subpackages** — e.g. a root `pyproject.toml` listing `[tool.setuptools.packages.find]` or `[tool.poetry.packages]`, where each top-level Python package directory has an `__init__.py`. Edges are between subpackages.

Both patterns use the same public-surface rule: a Python package's public API is defined by its `__init__.py`. Specifically:

- If `__init__.py` defines `__all__`, that list is the package's public surface (explicit override).
- If `__init__.py` does not define `__all__`, everything imported or defined at the top level of `__init__.py` is public.
- The public surface is the `__init__.py` re-export closure: follow `from .submodule import ...` chains recursively, same concept as `collectPublicExportClosure` for TypeScript.

## Files to change

### 1. `packages/verify/src/contract-extractor.ts` — add `PythonContractProvider`

Add the provider class below `TypeScriptContractProvider` in the same file. Register it in `PROVIDERS`:

```typescript
const PROVIDERS: Partial<Record<LanguageId, ContractGraphProvider>> = {
  typescript: new TypeScriptContractProvider(),
  python: new PythonContractProvider(),
}
```

The provider needs these internal helpers (all private to the module, not exported):

#### a. Python package discovery

```
discoverPythonPackages(workDir: string): Promise<Map<string, string>>
```

Returns `Map<packageId, packageRootDir>`, same shape as `readWorkspacePackageRoots` for TS.

Discovery order:

1. **Scan for nested `pyproject.toml` files** — walk first-level and second-level subdirectories of `workDir` looking for `pyproject.toml`. For each found, read `[project] name = "..."` (PEP 621) or `[tool.poetry] name = "..."`. The value is the package ID, the directory is the root. Skip the root `pyproject.toml` in this pass (it's the workspace root, not a package).
2. **Fallback: root `pyproject.toml` with subpackages** — if step 1 found zero packages and a root `pyproject.toml` exists, look for directories under `workDir` that contain `__init__.py` (skipping `tests/`, `test/`, `.venv/`, `venv/`, `__pycache__/`, `.git/`). Each such directory is a package, with the directory name as the package ID.
3. **Bail** — if both steps found zero packages, return empty map + warn.

TOML parsing: do **not** add a `toml` dependency. Use a minimal line-by-line regex parser that extracts `name = "..."` after a `[project]` or `[tool.poetry]` section header. This is fragile for edge cases (multiline strings, inline tables) but covers 95%+ of real-world `pyproject.toml` files. A proper TOML parser is Stage 4 polish.

#### b. Public surface closure from `__init__.py`

```
collectPythonPublicSurface(packageRoot: string): Promise<Set<string>>
```

Returns the set of `.py` file paths that contribute to the package's public surface.

Logic:

1. Find `__init__.py` in `packageRoot` (or `packageRoot/src/<pkgname>/__init__.py` for src-layout projects — check both).
2. Parse `__init__.py` with the Python AST extractor? No — we don't need signatures here, just the import structure. Instead, read the file as text and:
   - Look for `__all__ = [...]` — if found, extract the listed names. Map each name to the file that defines it by walking the `from .submodule import name` statements. Those files are in the public surface.
   - If no `__all__`, collect every `from .submodule import ...` target. The target files + `__init__.py` itself are the public surface.
3. Recurse: for each submodule `__init__.py` reachable via step 2, repeat the process (same pattern as `collectPublicExportClosure` for TS).

The recursion is bounded by the file tree. Cycle-break on `seen` set, same as the TS version.

Return the set of absolute `.py` file paths. Files outside this set are package internals.

Implementation note: Python's relative import syntax (`from . import foo`, `from .bar import baz`) resolves relative to the file's containing package. Resolve `.` to `dirname(__init__.py)`, `..` to the parent package, etc. For Stage 3b, supporting single-dot relative imports (`.submodule`) is sufficient; multi-dot (`..parent`) is a nice-to-have but not required. Log a warning if encountered and skip.

#### c. Python import edge extraction

```
parsePythonImports(filePath: string, fileContent: string): { spec: string; names: string[] }[]
```

Regex-based (no AST needed for import extraction — Python imports have a simple grammar):

- `import <spec>` → `{ spec, names: [spec.split(".").pop()] }`
- `from <spec> import <name1>, <name2>` → `{ spec, names: [name1, name2] }`
- Skip relative imports (they're intra-package, not cross-package edges).

Only collect imports where `spec` matches a known package ID from the discovery step. This is the same filter the TS provider applies via `workspacePackageIdFromImportSpec`.

#### d. Signature extraction

Reuse `PythonAstExtractor` for signatures, same as the TS provider uses `TsCompilerExtractor`. Instantiate one inside the `build()` method. Filter by public surface before returning.

#### e. Putting it together: `PythonContractProvider.build()`

```
1. packages = await discoverPythonPackages(workDir)
2. if packages.size === 0 → return empty + warn
3. for each (id, root) of packages:
   a. files = list all .py files under root (skip tests/, __pycache__/, .venv/)
   b. surface = await collectPythonPublicSurface(root)
   c. extractor = new PythonAstExtractor(warn)
   d. result = await extractor.extract(files, profile, workDir)
   e. signatures = filterByPublicSurface(result.signatures, surface)
   f. types = filterByPublicSurface(result.types, surface)
   g. errorTypes = types.filter(t => t.name.endsWith("Error")).map(t => t.name)
   h. modules.push({ id, language: "python", rootPath: root, publicExports: signatures, errorTypes })
4. Build edges:
   a. for each (id, root) of packages:
      for each .py file in root:
        imports = parsePythonImports(file, content)
        for each import where spec matches a known package ID:
          upsert edge { from: id, to: targetId, importedSymbols: [...names] }
5. affectedEdges = edges where from or to is in the touched set (same logic as TS)
6. return { modules, edges, affectedEdges }
```

### 2. `packages/verify/tests/contract-extractor.test.ts` — add Python provider tests

Add a new `describe("PythonContractProvider")` block. Use temp-dir fixtures that create minimal Python package structures on disk.

Required cases (5 total):

1. **Multi-package workspace with cross-package import** — create two packages under `packages/`:
   ```
   packages/alpha/pyproject.toml   → [project] name = "alpha"
   packages/alpha/__init__.py      → from .core import greet
   packages/alpha/core.py          → def greet(name: str) -> str: ...
   packages/beta/pyproject.toml    → [project] name = "beta"
   packages/beta/__init__.py       → from .handler import handle
   packages/beta/handler.py        → import alpha\ndef handle(): return alpha.greet("world")
   ```
   Assert: 2 modules ("alpha", "beta"), 1 edge (beta → alpha, importedSymbols includes "alpha"), alpha's publicExports includes a signature for `greet`.

2. **`__all__` limits public surface** — single package with `__init__.py` containing `__all__ = ["public_fn"]` and `from .pub import public_fn` + `from .priv import private_fn`. Assert: only `public_fn` is in the module's `publicExports`. `private_fn` is defined in a `.py` file but excluded by the `__all__` filter.

3. **Empty workspace returns empty graph + warning** — point at an empty temp dir. Assert: `{ modules: [], edges: [], affectedEdges: [] }` and warn callback invoked.

4. **`affectedFiles` filters edges** — use the fixture from test 1 but pass `affectedFiles: ["packages/alpha/core.py"]`. Assert: `affectedEdges` includes the beta→alpha edge; an edge that doesn't touch alpha is not in `affectedEdges`.

5. **Fallback to `__init__.py` directories when no nested pyproject.toml** — create a root `pyproject.toml` and two sibling directories with `__init__.py`:
   ```
   pyproject.toml                  → [project] name = "myapp"
   auth/__init__.py                → def login(): ...
   billing/__init__.py             → import auth\ndef charge(): ...
   ```
   Assert: 2 modules ("auth", "billing"), 1 edge (billing → auth).

### 3. `CLAUDE.md`

- **"Known limitations"** — update the `buildContractContext` bullet: change "TypeScript / pnpm-workspace monorepos" to "TypeScript and Python". Keep the "other languages return an empty graph with a warning" qualifier.
- **Test count** — bump to whatever `docker compose run --rm dev run test` reports. Expect 486 → 491 (+5 from the Python provider tests).
- **File tree comment** — if `contract-extractor.ts` still has a comment saying "TS workspace graph" or similar, update it to "TS + Python workspace graph" or similar.

## Out of scope

- Go contract graph — workstream 6.
- Rust contract graph — workstream 7.
- Proper TOML parsing — Stage 4 (add a `toml` dep or lightweight TOML parser when edge cases bite).
- Multi-dot relative imports (`from ..parent import ...`) — warn and skip. Single-dot only for Stage 3b.
- `src/` layout detection (e.g. `packages/alpha/src/alpha/__init__.py`) — check both patterns (flat and src-layout), but don't over-engineer. If neither pattern yields an `__init__.py`, skip the package with a warning.
- `setup.py` / `setup.cfg` parsing — only `pyproject.toml` for Stage 3b. Legacy projects that have only `setup.py` will get zero packages and fall through to the `__init__.py` directory fallback.
- Splitting `contract-extractor.ts` into multiple files — one file still holds all providers. Split is WS7 or later.

## Validation

```bash
docker compose build dev
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

Expected: typecheck + lint clean. Test count `486 passed / 2 skipped` → `491 passed / 2 skipped` (+5). The 2 skipped are LLM live smoke tests.

## Commit

One commit, one logical change:

```
Stage 3b: add PythonContractProvider to buildContractContext

- Discover packages via nested pyproject.toml or __init__.py fallback
- Public surface from __init__.py re-export closure + __all__ override
- Cross-package edge extraction from import statements
- Register in PROVIDERS map; Python projects now get contract graphs
- 5 tests: multi-pkg workspace, __all__ filter, empty workspace,
  affectedFiles filtering, __init__.py fallback discovery
- Update CLAUDE.md known limitations + test count
```

## Out of scope reminder (for the coder)

This is the first non-TypeScript contract graph. Resist the urge to generalize. Every helper added in this workstream should be Python-specific and private to the module. The only shared surface is the `ContractGraphProvider` interface and the `PROVIDERS` map from workstream 4. If Go or Rust turn out to need a similar helper (e.g. package discovery), refactor then — not now.

## Reporting back

When done, report:
1. Test count before → after
2. Files changed
3. Commit SHA
4. Any deviations from the prompt, especially:
   - Did the TOML regex parser work for the test fixtures, or did you need a different approach?
   - Did `PythonAstExtractor` emit signatures in the expected shape when called from the provider?
   - How did you handle the `__all__` extraction — AST parse of `__init__.py`, or regex?
   - Did you hit any `filterByPublicSurface` issues (the function takes `{ filePath: string }` — did the Python extractor emit `filePath` in the right format)?
