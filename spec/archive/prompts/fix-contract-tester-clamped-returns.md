# Cursor Prompt — Fix: Contract-Tester Generating Invalid Assertions for Clamped Return Values

> **Context:** The withLimit() self-test (2026-05-25, run `20260525-2025-run-ecae8e`) halted
> at node 17 (`run-contract-tests`) because the contract-tester generated assertions like
> `expect(tracker.withLimit(5).remaining()).toBe(-10)`. This is impossible: `remaining()`
> returns `Math.max(0, limit - total)` — it is always ≥ 0. The same issue also produced
> 2/15 failing boundary tests (expecting negative remaining).
>
> **Root cause:** The contract-tester (and boundary-tester) sees only the public signature
> `remaining(): number` and infers that any `number` return is valid, including negatives.
> The implementation detail `Math.max(0, ...)` is invisible to the tester agents.
>
> **Fix:** Add JSDoc comments to `remaining()` and `exceeded()` in `CostTracker` that
> explicitly state the clamped/bounded return semantics. These comments will be included in
> the extracted signatures that the tester agents receive — they will then know not to assert
> `remaining() < 0` or expect `exceeded()` to return anything other than `boolean`.
>
> This is a **documentation-only fix to a source file** — no logic changes, no new methods,
> no new tests required. The fix is 4 JSDoc comment lines total.

---

## Files to Modify

**Only one file:** `packages/engine/src/cost-tracker.ts`

---

## Exact Changes

### 1. Add JSDoc to `exceeded()`

**Before:**
```typescript
  exceeded(): boolean {
    return this._total > this._limit
  }
```

**After:**
```typescript
  /** Returns `true` if the accumulated total exceeds the limit; always a `boolean`. */
  exceeded(): boolean {
    return this._total > this._limit
  }
```

### 2. Add JSDoc to `remaining()`

**Before:**
```typescript
  remaining(): number {
    return Math.max(0, this._limit - this._total)
  }
```

**After:**
```typescript
  /** Returns the budget remaining (limit minus total). Always ≥ 0; never negative. */
  remaining(): number {
    return Math.max(0, this._limit - this._total)
  }
```

---

## Verification

After making these two changes:

```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

Expected: typecheck clean, lint clean, test count unchanged (no new tests — this is a docs-only fix).

---

## Why This Works

The `@bollard/verify` `TsCompilerExtractor` extracts method signatures by reading the TypeScript compiler's symbol table, which includes JSDoc comments as part of the "documentation" attached to each symbol. These doc strings are included in `ExtractionResult.signatures[]` and flow into `buildTesterMessage()`. When the contract-tester and boundary-tester receive the message, they see:

```
remaining(): number
/** Returns the budget remaining (limit minus total). Always ≥ 0; never negative. */
```

and will not generate `expect(tracker.remaining()).toBe(-10)`.

---

## What NOT to Do

- Do NOT add any new methods.
- Do NOT change any implementation logic.
- Do NOT add unit tests (the JSDoc doesn't change behavior — there's nothing new to test).
- Do NOT touch any other files.

---

## Commit

```bash
git add packages/engine/src/cost-tracker.ts
git commit -m "docs: add JSDoc to remaining() and exceeded() — always ≥ 0 / always boolean"
git push origin main
```
