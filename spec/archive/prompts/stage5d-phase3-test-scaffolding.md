# Cursor Prompt — Stage 5d Phase 3: Adversarial Test Scaffolding Templates

> **Purpose:** Boundary and behavioral testers currently emit full test files. Phase 3 makes them emit only property bodies + grounding pointers (same claims JSON protocol the contract tester already uses), then assembles the scaffolding deterministically in the write nodes. This strips 40–70% of tokens from tester output and makes every tester protocol-uniform.
>
> **Tier (per ADR-0004):** Tier 1 — fully deterministic assembly. The LLM creative contribution is the property body and grounding pointer; everything else is template.

Read CLAUDE.md fully before writing any code. Then read:
- `spec/adr/0001-deterministic-filters-for-llm-output.md` — the principle this builds on
- `spec/adr/0004-determinism-local-frontier-tiers.md` — confirms this is Tier 1 work
- `packages/agents/prompts/contract-tester.md` — the output protocol to replicate for boundary + behavioral
- `packages/agents/prompts/boundary-tester.md` — what the boundary tester currently emits (full test file)
- `packages/agents/prompts/behavioral-tester.md` — what the behavioral tester currently emits (full test file)
- `packages/blueprints/src/implement-feature.ts` — the four nodes to touch: `write-tests`, `generate-tests` (boundary), `write-behavioral-tests`, `generate-behavioral-tests`; and the existing `verify-claim-grounding` + `write-contract-tests` to use as canonical reference
- `packages/verify/src/review-grounding.ts` — `parseClaimDocument` / `verifyClaimGrounding` to understand the existing parser

---

## What to build

### 1. Boundary-tester prompt → claims protocol

Change `packages/agents/prompts/boundary-tester.md` Output Format section:

- Remove the "Output ONLY the test file content" instruction and all the per-language full-file templates.
- Replace with the **identical claims JSON protocol** the contract-tester already uses (see contract-tester.md Output Format), with these differences:
  - `id` prefix `"bnd"` instead of `"c"` (e.g. `"bnd1"`, `"bnd2"`)
  - `grounding` quote must be a verbatim substring from the **type signatures / acceptance criteria / task description** the boundary-tester received — not the ContractContext (boundary-tester doesn't see that). Keep the same "copy-paste fragment exactly; paraphrases will be rejected" language.
  - `test` field: the `it(...)` or language-equivalent wrapper + property body. Import lines go before the `it(...)` block (same hoisting rule). Do NOT import the test framework primitives — handled automatically.
- Keep all the concern lens sections (`{{#concern ...}}`), all the rules (1–15), and the `{{#if isTypeScript}}` / `{{#if isPython}}` etc. conditional blocks. These are unaffected — they guide what the agent probes, not how it formats output.
- Add a note: "The `test` field must use the test framework conventions from the Output Format — `it(...)` for TS/Vitest, a method for Python/pytest, a `func Test...` for Go, `#[test]` for Rust, `@Test void` for Java/Kotlin. The write node handles all wrapping (imports, `describe`, class body). Your job is the property body."

### 2. New `verify-boundary-grounding` blueprint node

Insert a new deterministic node between `generate-tests` and `write-tests` in `packages/blueprints/src/implement-feature.ts`.

Use `verify-claim-grounding` (the contract-scope equivalent) as the exact template. The differences:

- Node id: `"verify-boundary-grounding"`
- Node name: `"Verify Boundary Claim Grounding"`
- Reads from `ctx.results["generate-tests"]` instead of `ctx.results["generate-contract-tests"]`
- Corpus: build from the same source the boundary-tester received — i.e. the **signatures string** (extract-signatures node output: `ctx.results["extract-signatures"]?.data`) plus the plan summary and acceptance criteria from `ctx.plan`. Concatenate them into a corpus string and call `verifyClaimGrounding` against it.
- Error codes: `BOUNDARY_TESTER_OUTPUT_INVALID` (malformed JSON) and `BOUNDARY_TESTER_NO_GROUNDED_CLAIMS` (zero survive) — add both to `BollardErrorCode` in `packages/engine/src/errors.ts`.
- Log event name: `boundary_grounding_result` (matching the `contract_grounding_result` pattern).
- `onFailure`: `"skip"` — boundary grounding failure should not block contract/behavioral/mutation. Emit a warning log and return `status: "ok"` with `{ skipped: true, reason: "..." }` on the error path (same pattern as other skippable nodes).

### 3. Update `write-tests` node (boundary)

The `write-tests` node currently reads `testerOutput` as a raw string and calls `stripMarkdownFences`. Change it to:

1. Read `ctx.results["verify-boundary-grounding"]?.data` for `{ skipped, claims }`.
2. If skipped or no claims → return `{ status: "ok", data: { skipped: true } }`.
3. Assemble the test file from claims exactly as `write-contract-tests` does (hoist imports, dedup, wrap in `describe`/class/etc. per language). Extract the shared assembly logic (see §5 below).
4. Keep the existing information-leak scan (private identifier check) — run it on the assembled `fileContent`, not on a raw tester string.
5. Keep `formatGeneratedAdversarialTestFile` call.

### 4. Behavioral-tester prompt → already uses claims protocol

Check `packages/agents/prompts/behavioral-tester.md`. It already emits claims JSON. **No prompt change needed.** The only gap is that `write-behavioral-tests` currently does NOT use the claims protocol for assembly — it reads `ctx.results["write-behavioral-tests"]` raw. Fix `write-behavioral-tests` to assemble from `ctx.results["verify-behavioral-grounding"]?.data.claims` using the same shared assembler (§5).

### 5. Extract shared test-file assembler

Create `packages/blueprints/src/test-assembler.ts`:

```typescript
export interface AssemblerOptions {
  claims: ClaimRecord[]          // from verify-*-grounding
  profile: ToolchainProfile
  sourceFile: string             // for path derivation + JVM package inference
  scope: "boundary" | "contract" | "behavioral"
  contractContext?: ContractContext  // for JVM module prefix (contract scope only)
  runId: string
  task: string
}

export interface AssembledTest {
  fileContent: string
  testPath: string   // relative path for writing
}

export function assembleTestFile(opts: AssemblerOptions): AssembledTest
```

Move the shared logic out of `write-contract-tests` and `write-behavioral-tests` into this function. The three write nodes all call `assembleTestFile` — no duplication. The per-language scaffolding (preamble, wrapStart, wrapEnd) stays in this file, not spread across three nodes.

The function is **pure** (no I/O) — callers do the `writeFile`. This makes it straightforward to unit test.

### 6. Update evals

Update `packages/agents/src/evals/boundary-tester/cases.ts`:

- The expected output format for boundary-tester evals must now be claims JSON, not a test file. Update at least one eval case to assert the output is parseable as a claims document (call `parseClaimDocument` in the eval assertion) rather than checking for `describe(` or `it(` strings directly.

### 7. Tests

New test files:

- `packages/blueprints/tests/test-assembler.test.ts` — unit tests for `assembleTestFile`:
  - TypeScript: given 2 claims with hoisted imports, produces correct Vitest file
  - Python: wraps in functions with pytest style
  - Java: wraps in JUnit 5 class with package line
  - Deduplication: two claims importing the same module → one import line
  - Empty claims list → throws or returns empty (document the contract)

- Update `packages/blueprints/tests/implement-feature.test.ts`:
  - Node count is now 30 (was 29; `verify-boundary-grounding` is the new node)
  - Assert `verify-boundary-grounding` appears between `generate-tests` and `write-tests`

- Update `packages/agents/tests/boundary-tester.test.ts`:
  - Prompt contains `"claims"` and `"grounding"` in the output format section
  - Prompt does NOT contain `"Output ONLY the test file content"` (old instruction)

---

## What NOT to do

- Do not change the `verify-claim-grounding` node (contract scope) — it stays as-is.
- Do not change `write-contract-tests` assembly logic — move it to `assembleTestFile`, but the contract node's behaviour must be identical post-refactor.
- Do not add a `verify-behavioral-grounding` node — it already exists. Just fix `write-behavioral-tests` to read from it correctly.
- Do not touch the behavioral-tester prompt — it already outputs claims JSON.
- Do not add new languages or new concern weights.
- Do not touch the grounding verifier itself (`parseClaimDocument`, `verifyClaimGrounding` in `review-grounding.ts`) — it already works for all three scopes.

---

## Validation checklist (run before committing)

```bash
docker compose run --rm dev run typecheck   # must be clean
docker compose run --rm dev run lint        # must be clean
docker compose run --rm dev run test        # all existing tests pass + new assembler tests
docker compose run --rm dev --filter @bollard/cli run start -- contract   # contract graph still prints
```

Post-validation, run a Bollard-on-Bollard self-test:

```bash
docker compose run --rm -e BOLLARD_AUTO_APPROVE=1 dev sh -c \
  'pnpm --filter @bollard/cli run start -- run implement-feature \
   --task "Add a divide(a, b) method to CostTracker that throws CONTRACT_VIOLATION on divide-by-zero" \
   --work-dir /app'
```

Confirm:
- `verify-boundary-grounding` node appears in the run output and emits `boundary_grounding_result` log event
- `write-tests` produces a file assembled from claims (not a raw fence-stripped string)
- `write-behavioral-tests` produces a file assembled from grounded behavioral claims
- `write-contract-tests` behaviour is unchanged (same output shape as before the refactor)
- Node count in run output: 30 nodes
- No regression on grounding drop rates (all three scopes should show 0 drops on a clean task)

---

## Implementation note: boundary corpus construction

`ContractCorpus` is `{ entries: string[] }` — it is a generic string array, not contract-specific. To build the boundary corpus, construct it directly:

```typescript
const sigData = ctx.results["extract-signatures"]?.data as
  | { signatures?: string; types?: string; imports?: string }
  | undefined
const plan = ctx.plan as
  | { summary?: string; acceptance_criteria?: string[] }
  | undefined
const corpus: ContractCorpus = {
  entries: [
    sigData?.signatures ?? "",
    sigData?.types ?? "",
    sigData?.imports ?? "",
    plan?.summary ?? "",
    ctx.task,
    ...(plan?.acceptance_criteria ?? []),
  ].filter(s => s.length > 0),
}
```

Then call `verifyClaimGrounding(doc, corpus, enabled, { noGroundedClaimsCode: "BOUNDARY_TESTER_NO_GROUNDED_CLAIMS" })` exactly as the behavioral node does.

`verify-boundary-grounding` uses `onFailure: "skip"` and catches `BollardError` — on failure it returns `{ status: "ok", data: { skipped: true, reason: err.message } }` so the rest of the pipeline is unaffected. Same pattern as `verify-behavioral-grounding`.
