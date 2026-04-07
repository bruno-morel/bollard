# Contract-tester repro: floating-point equality blind spot

## Date
2026-04-07

## Source run
- Branch: `bollard/20260407-2300-run-9096`
- Task: "Add a reset() method to CostTracker that zeros the accumulated cost
  and returns the previous total."
- Pipeline: 13/16 nodes executed; halted at `run-contract-tests`
- Total cost: $0.54 (plan $0.08 · implement $0.37 · boundary $0.03 · contract $0.06)

## Symptom
5 of 6 generated contract tests passed. The sixth — "precision across reset
cycles" — used strict equality on a sum that is not representable in IEEE 754:

    expect(0.1 + 0.2).toBe(0.3)
    // Received: 0.30000000000000004

This halted the pipeline despite the implementation being correct and all
unit tests (including the 9 new `reset()` tests) passing.

## Why this matters
The contract-tester's job is to probe the *contract* of the new symbol —
here, "reset() returns the previous accumulated total and zeros state."
The failing test conflated that contract with a stronger, false claim:
that floating-point addition is associative and exact. The implementation
never promised that, and no reasonable reading of the signature implies it.

This is the Stage 3a YELLOW item: the contract-tester sometimes generates
assertions that encode the model's prior beliefs about arithmetic rather
than the actual contract surface derived from signatures + types.

## Proposed prompt delta (for the next contract-tester iteration)
Add an explicit rule to `packages/agents/prompts/contract-tester.md`:

> When asserting on any numeric quantity produced by addition, subtraction,
> multiplication, or division of non-integers, use `toBeCloseTo` (or the
> target framework's equivalent) with an explicit precision, never `toBe`.
> Exact equality is only valid for integers, strings, booleans, and
> references.

This is cheap, specific, and directly regression-testable: rerun this
same task and assert the generated file contains no `toBe(` line whose
argument is a float literal.

## Retained artifact
The 5 passing contract tests were kept on the merged branch as a
regression net for `CostTracker.reset()`. The failing case was removed.

## Disposition
Implementation + unit tests merged to `main`. This file is the concrete
repro for the outstanding YELLOW prompt-quality item — the next
contract-tester prompt revision should be evaluated against it before
Stage 3a flips to GREEN.

---

## Follow-up: 2026-04-07 — `snapshot()` GREEN validation run (readonly vs `Object.freeze`)

### Source run
- Branch: `bollard/20260407-2333-run-ff8a6a`
- Run ID: `20260407-2333-run-ff8a6a`
- Task: `Add a snapshot() method to CostTracker that returns a readonly object { totalCostUsd: number } capturing the current accumulated cost without mutating state. Export it through the @bollard/engine public surface and cover it with a unit test.`
- Prompt evaluated: commit `a36233d` (`packages/agents/prompts/contract-tester.md` — **# Assertion Rules** section)
- Pipeline: nodes 1–12 OK; node 13 (`run-contract-tests`) **failed on first attempt**
- Total cost (aborted run): **$0.41** · duration **104.4s**

### Symptom
One of six generated contract tests expected assignment to `snapshot.totalCostUsd`
**not** to throw (`expect(() => { ... }).not.toThrow()`), with a comment claiming
runtime does not enforce readonly. The coder implementation used
`Object.freeze()`, so Vitest threw:

`TypeError: Cannot assign to read only property 'totalCostUsd' of object`

Five other contract cases passed, including float accumulation checks that used
`toBeCloseTo` (the Assertion Rules fix **did** address the original float-literal
`toBe` failure mode).

### GREEN gate outcome
- **Node 13 first attempt:** FAIL (does not meet GREEN criteria).
- **Grep** `toBe\([^)]*\.[0-9]` on the generated file: **no matches** after manual
  removal of the failing case (remaining file uses `toBe(0)` for integers only).
- **Stage 3a status:** remains **YELLOW**; do not flip to GREEN until node 13 passes
  on the first try with reviewer-acceptable contract tests.

### Retained artifact
The failing readonly/mutation case was **dropped**; five passing contract tests
were kept under `.bollard/tests/contract/add-a-snapshot-method-to-costt/`
alongside merged `CostTracker.snapshot()` implementation.

### Follow-up for prompt (do not widen scope here)
Teach contract-tester that **readonly / frozen snapshot objects** may throw on
mutation at runtime in strict engines, so tests should use `toThrow()` (or avoid
asserting mutation behavior) when the implementation is allowed to freeze.
