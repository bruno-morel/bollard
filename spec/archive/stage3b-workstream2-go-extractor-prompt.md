# Stage 3b — Workstream 2: Go Extractor Rewrite

> Cursor/Claude Code prompt. Replaces the shallow `go doc` dump in `packages/verify/src/extractors/go.ts` with a real deterministic extractor that shells out to the `bollard-extract-go` helper built in workstream 1. One TypeScript file rewrite, new unit tests, no Docker changes.
>
> **Scope:** `packages/verify/src/extractors/go.ts` and its tests. Nothing else. The helper binary (`scripts/extract_go/`) already exists and is on PATH in both `dev` and `dev-full` — do not touch it. The Rust extractor rewrite is workstream 3. The Go *contract graph* (`buildContractContext` for Go workspaces) is workstream 6.

## Source of truth

Read these BEFORE writing any code:
- `CLAUDE.md` — "Known limitations" bullet on "Extractor rewrites pending", plus `Key Types > Agent types` and the Go/Rust extractor structure under "Project Structure"
- `packages/verify/src/extractors/python.ts` — **the template.** `GoAstExtractor` should be structurally near-identical: construct with a `warn` callback, `filterUnderWorkDir`, `execFile` the helper, parse the JSON shape, return `ExtractionResult`. Copy the pattern, adapt the binary name and script path constant.
- `packages/verify/src/extractors/go.ts` — what you're replacing. Keep the class name, constructor, method signature, and export shape intact so nothing downstream needs to re-import.
- `packages/verify/src/type-extractor.ts` — the `ExtractedSignature`, `ExtractedTypeDefinition`, `ExtractionResult`, and `SignatureExtractor` interfaces. The helper's JSON already matches these; you're just parsing and passing through.
- `scripts/extract_go/extract_test.go` — the helper's test fixtures show exactly what JSON you should expect for typical inputs. Use these as the mental model when writing the TypeScript tests.
- `packages/verify/tests/extractor-helpers.test.ts` — leave it unchanged. It tests the helper binary directly. Your new tests cover the `GoAstExtractor` TypeScript wrapper.

When in doubt, the Python extractor wins. If this prompt disagrees with how `python.ts` does something, follow `python.ts`.

## Non-negotiables

- Run **everything** through `docker compose run --rm dev …` — never bare `pnpm`/`node`/`tsc`/`vitest`/`biome` on the host.
- TypeScript strict mode, `exactOptionalPropertyTypes`, no `any`, named exports only, no semicolons (Biome).
- No new runtime dependencies. The only imports needed are `node:child_process`, `node:path`, `node:util`, and types from `@bollard/detect/src/types.js` and `../type-extractor.js`.
- No `BollardError` for recoverable extractor failures — match the Python extractor's posture: on any failure (helper missing, parse error, non-zero exit), call `warn(...)` and return `{ signatures: [], types: [] }`. Extraction is best-effort; downstream nodes degrade gracefully.
- Path-traversal protection via `filterUnderWorkDir`, copied verbatim from the Python extractor.
- Tests for every public method. Use real temp directories with real Go source fixtures. `MockProvider` is not needed — this extractor doesn't touch an LLM.

## Goal

After this pass:

1. `GoAstExtractor` in `packages/verify/src/extractors/go.ts` shells out to `bollard-extract-go` (absolute path: `/usr/local/bin/bollard-extract-go`, or just the binary name — it's on PATH), passes the sanitized file paths as argv, parses the JSON on stdout, and returns a real `ExtractionResult` with per-file `ExtractedSignature[]` and resolved `ExtractedTypeDefinition[]`.
2. The `profile?.allowedCommands.includes("go")` gate is **removed**. The helper is the contract now, not the Go toolchain. `allowedCommands` is about what the coder agent is allowed to invoke at pipeline time, not about extractor availability.
3. The `go doc -all -short .` shell-out and all the stdout-slicing hacks are gone.
4. `getExtractor("go", …)` in `type-extractor.ts` continues to route to `GoAstExtractor` — this is already the case, verify no change needed.
5. New unit tests in `packages/verify/tests/type-extractor.test.ts` cover `GoAstExtractor` end-to-end against real Go fixtures, mirroring the existing `PythonAstExtractor` test cases.
6. The `TODO(workstream-2/3): replace with GoAstExtractor assertions once those classes shell out to the helpers` comment from workstream 1 is deleted (the one in `extractor-helpers.test.ts` — leave that test file's actual assertions intact, only remove the TODO marker if it's still there).
7. `CLAUDE.md` "Known limitations" → "Extractor rewrites pending" entry updated: Go struck through, Rust still pending workstream 3.

---

## Phase 1 — Rewrite `packages/verify/src/extractors/go.ts`

### 1.1 Target shape

Structurally mirror `packages/verify/src/extractors/python.ts`. Concretely:

```typescript
import { execFile } from "node:child_process"
import { relative, resolve } from "node:path"
import { promisify } from "node:util"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import type {
  ExtractedSignature,
  ExtractedTypeDefinition,
  ExtractionResult,
  SignatureExtractor,
} from "../type-extractor.js"

const execFileAsync = promisify(execFile)

const HELPER = "bollard-extract-go"

function filterUnderWorkDir(
  files: string[],
  workDir: string | undefined,
  warn?: (m: string) => void,
): string[] {
  // identical body to python.ts — copy verbatim
}

export class GoAstExtractor implements SignatureExtractor {
  constructor(private readonly warn?: (msg: string) => void) {}

  async extract(
    files: string[],
    _profile?: ToolchainProfile,
    workDir?: string,
  ): Promise<ExtractionResult> {
    const safe = filterUnderWorkDir(files, workDir, this.warn)
    if (safe.length === 0) return { signatures: [], types: [] }
    try {
      const { stdout } = await execFileAsync(HELPER, safe, {
        maxBuffer: 8 * 1024 * 1024,
        timeout: 60_000,
      })
      const parsed = JSON.parse(stdout) as {
        signatures?: ExtractedSignature[]
        types?: ExtractedTypeDefinition[]
        warnings?: string[]
      }
      if (parsed.warnings) {
        for (const w of parsed.warnings) this.warn?.(`GoAstExtractor: ${w}`)
      }
      return {
        signatures: parsed.signatures ?? [],
        types: parsed.types ?? [],
      }
    } catch (err) {
      this.warn?.(
        `GoAstExtractor: ${err instanceof Error ? err.message : String(err)} — is bollard-extract-go on PATH?`,
      )
      return { signatures: [], types: [] }
    }
  }
}
```

### 1.2 Things to delete

- The `dirname` import (no longer needed — we don't `cwd` the helper).
- The `profile?.allowedCommands.includes("go")` gate and its warn message.
- The `joined = safe.join("\n")` stdout-blob assembly — the helper returns per-file `ExtractedSignature[]` directly.
- The `stdout.slice(0, 50_000)` truncation — per-file JSON is already bounded by file count and each file's signature block.
- The file-level `TODO: richer parsing and same-module type resolution (Stage 3b)` comment — it's done now.
- Any `dirname(safe[0] ?? ".")` fallback — the helper accepts absolute paths and handles missing files gracefully.

### 1.3 Things to keep

- The class name `GoAstExtractor` (exported, unchanged) — `getExtractor` in `type-extractor.ts` imports this by name.
- The `constructor(private readonly warn?: (msg: string) => void)` signature — callers pass `ctx.log.warn`.
- `filterUnderWorkDir` as a module-local helper, copied verbatim from `python.ts`. Do not factor it into a shared module in this workstream — that's cross-cutting refactor churn for zero current value. (Workstream 3 will have the same duplication; a future pass can DRY it up.)
- The `ToolchainProfile` import so the unused `_profile` parameter type-checks under strict mode.

### 1.4 What to verify `getExtractor` does

Open `packages/verify/src/type-extractor.ts` and find `getExtractor`. Confirm:
- When called with `lang === "go"`, it returns `new GoAstExtractor(warn)`.
- It does NOT pass `profile` or check `allowedCommands` before routing.

If the current code has any `allowedCommands.includes("go")` check at the `getExtractor` level (rather than inside the extractor class), remove it. The extractor owns its availability contract now.

If the current code routes "go" to some other stub class (e.g. `GoDocExtractor`), rename to `GoAstExtractor` to match the file.

---

## Phase 2 — Update `packages/verify/tests/type-extractor.test.ts`

### 2.1 Find the template

Look at the existing `PythonAstExtractor` test cases (should be under a `describe("PythonAstExtractor", …)` block). Mirror them for Go.

### 2.2 New test block

Add a `describe("GoAstExtractor", …)` block with at least four tests. Each one creates a real temp directory via `mkdtemp`, writes Go source fixtures, runs the extractor, asserts on the result.

**Test 1: exported function only**

```go
// main.go
package main

func Add(a int, b int) int { return a + b }
func privateHelper() {}
```

Assert:
- `result.signatures.length === 1`
- `result.signatures[0].filePath` is the absolute path to `main.go`
- `result.signatures[0].signatures` contains `"Add"` and `"int"`
- `result.signatures[0].signatures` does **not** contain `"privateHelper"` (lowercase identifier, unexported)
- `result.types.length === 0`

**Test 2: exported struct, interface, and type alias**

```go
package sample

type User struct {
    ID   string
    Name string
}

type Reader interface {
    Read(p []byte) (int, error)
}

type ID = string
```

Assert:
- `result.signatures[0].signatures` mentions all three type headers
- `result.types.length === 3`
- There is one `ExtractedTypeDefinition` with `name: "User"` and `kind: "type"`
- There is one with `name: "Reader"` and `kind: "interface"`
- There is one with `name: "ID"` and `kind: "type"` (alias)
- Each `definition` string contains the full body (field types for `User`, method sigs for `Reader`)

**Test 3: file outside workDir is skipped with a warning**

- Create two temp dirs: `workDir` and `outside`.
- Write a valid `.go` file in each.
- Call the extractor with both paths and `workDir` set.
- Assert `warn` was called at least once with a message containing `"skipping path outside workDir"`.
- Assert the result contains exactly one signature (the one under `workDir`).

**Test 4: unparseable file → empty result, warning emitted**

- Write a file with garbage content like `this is not go code {{{`.
- Call the extractor.
- Assert it returns `{ signatures: [], types: [] }` for that file (or still returns an entry with empty content — whichever the helper actually does; match the helper's behavior, which you can verify by looking at `scripts/extract_go/extract_test.go` case 3).
- Assert `warn` was called with a message tagged `GoAstExtractor:`.
- Assert the extractor does **not** throw.

### 2.3 Existing tests

- If `type-extractor.test.ts` still has a Go test left over from the Stage 2 stub era that checks for `"go doc"` output or the `stdout.slice(0, 50_000)` blob, delete it.
- Keep all TypeScript / Python / Rust / TS compiler / LLM fallback tests untouched.
- Run the test file in isolation once as a sanity check: `docker compose run --rm dev exec vitest run packages/verify/tests/type-extractor.test.ts`.

### 2.4 `extractor-helpers.test.ts`

Leave the assertions alone. If there's a `// TODO(workstream-2/3):` comment in there pointing at this workstream, delete the comment — but only the comment, not the test body. The helper-direct tests remain valuable as a lower-level smoke check.

---

## Phase 3 — `CLAUDE.md` updates

1. **"Known limitations" section** — find the bullet:
   > *Extractor rewrites pending: Go and Rust extractor classes (`extractors/go.ts`, `extractors/rust.ts`) still contain the shallow Stage 2 stubs — workstreams 2–3 will wire them through the new `bollard-extract-go` / `bollard-extract-rs` helpers.*

   Update to:
   > *Extractor rewrite pending: the Rust extractor class (`extractors/rust.ts`) still contains the shallow Stage 2 stub — workstream 3 will wire it through the `bollard-extract-rs` helper. The Go extractor (`extractors/go.ts`) now shells out to `bollard-extract-go` (workstream 2, 2026-04-xx).*

2. **"Current Test Stats" section** — after running the full suite, update the authoritative count. Expected delta: +3 or +4 tests (the new `GoAstExtractor` describe block). No regressions.

3. **"Project Structure" section** — no change. The file paths haven't moved.

4. **"Stage 3a → Stage 3b follow-ups" section** — no change. Workstream 2 isn't on that list; it was implicit in the "Go / Rust in the dev image" follow-up which is already ✅.

---

## Phase 4 — Validation checklist

Run all of these from a clean checkout:

```bash
# Fast image still builds and the full suite passes
docker compose build dev
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test

# Targeted sanity check on the rewritten extractor
docker compose run --rm dev exec vitest run packages/verify/tests/type-extractor.test.ts
docker compose run --rm dev exec vitest run packages/verify/tests/extractor-helpers.test.ts

# Manual smoke check: extractor against a real fixture, without the TS wrapper
docker compose run --rm --entrypoint sh dev -c \
  'echo "package main
func Foo() int { return 1 }
type Bar struct { X int }" > /tmp/sample.go && bollard-extract-go /tmp/sample.go'
```

Expected outcomes:
- All typecheck / lint / test invocations exit 0.
- `packages/verify/tests/type-extractor.test.ts` runs clean — the new Go tests pass, the existing tests are untouched.
- `packages/verify/tests/extractor-helpers.test.ts` still passes — workstream 1's helper-direct tests should be unaffected.
- The manual helper invocation outputs JSON with `signatures` and `types` arrays, confirming the runtime contract the extractor depends on.
- Test count grows by +3 or +4 vs the workstream 1b baseline (476/2). No regressions.

## Commit plan

Land as **one commit** on `main`:

```
Stage 3b: Go extractor shells out to bollard-extract-go helper

- Rewrite GoAstExtractor to mirror PythonAstExtractor's pattern (execFile the helper, parse JSON, filter workDir, degrade gracefully)
- Drop the profile.allowedCommands.includes("go") gate — the helper is the contract, not the Go toolchain
- Remove the Stage 2 go-doc dump and stdout-slice workaround
- Add 4 GoAstExtractor tests in type-extractor.test.ts mirroring the existing Python tests
- CLAUDE.md: update Known limitations (Go done, Rust still pending workstream 3) and test count
```

Do **not** bundle workstream 3 (Rust) into this commit. They're separate for review clarity and because the Rust extractor will likely surface different edge cases.

## Open questions to flag if you hit them

1. If `getExtractor` currently has `allowedCommands` logic gating Go (unlikely based on CLAUDE.md, but possible), remove it and note it in the commit body. The extractor owns its availability contract.
2. If the helper's JSON shape has drifted since workstream 1 (shouldn't have — workstream 1 froze it), compare `scripts/extract_go/extract.go` output against `ExtractedSignature`/`ExtractedTypeDefinition` in `type-extractor.ts` and flag any mismatch before editing the TS. Do not silently coerce — if the shape is wrong, the fix belongs in the helper, not the extractor.
3. If any downstream consumer of `ExtractionResult` was depending on the old behavior of one giant `joined` filePath string (the Stage 2 hack), it will now get per-file entries and may break. Grep the repo for `ExtractedSignature.filePath` usages and eyeball them for assumptions that the path is a single-file-per-`\n` blob. Fix at the consumer, not the extractor.
4. If a fixture Go file in the new tests fails to "compile enough" for `go/parser` (syntactically valid but refers to unknown packages), that's fine — the helper uses `parser.ParseFile` not `go/types`, so unresolved imports don't matter. If the helper complains anyway, that's a workstream-1 helper bug to fix in the helper, not here.

When done, report: test count before → after, list of files changed, and the commit SHA. That's it.
