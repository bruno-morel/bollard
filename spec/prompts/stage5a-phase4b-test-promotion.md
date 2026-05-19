# Cursor Prompt — Stage 5a Phase 4b: Adversarial Test Promotion

> **Context:** Bollard regenerates adversarial tests from scratch every pipeline run. Tests that catch real bugs or are repeatedly generated across runs should become permanent — but only with explicit user approval. `bollard promote-test <path>` already exists as a bare-bones manual copy+strip. Phase 4b upgrades it with fingerprinting, `promoted.json` tracking, Signal 1 (bug-catcher) detection at the `approve-pr` gate, and import path rewriting.
>
> **Read CLAUDE.md fully before writing any code.** Then read:
> - `packages/engine/src/run-history.ts` — `RunRecord`, `ScopeResult` (no fingerprints yet), `NodeSummary`
> - `packages/cli/src/index.ts` — `runPromoteTestCommand` (lines 569–613) — the existing bare-bones implementation; `runHumanGateCommand` and `approve-pr` handling
> - `packages/cli/src/agent-handler.ts` — how the `approve-pr` human gate is handled and what context is available at that point
> - `packages/cli/src/history-record.ts` — `buildRunRecord` — where `ScopeResult` is assembled
> - `packages/blueprints/src/implement-feature.ts` — node 28 `approve-pr` is the human gate where promotion candidates must be shown
> - `spec/stage5a-self-hosting.md §13` — full design (fingerprinting, promotion flow, what is/isn't promotable)

---

## What to build — four self-contained pieces

---

### Piece 1 — `packages/engine/src/test-fingerprint.ts` (new file)

```typescript
export interface TestFingerprint {
  scope: "boundary" | "contract" | "behavioral"
  targetModule: string        // basename of the test file without extension
  assertionTypes: string[]    // sorted: ["rejects", "throws", "toBe", ...]
  inputPatterns: string[]     // normalized: ["null", "empty-string", "negative-number"]
  hash: string                // SHA-256 hex of JSON.stringify({ scope, targetModule, assertionTypes, inputPatterns })
}

export interface PromotedTest {
  hash: string
  promotedAt: number          // Date.now()
  sourcePath: string          // original .bollard/tests/... path
  destPath: string            // promoted tests/... path
}

export interface PromotedManifest {
  schemaVersion: 1
  promoted: PromotedTest[]
}
```

**`extractFingerprint(testFilePath: string, content: string, scope: ScopeResult["scope"]): TestFingerprint`**
- `targetModule`: `path.basename(testFilePath, path.extname(testFilePath))` — strip extension
- `assertionTypes`: regex scan content for `expect(`, `.toBe(`, `.toThrow(`, `.rejects`, `.resolves`, `assert.`, `raises`, `pytest.raises` — collect unique matches, sort
- `inputPatterns`: regex scan for common null/edge patterns: `null`, `undefined`, `""`, `[]`, `{}`, `-1`, `0`, `NaN`, `Infinity` — collect unique normalized labels, sort
- `hash`: `createHash("sha256").update(JSON.stringify({ scope, targetModule: ..., assertionTypes, inputPatterns })).digest("hex")`

**`readPromotedManifest(workDir: string): Promise<PromotedManifest>`**
- Read `.bollard/promoted.json`. Return `{ schemaVersion: 1, promoted: [] }` on ENOENT.

**`writePromotedManifest(workDir: string, manifest: PromotedManifest): Promise<void>`**
- `mkdir` `.bollard/` recursively, write with `JSON.stringify(manifest, null, 2) + "\n"`.

**`isAlreadyPromoted(manifest: PromotedManifest, hash: string): boolean`**
- Returns `manifest.promoted.some(p => p.hash === hash)`.

Export all types and functions. No classes. Use `node:crypto` for SHA-256.

---

### Piece 2 — Extend `ScopeResult` in `packages/engine/src/run-history.ts`

Add one optional field to `ScopeResult`:

```typescript
export interface ScopeResult {
  // ... existing fields unchanged ...
  testFingerprints?: string[]   // SHA-256 hashes of TestFingerprints for this scope's generated tests
}
```

This is an additive change — existing records without the field are unaffected. No schema version bump needed (the field is optional).

---

### Piece 3 — Upgrade `packages/cli/src/index.ts` `runPromoteTestCommand`

Replace the existing implementation (lines 569–613) with a version that:

1. Reads the source file path from `args[0]`.
2. Detects scope from path: `boundary` if path contains `boundary`, `contract` if `contract`, `behavioral` if `behavioral`. Default: `boundary`.
3. Calls `extractFingerprint(sourcePath, content, scope)`.
4. Reads `promoted.json` via `readPromotedManifest(workDir)`.
5. If `isAlreadyPromoted(manifest, fingerprint.hash)` → print yellow warning "Already promoted (hash: ...)" and exit 0.
6. **Determine destination path:**
   - Strip `.bollard/tests/boundary/`, `.bollard/tests/contract/`, `.bollard/tests/behavioral/` prefix
   - Place in `tests/` at workspace root
   - Keep filename unchanged
7. **Rewrite imports via `rewriteImportsForPromotion`** (new helper — see below).
8. **Strip markers**: remove lines matching `// @bollard-generated` or `# @bollard-generated`.
9. Copy content to destination, `mkdir` as needed.
10. Append to `promoted.json`: new `PromotedTest` entry with hash, timestamp, sourcePath, destPath.
11. Print: `✓ Promoted: <sourcePath> → <destPath>` and `  Fingerprint: <hash[:12]>`.

**`rewriteImportsForPromotion(content: string, fromPath: string, toPath: string): string`**

TypeScript-only for now (Bollard is a TypeScript project). Finds lines matching:
```
import ... from "../../src/..."
import ... from "../src/..."
```
And adjusts the relative path so it resolves correctly from `toPath` instead of `fromPath`. Use `node:path` `relative`, `dirname`, `resolve` — no regex heuristics. If the import resolves to an absolute path (e.g., `@bollard/engine`), leave it unchanged.

Put `rewriteImportsForPromotion` in `packages/cli/src/index.ts` as a local helper (it's only used here). No new file needed.

---

### Piece 4 — Signal 1 detection at `approve-pr` gate

The `approve-pr` human gate (node 28 in `implement-feature`) is handled by `runHumanGateHandler` in `agent-handler.ts` (or wherever the CLI wires `HumanGateHandler`). Before printing the diff summary and asking for approval, detect Signal 1 candidates:

**Signal 1 — Bug catcher:** A scope's `run-tests` (boundary) or `run-contract-tests` or `run-behavioral-tests` node initially had `status: "fail"`, but the final `run-tests` result (after coder fix) shows `status: "ok"` AND the test file exists in `.bollard/tests/`.

Implementation:
1. At the `approve-pr` gate, inspect `ctx.results` for the three test-run nodes.
2. For each scope where the test file exists (`ctx.results["write-tests"]?.data?.testFile`, same for contract/behavioral):
   - Check if there's evidence of initial failure: `ctx.results["run-tests"]?.status === "ok"` after a retry (the `attempt` field on the node result, if available) — OR simply: if `ctx.results["static-checks"]?.status === "fail"` and `ctx.results["run-tests"]?.status === "ok"`, the coder had to fix something.
   - A simpler heuristic: if `ctx.results["run-tests"]?.status === "ok"` AND the coder made ≥1 edit to the source files AND the test file exists → candidate.
3. For each candidate test file, call `extractFingerprint`, check `isAlreadyPromoted`.
4. If any un-promoted candidates exist, print them before the diff:

```
──────────────────────────────────────────
Promotion candidates
──────────────────────────────────────────
  ✓ Boundary test is passing and not yet promoted:
    .bollard/tests/boundary/cost-tracker.boundary.test.ts
    Run: bollard promote-test .bollard/tests/boundary/cost-tracker.boundary.test.ts
──────────────────────────────────────────
```

Do NOT block approval or auto-promote — just surface the information. The user promotes manually with `bollard promote-test` after approving.

Find where `approve-pr` output is printed in `packages/cli/src/agent-handler.ts` (or `index.ts`) and add the candidate display there.

---

## Tests to add

### `packages/engine/tests/test-fingerprint.test.ts` (new file)

8 tests:
1. `extractFingerprint` returns stable hash for identical content
2. `extractFingerprint` returns same hash when variable names differ but assertion types match
3. `extractFingerprint` detects `null` and `undefined` input patterns
4. `extractFingerprint` sorts assertionTypes and inputPatterns before hashing
5. `readPromotedManifest` returns empty manifest for nonexistent file
6. `writePromotedManifest` round-trips with `readPromotedManifest`
7. `isAlreadyPromoted` returns true when hash is in manifest
8. `isAlreadyPromoted` returns false when hash is absent

Use `os.tmpdir()` + `crypto.randomUUID()` for file tests.

### `packages/cli/tests/promote-test.test.ts` (new file)

4 tests:
1. `rewriteImportsForPromotion` adjusts relative imports correctly when moving up one directory
2. `rewriteImportsForPromotion` leaves `@bollard/` package imports unchanged
3. `rewriteImportsForPromotion` handles no-import files without error
4. `runPromoteTestCommand` (integration): copies file, strips markers, writes `promoted.json`

---

## CLAUDE.md update

Add a new `### Stage 5a Phase 4b (DONE)` section after the existing `### Stage 5a Phase 5 (DONE)` block:

```
### Stage 5a Phase 4b (DONE) — Adversarial Test Promotion:

`TestFingerprint` interface in `@bollard/engine` with stable SHA-256 hash (scope + targetModule + assertionTypes + inputPatterns). `readPromotedManifest`/`writePromotedManifest`/`isAlreadyPromoted` for `.bollard/promoted.json` tracking. `ScopeResult.testFingerprints?: string[]` added (additive, no schema version bump). `bollard promote-test` upgraded: fingerprint extraction, already-promoted guard, import path rewriting, marker stripping, manifest registration. Signal 1 (bug-catcher) candidate detection at `approve-pr` gate — surfaces un-promoted passing test files as suggestions without blocking approval.
```

Also update the forward roadmap bullet in CLAUDE.md (line ~15):
```
- **Stage 5a (self-hosting):** Phase 1–3 DONE ... Phase 4a DONE ... **Phase 4b DONE** (adversarial test promotion — fingerprinting, promoted.json, Signal 1 detection at approve-pr). Phase 5 DONE ... Next: Phase 6 (protocol compliance CI).
```

---

## ROADMAP.md update

In `spec/ROADMAP.md`, find the Phase 4b bullet and mark it DONE:
```
- ~~**Adversarial test promotion (Phase 4b):**~~ **DONE (2026-05-19).** `TestFingerprint` + SHA-256 hash, `.bollard/promoted.json` manifest, upgraded `bollard promote-test` with import rewriting + already-promoted guard, Signal 1 bug-catcher detection at `approve-pr` gate.
```

---

## Validation

```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

Expected: clean typecheck + lint; test count increases by 12 (8 fingerprint + 4 promote-test).

---

## Constraints

- **No automatic promotion** — Bollard always surfaces candidates, never promotes without user confirmation. The `bollard promote-test` command is the only promotion path.
- **Signal 2 (repeated generation) is NOT in scope** — it requires cross-run fingerprint comparison across `RunRecord`s and is deferred. Only Signal 1 (bug catcher) is implemented here.
- **`rewriteImportsForPromotion` is TypeScript-only** — Python/Go/Rust import rewriting is deferred. For non-TS test files, copy without rewriting and print a yellow note: "Import paths may need manual adjustment for non-TypeScript files."
- **Do NOT change `RunRecord` schema version** — the `testFingerprints` field on `ScopeResult` is optional and additive.
- **Do NOT change `runEvals`, `eval-runner.ts`, or any eval infrastructure** — this is purely run-history + promotion.
- **`buildRunRecord` in `history-record.ts`** — add fingerprint extraction there so every future run automatically records fingerprints. Read each scope's test file from `ctx.results`, call `extractFingerprint`, store hashes in `ScopeResult.testFingerprints`. Non-fatal if the file doesn't exist.
- Follow the existing no-class, named-export, kebab-case-files conventions.
- `exactOptionalPropertyTypes` — no explicit `undefined` assignments.
