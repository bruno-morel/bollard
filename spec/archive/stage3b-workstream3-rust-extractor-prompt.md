# Stage 3b — Workstream 3: Rust extractor rewrite

> **Scope:** rewrite `packages/verify/src/extractors/rust.ts` to shell out to the `bollard-extract-rs` helper binary built in workstream 1, mirroring the workstream 2 Go extractor exactly. **Code only.** ADR-0002 (the "why `syn` over `rustc --emit=metadata`" decision record) is workstream 3b — do not write it as part of this change.

## Context

Workstream 1 already builds a `bollard-extract-rs` static binary into the `dev` image (multi-stage Dockerfile, `rust-helper-builder` stage). The helper takes Rust source paths as positional args and emits `{signatures, types, warnings?}` JSON on stdout, same shape as `bollard-extract-go` and `extract_python.py`.

The current `packages/verify/src/extractors/rust.ts` is a regex stub that matches `pub fn|struct|enum|trait|type` and emits generic stubs without generics, parameter types, return types, or lifetimes. It must be replaced.

The workstream 2 Go extractor (`packages/verify/src/extractors/go.ts`) is the canonical pattern — copy its structure exactly, including the `cwd` handling and the TODO about common-ancestor pathing.

## Files to change

### 1. `packages/verify/src/extractors/rust.ts` — full rewrite

Replace the entire file with a `RustSynExtractor` class that mirrors `GoAstExtractor`:

```typescript
import { execFile } from "node:child_process"
import { dirname, relative, resolve } from "node:path"
import { promisify } from "node:util"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import type {
  ExtractedSignature,
  ExtractedTypeDefinition,
  ExtractionResult,
  SignatureExtractor,
} from "../type-extractor.js"

const execFileAsync = promisify(execFile)

const HELPER = "bollard-extract-rs"

function filterUnderWorkDir(
  files: string[],
  workDir: string | undefined,
  warn?: (m: string) => void,
): string[] {
  if (!workDir) return files
  const root = resolve(workDir)
  const out: string[] = []
  for (const f of files) {
    const abs = resolve(f)
    const rel = relative(root, abs)
    if (rel.startsWith("..")) {
      warn?.(`RustSynExtractor: skipping path outside workDir: ${f}`)
      continue
    }
    out.push(abs)
  }
  return out
}

export class RustSynExtractor implements SignatureExtractor {
  constructor(private readonly warn?: (msg: string) => void) {}

  async extract(
    files: string[],
    _profile?: ToolchainProfile,
    workDir?: string,
  ): Promise<ExtractionResult> {
    const safe = filterUnderWorkDir(files, workDir, this.warn)
    if (safe.length === 0) return { signatures: [], types: [] }
    try {
      // Mirror the Go extractor: the helper resolves caller-relative paths
      // against its own getcwd(), so launch it with cwd === workDir. The
      // dirname(first) fallback only works when all files share a parent.
      // TODO(stage-3b): assert workDir is always set, or compute a common
      // ancestor across `safe` instead of leaning on safe[0].
      const first = safe[0]
      const cwd = workDir ? resolve(workDir) : dirname(first ?? ".")
      const { stdout } = await execFileAsync(HELPER, safe, {
        cwd,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 60_000,
      })
      const parsed = JSON.parse(stdout) as {
        signatures?: ExtractedSignature[]
        types?: ExtractedTypeDefinition[]
        warnings?: string[]
      }
      if (parsed.warnings) {
        for (const w of parsed.warnings) this.warn?.(`RustSynExtractor: ${w}`)
      }
      return {
        signatures: parsed.signatures ?? [],
        types: parsed.types ?? [],
      }
    } catch (err) {
      this.warn?.(
        `RustSynExtractor: ${err instanceof Error ? err.message : String(err)} — is bollard-extract-rs on PATH?`,
      )
      return { signatures: [], types: [] }
    }
  }
}
```

**Drop entirely:**
- Any `profile?.allowedCommands.includes("rustc")` / `"cargo"` gate (the helper is on PATH in `dev`, no whitelist needed).
- The regex matchers for `pub fn|struct|enum|trait|type`.
- Any stdout truncation hacks.
- Any `safe.join(...)` whole-corpus tricks.

### 2. `packages/verify/tests/type-extractor.test.ts` — add 4 `RustSynExtractor` tests

Mirror the workstream 2 Go test block. Use a temp dir per test, write small Rust fixtures, instantiate `new RustSynExtractor(warn)`, assert on the structured output.

Required cases:

1. **Exported function only** — `pub fn add(a: i32, b: i32) -> i32 { a + b }` plus a private `fn helper()`. Assert one signature returned with name `add`, parameter types and return type populated. Private function is **not** in the output.
2. **Struct / enum / trait / type-alias extraction** — one file containing one of each (`pub struct Foo { ... }`, `pub enum Bar { ... }`, `pub trait Baz { ... }`, `pub type Qux = ...`). Assert four `types` entries with the expected `kind` and non-empty `definition` fields.
3. **`workDir` filtering** — pass one file inside `workDir` and one outside. Assert the outside file triggers a `RustSynExtractor: skipping path outside workDir:` warn and is excluded from the helper invocation.
4. **Graceful degradation on unparseable input** — write a `.rs` file with deliberately broken syntax (e.g. `pub fn (((`), assert the extractor returns `{signatures: [], types: []}` and the warn callback is invoked at least once. Do not assert the exact error message — the helper's error text may evolve.

If `bollard-extract-rs` is not on PATH (i.e. someone runs the suite outside the `dev` image), the tests will fall through to graceful degradation in case 4 and fail cases 1–3. That's acceptable — the suite is expected to run in `dev`. Do **not** add `it.skipIf` guards; workstream 1 made the helper unconditional.

### 3. `packages/verify/tests/extractor-helpers.test.ts`

Remove the `TODO(workstream-3)` comment that workstream 1 left next to the Rust helper smoke test. The Rust extractor is now wired up; the helper test alone is no longer the only Rust coverage.

### 4. `CLAUDE.md`

- "Known limitations" — drop the Rust line entirely (Go was dropped in workstream 2; Rust matches it now). The remaining extractor caveat is just "Unknown languages still need an LLM provider for signature extraction."
- "Stage 3a → Stage 3b follow-ups" table — mark the Rust extractor row as Done (workstream 3) the same way workstream 2 marked Go.
- Test count line — bump to whatever `docker compose run --rm dev run test` reports after the change. Current floor is 480/2 from workstream 2; expect +4 from the new `RustSynExtractor` tests.
- File tree — `extractors/rust.ts` is already listed; no path change. If the comment next to it still says "shallow Stage 2 stub", update it to match the new implementation.

## Out of scope

- **The helper itself** (`scripts/extract_rs/`). Workstream 1 built it. Do not touch `Cargo.toml`, `src/main.rs`, or `src/extract.rs`.
- **ADR-0002**. That's workstream 3b. The decision rationale (`syn` vs `rustc --emit=metadata`, MSRV vs lock, helper distribution model) is not part of this change.
- **Rust contract graph** (`buildContractContext` for Cargo workspaces). That's workstream 7.
- **The Go extractor**. Workstream 2 is done.
- **Adding Rust to `dev-full`**. Already there from workstream 1.

## Validation

```bash
docker compose build dev
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

Expected: typecheck + lint clean. Test count `480 passed / 2 skipped` → `484 passed / 2 skipped` (+4, no regressions). The 2 skipped are the LLM live smoke tests (no key in CI).

Sanity check the new extractor end-to-end against a real Rust file inside the repo if you have one handy — otherwise the unit tests are sufficient.

## Commit

One commit, one logical change:

```
Stage 3b: rewrite Rust extractor to shell out to bollard-extract-rs

- Replace regex stub with RustSynExtractor mirroring GoAstExtractor
- Drop allowedCommands gate; helper is unconditional in dev image
- Add 4 type-extractor.test.ts cases (fn, struct/enum/trait/alias,
  workDir filter, unparseable input)
- Update CLAUDE.md known limitations + test count + follow-up table
```

## Reporting back

When done, report:
1. Test count before → after
2. Files changed
3. Commit SHA
4. Any deviation from the prompt (especially around `cwd` handling — workstream 2 needed a `cwd: workDir` that wasn't in the original prompt; flag anything similar here)
