# Cursor Prompt — Fix Contract Grounding Corpus: Include Task + Acceptance Criteria

> **Context:** Three consecutive Bollard-on-Bollard self-tests have shown 55–88% contract claim drop
> rates. The root cause is fully understood and confirmed in the merge() run (run id
> `20260525-0343-run-cb1abe`, 7/8 claims dropped, all with `grounding_not_in_context`):
> the contract-tester receives `# Task` and `# Acceptance criteria` in its message, and
> quotes from those sections in its `grounding[].quote` fields — but the grounding corpus
> built by `contractContextToCorpus` does not include those strings. Any claim quoting from
> the task description or acceptance criteria fails `verifyClaimGrounding` with
> `grounding_not_in_context` regardless of correctness.
>
> **Read CLAUDE.md fully before starting.** Then read these files in order:
> - `packages/cli/src/agent-handler.ts` — `buildContractTesterMessage()` (line ~380): what
>   the tester receives (Task, ContractContext JSON, Plan summary, Acceptance criteria)
> - `packages/verify/src/contract-grounding.ts` — `contractContextToCorpus()` (line ~274):
>   what the corpus contains (publicExports signatures/types/imports, edge descriptions,
>   optional planSummary)
> - `packages/blueprints/src/implement-feature.ts` — the `verify-claim-grounding` node
>   (search for `"verify-claim-grounding"`): where `contractContextToCorpus(contract, planSummary)`
>   is called and where the corpus and enabled concerns are passed to `verifyClaimGrounding`

---

## Root Cause (confirmed)

`buildContractTesterMessage` sends the contract-tester this context:

```
# Task
<ctx.task — the raw task string>

# ContractContext
<JSON of modules/exports/edges>

# Plan summary
<plan.summary>

# Acceptance criteria
1. <criterion 1>
2. <criterion 2>
...
```

The contract-tester's prompt instructs: *"quote must be a verbatim substring copied from the
contract context you received (signatures, type definitions, edge descriptions, plan summary)"*.
In practice the model also quotes from `# Task` and `# Acceptance criteria` sections —
reasonable, since those are in the message.

`contractContextToCorpus(contract, planSummary)` builds the corpus from:
- `mod.publicExports[].signatures` / `types` / `imports` for each module
- Edge description strings (`edge: from -> to`, `importedSymbols: ...`)
- The optional `planSummary` (= `plan.summary` only)

It does NOT include `ctx.task` or `plan.acceptance_criteria[]`. When a claim's `grounding[].quote`
is drawn from those sections, `normaliseForComparison(quote)` finds no match in any corpus entry
→ claim dropped with `grounding_not_in_context`.

Confirmed in merge() log:
- c7 survived: grounded `"costTracker: CostTracker"` and `"merge(other: CostTracker): CostTracker"` — actual signatures in the corpus ✓
- c1–c6, c8 dropped: grounded phrases like `"combines the totals of two trackers"` (from task description) or `"throws BollardError with CONTRACT_VIOLATION"` (from acceptance criteria) — not in corpus ✗

---

## What to Fix

**File 1: `packages/blueprints/src/implement-feature.ts`**

In the `verify-claim-grounding` node execute function, the corpus is built as:

```typescript
const corpus = contractContextToCorpus(contract, planSummary)
```

where `planSummary` is `plan?.["summary"]`.

Extend this to also pass the task string and acceptance criteria strings so the corpus matches
what the tester actually received. Add a helper call or extend the argument:

```typescript
// Collect all strings the tester received so the corpus matches its input
const taskStr = ctx.task
const acceptanceCriteria = Array.isArray(plan?.["acceptance_criteria"])
  ? (plan["acceptance_criteria"] as unknown[]).map((c) => String(c))
  : []
const corpus = contractContextToCorpus(contract, planSummary, taskStr, acceptanceCriteria)
```

**File 2: `packages/verify/src/contract-grounding.ts`**

Extend `contractContextToCorpus` to accept the task string and acceptance criteria:

```typescript
export function contractContextToCorpus(
  ctx: ContractContext,
  planSummary?: string,
  taskStr?: string,
  acceptanceCriteria?: string[],
): ContractCorpus {
  const entries: string[] = []

  for (const mod of ctx.modules) {
    for (const sig of mod.publicExports) {
      if (sig.signatures) entries.push(sig.signatures)
      if (sig.types) entries.push(sig.types)
      if (sig.imports) entries.push(sig.imports)
    }
  }

  for (const edge of ctx.edges) {
    const parts: string[] = [
      `edge: ${edge.from} -> ${edge.to}`,
      `importedSymbols: ${edge.importedSymbols.join(", ")}`,
    ]
    if (edge.providerErrors.length > 0) {
      parts.push(`providerErrors: ${edge.providerErrors.join(", ")}`)
    }
    if (edge.consumerCatches.length > 0) {
      parts.push(`consumerCatches: ${edge.consumerCatches.join(", ")}`)
    }
    entries.push(parts.join("\n"))
  }

  if (planSummary) {
    entries.push(planSummary)
  }

  if (taskStr) {
    entries.push(taskStr)
  }

  for (const criterion of acceptanceCriteria ?? []) {
    if (criterion) entries.push(criterion)
  }

  return { entries }
}
```

> **Design note:** The corpus entries are used as `entry.includes(normQuote)` substring
> matching. Adding the task string and criteria strings as separate corpus entries means
> individual sentences from those sections will match. This is consistent with how
> `planSummary` is already added as a single corpus entry.

---

## Files to Change

- `packages/verify/src/contract-grounding.ts` — extend `contractContextToCorpus` signature + body
- `packages/blueprints/src/implement-feature.ts` — pass `taskStr` + `acceptanceCriteria` to `contractContextToCorpus` in `verify-claim-grounding` node
- `packages/verify/tests/contract-grounding.test.ts` — add tests (see below)

Do NOT change any other files.

---

## Tests to Add

In `packages/verify/tests/contract-grounding.test.ts`, add a new `describe` block or extend
the existing `contractContextToCorpus` coverage:

```typescript
describe("contractContextToCorpus — task and acceptance criteria", () => {
  const emptyCtx: ContractContext = { modules: [], edges: [], affectedEdges: [] }

  it("includes taskStr as a corpus entry when provided", () => {
    const corpus = contractContextToCorpus(emptyCtx, undefined, "Add merge(other) method")
    expect(corpus.entries).toContain("Add merge(other) method")
  })

  it("includes each acceptance criterion as a separate corpus entry", () => {
    const corpus = contractContextToCorpus(emptyCtx, undefined, undefined, [
      "throws BollardError with CONTRACT_VIOLATION when other is null",
      "returns a new tracker with combined totals",
    ])
    expect(corpus.entries).toContain(
      "throws BollardError with CONTRACT_VIOLATION when other is null",
    )
    expect(corpus.entries).toContain("returns a new tracker with combined totals")
  })

  it("a claim quoting acceptance criterion text passes grounding", () => {
    const corpus = contractContextToCorpus(
      emptyCtx,
      undefined,
      "Add merge(other: CostTracker): CostTracker",
      ["throws BollardError with CONTRACT_VIOLATION if other is not a CostTracker"],
    )
    const doc: ClaimDocument = {
      claims: [
        {
          id: "c1",
          concern: "correctness",
          claim: "merge throws when other is invalid",
          grounding: [
            {
              quote: "throws BollardError with CONTRACT_VIOLATION if other is not a CostTracker",
              source: "acceptance_criteria:1",
            },
          ],
          test: "it('placeholder', () => {})",
        },
      ],
    }
    const result = verifyClaimGrounding(doc, corpus, { correctness: true })
    expect(result.kept).toHaveLength(1)
    expect(result.dropped).toHaveLength(0)
  })

  it("a claim quoting task description text passes grounding", () => {
    const corpus = contractContextToCorpus(
      emptyCtx,
      undefined,
      "Add merge(other: CostTracker): CostTracker method that combines totals",
      [],
    )
    const doc: ClaimDocument = {
      claims: [
        {
          id: "c2",
          concern: "correctness",
          claim: "merge combines totals",
          grounding: [
            {
              quote: "combines totals",
              source: "task_description",
            },
          ],
          test: "it('placeholder', () => {})",
        },
      ],
    }
    const result = verifyClaimGrounding(doc, corpus, { correctness: true })
    expect(result.kept).toHaveLength(1)
    expect(result.dropped).toHaveLength(0)
  })

  it("omitting taskStr and criteria preserves existing corpus behavior", () => {
    const corpus = contractContextToCorpus(emptyCtx, "plan summary text")
    expect(corpus.entries).toEqual(["plan summary text"])
  })
})
```

---

## Self-check before completing

```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

Verify:
- typecheck: zero errors
- lint: zero errors
- test: ≥ 1186 passed / 6 skipped (new tests add to this)
- `git diff --name-only` shows ONLY:
  - `packages/verify/src/contract-grounding.ts`
  - `packages/blueprints/src/implement-feature.ts`
  - `packages/verify/tests/contract-grounding.test.ts`

---

## Expected impact

Based on the merge() run log, 6 of the 7 dropped claims quoted from the task description or
acceptance criteria. With this fix, those claims will pass grounding and their tests will be
assembled into the contract test file. The predicted post-fix drop rate on bounded single-method
tasks (where most claims quote from these sections): 0–1 of 8 dropped vs the current 6–7 of 8.

The one surviving claim in the merge() run (c7) already grounded against TypeScript signatures
and will continue to pass. This fix is additive — it cannot cause previously-passing claims
to fail.
