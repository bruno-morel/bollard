# 08 — Contract-tester grounding architecture

## Status
Proposed · 2026-04-08 · blocks Stage 3a GREEN flip

## Problem

The contract-tester generates plausible-looking tests that encode priors
beyond what the signature entails. Two instances hit the YELLOW gate:

1. `expect(0.1 + 0.2).toBe(0.3)` — asserts exact float arithmetic.
2. `expect(() => { snapshot.x = 1 }).not.toThrow()` — asserts runtime
   mutability of a `readonly` return type (implementation used
   `Object.freeze`).

Both tests were consistent with the signature but not entailed by it.
The runtime happened to violate the model's prior, and node 13 failed.

The class is unbounded: Map iteration order, error message stability,
null vs undefined, NaN comparisons, promise microtask order, reference
vs structural equality, timezone defaults, error class identity,
encoding, locale, sort stability, and on. A prompt-rule-per-failure
strategy has zero coverage of unseen members of the class and grows
without bound. We need a structural mitigation that generalises and is
language-agnostic.

## Non-goals

- Language-specific rule catalogs (this is what we're trying to escape).
- LLM-as-judge grounding (recurses the prior-encoding problem).
- Testing the implementation's current behaviour (that's codification,
  not contract testing).
- Replacing the contract-tester agent (only its output protocol and the
  deterministic layer around it).

## Design

### Core insight

The failure mode is "unjustified prior." Make justification a required,
machine-checkable field of every generated test case. No justification,
no test. The check must be deterministic — any LLM-judged grounding
recurses the problem.

### Layer 1 — Structured claims protocol (language-agnostic, ships now)

Change the contract-tester's output from "a test file" to a JSON
document with a claim list:

```json
{
  "claims": [
    {
      "id": "c1",
      "concern": "correctness",
      "claim": "snapshot() returns the current accumulated cost",
      "grounding": [
        {
          "quote": "snapshot(): Readonly<{ totalCostUsd: number }>",
          "source": "signature:CostTracker.snapshot"
        }
      ],
      "test": "it('snapshot returns current total', () => { /* ... */ })"
    }
  ]
}
```

Fields:

- `id` — unique within the document; used in rejection reports.
- `concern` — one of `correctness | security | performance | resilience`;
  must match a scope concern whose weight is not `off`.
- `claim` — natural language statement of the contract being tested.
  Not checked by the verifier, but read by humans reviewing the pipeline.
- `grounding` — non-empty list of `{ quote, source }` pairs.
- `test` — the actual test code in the target framework. Whole-case
  block, not just the body.

A new deterministic step `verifyClaimGrounding` runs between
`generate-contract-tests` and `write-contract-tests`:

1. **Parse.** Malformed JSON → node fails with
   `CONTRACT_TESTER_OUTPUT_INVALID`, pipeline halts. No repair loop in
   v1 (malformed JSON is signal the agent is off the rails, not a
   recoverable hiccup).
2. **Per-claim checks:**
   - `grounding` must be non-empty.
   - For each grounding item, `quote` (after whitespace and comment
     normalisation) must appear as a substring somewhere in the
     contract context the agent was given — signatures, type
     definitions, contract edges, declared/caught errors,
     `importedSymbols`, or the plan summary.
   - `concern` must be a configured concern for the contract scope
     whose weight is not `off`.
3. **Drop** claims that fail any check. Record drops in
   `NodeResult.data.droppedClaims` for observability.
4. **Emit.** Concatenate surviving `test` strings into the file that
   `write-contract-tests` writes. If zero claims survive, the node
   fails with `CONTRACT_TESTER_NO_GROUNDED_CLAIMS`.

The check is **pure string/structural logic**. No LLM. No regex over
test bodies. No language-specific knowledge except a tiny
whitespace/comment normaliser per source language (which we already
have for markdown-fence stripping).

### Why this is language-agnostic

The protocol is neutral in three dimensions:

- **Claim vocabulary.** Natural-language claims don't name a language.
- **Grounding mechanism.** Substring match over provided context works
  identically for TypeScript, Python, Go, Rust, or any future language.
- **Concerns.** The four-concern taxonomy is already language-neutral
  and lives in `@bollard/detect`.

The only language-specific surface left is the `test` field body, which
is necessarily framework-bound (vitest, pytest, go test, cargo test).
The contract-tester already handles this via the `{{testFramework}}`
template variable; no new work.

### Layer 2 — Normalised contract context (Stage 3b)

Layer 1 reasons over raw signature strings. Layer 2 normalises the
**input** so the agent no longer sees language-specific source at all:

```typescript
type NormalizedContract = {
  symbol: string
  kind: "function" | "method" | "class" | "type"
  parameters: Param[]
  returns: ReturnShape
  errors: { declared: ErrorRef[]; consumerCatches: ErrorRef[] }
  guarantees: Guarantee[]    // explicit runtime guarantees
  annotations: Annotation[]  // compile-time only (e.g. TS readonly)
  sourceLanguage: LanguageId
}

type Guarantee =
  | { kind: "purity"; level: "pure" | "idempotent" | "unknown" }
  | { kind: "ordering"; guaranteed: boolean }
  | { kind: "nullability"; nullable: boolean }
  | { kind: "numeric"; exact: boolean }
  | { kind: "throws"; errors: ErrorRef[] }
```

Per-language extractors (`packages/verify/src/extractors/`) emit
`NormalizedContract` instead of raw signature strings. Grounding
references structured paths (`guarantees[0].kind === "numeric"`)
instead of substrings, which is higher precision and removes the last
drop of language specificity from the agent's input.

Layer 2 also unlocks cross-language contract graphs (Stage 3b roadmap
item): if Python and Go modules normalise to the same schema, the
contract graph can span them.

**Layer 2 is not required for GREEN.** Layer 1 is sufficient. Layer 2
is the deeper move and should be planned as Stage 3b work with its own
validation pass.

## How this handles the known failures

**Float case.** Model wants `expect(0.1 + 0.2).toBe(0.3)`.

- Claim: "adding 0.1 and 0.2 yields exactly 0.3"
- Required grounding: a quoted fragment from context entailing exact
  arithmetic. The return type says `number`; nothing in the context
  promises exactness.
- Checker drops the claim. No float-specific rule needed.

**Readonly case.** Model wants `expect(mutate).not.toThrow()`.

- Claim: "mutation of snapshot.totalCostUsd does not throw at runtime"
- Required grounding: a quoted fragment entailing runtime mutability.
  `Readonly<...>` is a compile-time marker; the context says nothing
  about runtime behaviour.
- Checker drops the claim. No readonly-specific rule needed.

**Unseen failure (Map iteration order).** Same path. Claim needs
grounding that Map iteration order is a contract guarantee; none
exists in the provided context; dropped.

**Unseen failure (null vs undefined).** Same path. Claim needs
grounding that the return is specifically `null` rather than
`undefined` (or vice versa); only ground if the signature actually
types it that way.

The generality is the point. The checker doesn't know what a float or
a Map or a readonly is. It knows whether the claim is traceable to the
provided context.

## Open questions

1. **Substring match strictness.** Exact-after-normalisation is robust
   but brittle to paraphrase. Options: (a) exact, (b) token-set overlap
   with threshold, (c) per-token substring with minimum run length.
   **Start (a).** Relax only on measured false-rejection rate from
   real runs.
2. **Grounding minimum count.** One quote per claim, or more for
   certain concerns? **Start at one.** Raise for resilience concerns
   if empirical data shows single-quote grounding is insufficient.
3. **Malformed-JSON policy.** Hard fail vs partial recovery.
   **Start hard fail.** Malformed output is a prompt-quality signal
   worth surfacing loudly, not papering over.
4. **`concern` weight alignment.** Claims whose concern is weighted
   `off` for the contract scope should be dropped (the agent wasn't
   asked to probe that concern). The current prompt already hides
   `{{#concern x}}` blocks when `off`; the check adds belt-and-braces.
5. **Observability.** `NodeResult.data.droppedClaims` must include
   claim id, reason, and attempted grounding so retro-adversarial runs
   can mine patterns. This is a Stage 4 input for prompt tuning.
6. **Single retry with repair hint.** v1 design says no repair loop.
   If empirical drop-rate is high (say >30%), consider one retry with
   the failed claims echoed back as "these were dropped, try again."
   Defer until we have numbers.

## Rollout

One PR, three commits:

1. **Add the verifier.** New file
   `packages/verify/src/contract-grounding.ts` exporting
   `verifyClaimGrounding(jsonString, context): VerificationResult`.
   Pure function. Unit-tested against a golden corpus of good and bad
   claim records including the float and readonly cases from the retro
   docs. New error codes `CONTRACT_TESTER_OUTPUT_INVALID` and
   `CONTRACT_TESTER_NO_GROUNDED_CLAIMS` added to
   `BollardErrorCode`.
2. **Rewrite the prompt and wire the blueprint.** Replace the current
   contract-tester output format section and the `# Assertion Rules`
   section with the claims protocol. `implement-feature` blueprint
   gains a deterministic node between `generate-contract-tests` and
   `write-contract-tests` that runs the verifier. `write-contract-tests`
   now consumes filtered claims, not a raw test file.
3. **Evaluation pass.** Re-run the `snapshot()` task as the
   regression. Gate: node 13 must pass on first attempt, every
   surviving claim must have non-empty grounding, and at least one
   claim per configured concern should ideally be present (warn, not
   fail). If the gate passes, flip Stage 3a GREEN with this PR as the
   evidence commit.

The verifier is the biggest single piece but it's a pure function with
trivial I/O — maybe 150 LOC plus tests. The prompt rewrite is mostly
deletion (the Assertion Rules section goes away, subsumed by the
protocol). The blueprint wiring is one new deterministic node.

Stage 3b prep (not this PR): seed `NormalizedContract` as a type stub
in `@bollard/detect` and open a tracking issue for per-language
extractor normalisation.

## Not in scope

- Per-language mutation testing (Stage 3c).
- Semantic review agent (Stage 3c).
- Extractor normalisation for Python/Go/Rust (Stage 3b).
- Streaming LLM responses (Stage 3c/4).
- Repair loop on malformed JSON (measure first).

## Why this is the right bet

The prompt-rule catalog treats each failure as a symptom to suppress.
The grounding protocol treats the failure mode as a shape and makes
that shape impossible to express. We add one deterministic check and
never write another "don't do X" bullet for the contract-tester again.
The language-agnostic framing is free: the protocol doesn't know what
language it's dealing with, and Layer 2 extends that to the input.

The cost is one pure function, a prompt rewrite, and one new blueprint
node. The Stage 3a GREEN flip comes with actual architecture behind
it, not a third patch on a growing pile.
