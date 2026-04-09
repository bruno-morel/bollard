# Stage 3b — Workstream 4: Generalize `buildContractContext` into per-language providers

> **Scope:** pure refactor of `packages/verify/src/contract-extractor.ts`. Extract a `ContractGraphProvider` interface, move the existing TypeScript logic into a `TypeScriptContractProvider`, and turn `buildContractContext` into a thin router that picks a provider based on `profile.language`. **No behavior change.** The TypeScript path must produce byte-identical `ContractContext` output before and after this change. Workstreams 5/6/7 (Python/Go/Rust contract graphs) will plug new providers into this seam — they are **not** part of this workstream.

## Why this is its own workstream

Right now every line in `contract-extractor.ts` is TypeScript-specific: `pnpm-workspace.yaml`, `package.json` `exports["."]`, `ts.createSourceFile`, `@scope/pkg` import specs, `TsCompilerExtractor`. If workstreams 5/6/7 land without a refactor first, each one has to either:

1. Fork `buildContractContext` into language-specific copies (duplicate the router logic four times), or
2. Bolt conditional branches onto the existing function (`if (profile.language === "python") { ... }`), which guarantees drift.

Neither is acceptable. The refactor is small, the seam is obvious, and doing it now means workstreams 5/6/7 reduce to "implement one provider and register it in the map." This workstream is the last code-only architectural change before the per-language graphs start.

## Files to change

### 1. `packages/verify/src/contract-extractor.ts` — refactor into router + provider

Target structure (all in the same file — do **not** split into multiple files yet; premature directory explosion):

```typescript
// Existing ModuleNode / ContractEdge / ContractContext exports stay verbatim.

export interface ContractGraphProvider {
  readonly language: LanguageId
  build(
    affectedFiles: string[],
    profile: ToolchainProfile,
    workDir: string,
    warn?: (msg: string) => void,
  ): Promise<ContractContext>
}

// All existing TypeScript helpers (resolveSpecifierToFile,
// resolvePackageDotExport, collectPublicExportClosure,
// publicSurfaceFilesForPackage, filterByPublicSurface,
// readWorkspacePackageRoots, packageForPath, listPackageSourceFiles,
// workspacePackageIdFromImportSpec, parseImportSpecs) become private
// module-level helpers used exclusively by TypeScriptContractProvider.
// Do NOT export them.

class TypeScriptContractProvider implements ContractGraphProvider {
  readonly language: LanguageId = "typescript"

  async build(
    affectedFiles: string[],
    profile: ToolchainProfile,
    workDir: string,
    warn?: (msg: string) => void,
  ): Promise<ContractContext> {
    // Body = the existing buildContractContext body minus the
    // `if (profile.language !== "typescript")` guard. The guard moves
    // to the router below.
  }
}

// Provider registry. Keyed by LanguageId so workstreams 5/6/7 can
// add entries without touching the router.
const PROVIDERS: Partial<Record<LanguageId, ContractGraphProvider>> = {
  typescript: new TypeScriptContractProvider(),
}

export async function buildContractContext(
  affectedFiles: string[],
  profile: ToolchainProfile,
  workDir: string,
  warn?: (msg: string) => void,
): Promise<ContractContext> {
  const provider = PROVIDERS[profile.language]
  if (!provider) {
    warn?.(
      `buildContractContext: ${profile.language} provider not implemented — returning empty graph`,
    )
    return { modules: [], edges: [], affectedEdges: [] }
  }
  return provider.build(affectedFiles, profile, workDir, warn)
}
```

**Non-negotiables:**

- `buildContractContext` keeps its exact current signature. Every call site (CLI `contract` command, MCP `bollard_contract` tool, `extract-contracts` blueprint node) must continue to work without edits.
- `ModuleNode`, `ContractEdge`, `ContractContext` stay exported from the same path with the same shape.
- `TypeScriptContractProvider` is **not** exported. Only the interface (`ContractGraphProvider`) and the router (`buildContractContext`) cross the module boundary. Future providers register themselves inside the file by mutating `PROVIDERS`, not by importing the class.
- The existing warning text for non-TypeScript languages changes slightly (`not implemented in Stage 3a` → `provider not implemented`) — that's fine, it's not load-bearing. If any test asserts on the exact string, update the test assertion rather than preserving the old wording.
- `PROVIDERS` is typed as `Partial<Record<LanguageId, ContractGraphProvider>>`, not `Record<...>`. This keeps the type honest — unimplemented languages return `undefined` from the lookup, which is the router's fail-closed signal.

**Do not:**

- Split the file into `contract-extractor/router.ts` + `contract-extractor/typescript.ts`. One file stays one file. Workstream 5 or later can split if the TypeScript provider grows past ~500 LOC.
- Move the helpers into a shared `contract-extractor/helpers.ts` — they're TypeScript-specific. When workstream 5 (Python) lands, its helpers will be Python-specific and will live next to its provider.
- Export `TypeScriptContractProvider`. The registry is the API.
- Change any logic inside the moved helpers. This is a mechanical move, not a rewrite.

### 2. `packages/verify/tests/contract-extractor.test.ts` — add 2 router tests

Current tests all exercise the TypeScript happy path. Keep them — they now implicitly test the router + provider composition. Add two new targeted router tests:

1. **Unknown language returns empty graph + warning** — build a fake `ToolchainProfile` with `language: "ruby"` (or any language that's in `LanguageId` but not in `PROVIDERS`). Call `buildContractContext([], profile, workDir, warn)`. Assert the result is `{ modules: [], edges: [], affectedEdges: [] }` and the warn callback was invoked with a message containing `"ruby"` and `"provider not implemented"`.
2. **TypeScript language routes to the provider** — build a minimal TS workspace fixture (one package with one exported symbol) and call `buildContractContext`. Assert at least one module is returned with `language: "typescript"`. This is a smoke test that the router-provider composition doesn't drop output.

The existing tests that cover the real TypeScript pipeline (information-barrier regression, re-export closure, workspace discovery, etc.) already provide deep coverage — do not duplicate them at the router level.

### 3. Nothing else

- No CLAUDE.md update. The architecture description already says "buildContractContext is TypeScript-only in Stage 3a"; that remains true. CLAUDE.md gets updated in workstream 5 when the first non-TypeScript provider lands.
- No blueprint change. `extract-contracts` still calls `buildContractContext` with the same args.
- No CLI change. `bollard contract` still calls `buildContractContext`.
- No MCP change. `bollard_contract` still calls `buildContractContext`.
- No `type-extractor.ts` change. Signature extraction is orthogonal to contract graph building — workstream 2 and 3 already sorted that layer.

## Validation

```bash
docker compose build dev
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

Expected: typecheck + lint clean. Test count `484 passed / 2 skipped` → `486 passed / 2 skipped` (+2 router tests). The 2 skipped are still the LLM live smoke tests.

**Byte-identical output check (manual, one-time):** before committing, run `bollard contract` on the Bollard repo itself both before the refactor (from `main`) and after (from your branch), and `diff` the JSON outputs. They must match exactly. If they don't, the refactor introduced drift — fix it before committing. This is a throwaway check; do not script it or commit the outputs.

```bash
# On main
docker compose run --rm dev --filter @bollard/cli run start -- contract > /tmp/contract-before.json
# On branch
docker compose run --rm dev --filter @bollard/cli run start -- contract > /tmp/contract-after.json
diff /tmp/contract-before.json /tmp/contract-after.json
# Expect: empty diff.
```

## Commit

One commit, one logical change:

```
Stage 3b: refactor buildContractContext into ContractGraphProvider

- Extract ContractGraphProvider interface
- Move existing TS logic into private TypeScriptContractProvider
- buildContractContext becomes a thin router over PROVIDERS map
- Add 2 router tests (unknown language → empty graph, TS → provider)

No behavior change. Byte-identical output verified against main
via `bollard contract` diff. Workstreams 5/6/7 will register
Python/Go/Rust providers against this seam.
```

## Out of scope

- Python, Go, Rust contract graph implementations — workstreams 5, 6, 7.
- Splitting the file across multiple modules.
- Changing any existing helper logic.
- Updating CLAUDE.md (wait for workstream 5).
- Removing the `affectedEdges` field or any part of the `ContractContext` shape.

## Reporting back

When done, report:
1. Test count before → after
2. Files changed
3. Commit SHA
4. Byte-identical check result (`diff /tmp/contract-before.json /tmp/contract-after.json` — expect empty)
5. Any deviation from the prompt, especially if you had to export `TypeScriptContractProvider` or any helper to make the tests work (if so, explain why — the registry-is-the-API rule matters)
