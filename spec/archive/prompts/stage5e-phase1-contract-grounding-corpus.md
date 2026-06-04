# Cursor Prompt — Stage 5e Phase 1: Contract Grounding Corpus Expansion

> **Purpose:** The Stage 5c self-test (reset(), run `20260528-0353-run-f616b1`) showed `contract 0/8
> grounded` even with the Phase 14 fix (task + acceptance criteria in corpus) already active. Root
> cause: the contract-tester generates grounding quotes by inferring behavior from type signatures,
> but the corpus only contains signatures, edge descriptions, plan summary, task string, and
> acceptance criteria — not the actual implemented source code. The tester quotes things like
> "sets _total back to 0" which is behavioral description that doesn't appear verbatim in any
> corpus entry. The grounding verifier then drops every claim as `grounding_not_in_context`.
>
> Fix: add the post-implementation content of the affected source files to the contract grounding
> corpus. The tester already *receives* the signatures (from the contract graph). Giving the verifier
> the same source text that the tester reasons from closes the gap: if the tester quotes a real
> identifier or comment from the source, grounding passes. This is a pure deterministic change —
> no LLM calls, no new agents.

Read `CLAUDE.md` fully before writing any code. Then read:
- `packages/blueprints/src/implement-feature.ts` — the `verify-claim-grounding` node (~line 676) and
  `contractContextToCorpus` call (~line 744); also `getAffectedSourceFiles` (~line 126)
- `packages/verify/src/contract-grounding.ts` — `contractContextToCorpus`, `ContractCorpus`,
  `normaliseForComparison`, `verifyClaimGrounding`
- `packages/verify/tests/contract-grounding.test.ts` — existing corpus and grounding tests

---

## Goal

Extend `contractContextToCorpus` to accept an optional `sourceContents?: string[]` parameter
containing the raw text of the affected source files. Add each source file's content as a corpus
entry. Update the `verify-claim-grounding` node in `implement-feature.ts` to read the affected
source files from disk and pass them in.

No changes to: agent prompts, blueprint structure, `verifyClaimGrounding`, `parseClaimDocument`,
or any other pipeline node.

---

## Step 1 — Update `contractContextToCorpus` signature

**File:** `packages/verify/src/contract-grounding.ts`

Change the function signature from:

```typescript
export function contractContextToCorpus(
  ctx: ContractContext,
  planSummary?: string,
  taskStr?: string,
  acceptanceCriteria?: string[],
): ContractCorpus
```

To:

```typescript
export function contractContextToCorpus(
  ctx: ContractContext,
  planSummary?: string,
  taskStr?: string,
  acceptanceCriteria?: string[],
  sourceContents?: string[],
): ContractCorpus
```

At the end of the function body, before `return { entries }`, add:

```typescript
for (const content of sourceContents ?? []) {
  if (content.trim().length > 0) entries.push(content)
}
```

This is additive — all existing callers pass nothing for `sourceContents` and behavior is unchanged.

---

## Step 2 — Read source files in `verify-claim-grounding` node

**File:** `packages/blueprints/src/implement-feature.ts`

In the `verify-claim-grounding` node's `execute` function (around line 730), after the corpus is
built from `contractContextToCorpus(contract, planSummary, taskStr, acceptanceCriteria)`, add
source file reading before the `contractContextToCorpus` call:

```typescript
// Read affected source files to include in grounding corpus.
// This closes the gap where the tester quotes behavioral descriptions from the
// source body that don't appear in signatures or plan text.
const affectedFiles = getAffectedSourceFiles(ctx)
const sourceContents: string[] = []
for (const filePath of affectedFiles) {
  try {
    const content = await readFile(resolve(workDir, filePath), "utf-8")
    sourceContents.push(content)
  } catch {
    // File may not exist if this is a verification-only run — skip silently.
  }
}

const corpus = contractContextToCorpus(
  contract,
  planSummary,
  taskStr,
  acceptanceCriteria,
  sourceContents,
)
```

`readFile` and `resolve` are already imported at the top of `implement-feature.ts`. Do NOT add
new imports.

---

## Step 3 — Update tests

**File:** `packages/verify/tests/contract-grounding.test.ts`

Add a new `describe("contractContextToCorpus with sourceContents")` block with at least 3 tests:

1. **source content included in corpus** — pass `sourceContents: ["function reset() { this._total = 0 }"]`;
   verify the returned corpus contains that string as an entry.

2. **grounding succeeds when quote appears only in source** — construct a `ClaimDocument` where
   `grounding[0].quote` is a substring of the source content but NOT in any signature/edge/task
   entry; verify `verifyClaimGrounding` keeps the claim (doesn't drop it as
   `grounding_not_in_context`).

3. **empty/whitespace source content skipped** — pass `sourceContents: ["", "   "]`; verify
   those don't add corpus entries (i.e. `corpus.entries` length unchanged vs no sourceContents).

4. **backward compat — undefined sourceContents** — existing calls with no 5th arg still work;
   corpus entries match the pre-change output.

---

## Self-check

Run sequentially. Do NOT declare done until all pass.

1. `docker compose run --rm dev run typecheck` — exit 0
2. `docker compose run --rm dev run lint` — exit 0
3. `docker compose run --rm dev run test` — all pass; count ≥ 1381 (1377 + ≥ 4 new)
4. `git diff --stat HEAD -- packages/agents/prompts` — empty (no prompt files changed)
5. `git diff --stat HEAD -- packages/blueprints/src/implement-feature.ts` — shows only the
   `verify-claim-grounding` node change (source file reading + corpus call update)
6. Grep new code for any `await provider.chat` or `chatStream` — zero matches

---

## When GREEN — doc updates

- In `CLAUDE.md`: add to the Stage 5e / known limitations section — "**Stage 5e Phase 1 (DONE):**
  `contractContextToCorpus` accepts optional `sourceContents?: string[]`; `verify-claim-grounding`
  node reads affected source files post-implementation and passes content into corpus. Closes
  `grounding_not_in_context` gap where tester quotes source body behavior not present in signatures."
- In `spec/ROADMAP.md`: strike through "Contract grounding corpus expansion" under Stage 5e Phase 1.
- Move this file to `spec/archive/prompts/stage5e-phase1-contract-grounding-corpus.md`

---

## Out of scope

- DO NOT change `verifyClaimGrounding` logic — only the corpus input changes
- DO NOT change `parseClaimDocument` or claim ID handling
- DO NOT add source content to the boundary or behavioral corpus — only contract
- DO NOT change the contract-tester prompt
- DO NOT add source file reading to any node other than `verify-claim-grounding`
- DO NOT read test files — only source files from `getAffectedSourceFiles(ctx)`
- DO NOT cap or truncate source content — pass the full file (corpus normalisation handles whitespace)
