# Stage 3b — Checkpoint: `implement-feature` sanity re-run

> **Scope:** re-run the Stage 3a GREEN self-test against the same `CostTracker.subtract()` task after workstreams 1–4 to confirm no regression. **Read-only validation.** Do not commit any pipeline artifacts; clean them up at the end.

## Why now

Stage 3b has changed four things that touch the `implement-feature` pipeline, none of which were individually risky but whose combination has not been exercised end-to-end:

1. **Dev image rebuild** (WS1): helper binaries `bollard-extract-go` and `bollard-extract-rs` are now on PATH in `dev`. Neither is used by the TypeScript target, but the image rebuild could surface layer-ordering or PATH regressions.
2. **Go extractor rewrite** (WS2): `GoAstExtractor` is now helper-backed. Not on the TS path, but `getExtractor` is — any routing drift would show up here.
3. **Rust extractor rewrite** (WS3): same rationale as Go. `RustSynExtractor` replaces the regex stub and is now the class returned by `getExtractor("rust", ...)`.
4. **Contract provider refactor** (WS4): `buildContractContext` is now a router over `PROVIDERS`, and the TypeScript logic lives in a private `TypeScriptContractProvider`. Byte-identical output was verified for the `contract` CLI command, but the full `implement-feature` pipeline was not re-run.

The Stage 3a GREEN baseline (2026-04-08, commit history in CLAUDE.md) is the known-good reference. Any deviation is a regression.

## The known-good baseline

From CLAUDE.md "Stage 3a Validation (2026-04-08) — Status **GREEN**":

- Task: `CostTracker.subtract()` — add a subtract-USD method to `CostTracker`
- Pipeline: 17/17 nodes passed on first attempt, no retries (note: post-validation the blueprint grew to 18 nodes with the `assess-contract-risk` skeleton; expect 18/18 today)
- `verify-claim-grounding`: 5 claims proposed / 5 grounded / 0 dropped
- Test suite before → after: 406 → 461 passed (+55 from the generated tests)
- Surviving contract tests in `.bollard/tests/contract/add-a-subtract-usd-method/cost-tracker.contract.test.ts`

Today's starting test count is **486 passed / 2 skipped** (post-WS4). The sanity run should land on `486 + N passed / 2 skipped` where `N` is whatever the contract-tester ends up generating this time. `N` is not expected to match the Stage 3a number exactly — LLM temperature makes it non-deterministic — but it should be in the same order of magnitude (single- to low-double-digit tests).

## Procedure

### 1. Clean slate

```bash
# Make sure there is no leftover CostTracker.subtract() state from prior runs.
git status
# If anything in packages/engine/src/cost-tracker.ts or .bollard/ is dirty, stash or reset.
```

### 2. Rebuild dev image

```bash
docker compose build dev
```

Confirms WS1's helper binaries are baked in. Should be a warm build — only workstream-2/3/4 TypeScript changes should invalidate layers.

### 3. Run the self-test

Use the exact command from the Stage 3a GREEN validation, with the same task wording:

```bash
docker compose run --rm -e BOLLARD_AUTO_APPROVE=1 dev sh -c \
  'pnpm --filter @bollard/cli run start -- run implement-feature --task "Add a subtract(amount: number) method to CostTracker that subtracts the given USD amount from the running total. Throw on negative input or underflow. Include basic validation and update snapshot() to reflect the subtracted cost." --work-dir /app'
```

The `sh -c` wrapper is mandatory (Compose v2 intercepts bare `--filter`). `BOLLARD_AUTO_APPROVE=1` skips the two human gates (approve-plan, approve-pr) so the run is non-interactive.

### 4. Capture the outcome

Report back these exact numbers:

- **Node count:** expect 18/18 passed (or whatever the current blueprint length is — run `docker compose run --rm dev --filter @bollard/cli run start -- contract` is not relevant here; the number comes from the pipeline progress output).
- **Retries:** expect 0. Any retry is worth noting even if the pipeline eventually goes green.
- **Grounding:** `verify-claim-grounding` should report `N claims proposed / M grounded / N-M dropped`. Report all three. Drop rate > 0 is not a failure — it's the filter working — but a drop rate of 100% (`CONTRACT_TESTER_NO_GROUNDED_CLAIMS`) is.
- **Test suite after:** run `docker compose run --rm dev run test` after the pipeline finishes. Expect `486 + N passed / 2 skipped` with the generated contract test file included.
- **Surviving contract tests:** `ls .bollard/tests/contract/add-a-subtract-usd-method/` and report the filename + line count.
- **Cost:** grand total USD from the final pipeline summary.
- **Duration:** wall-clock from start to finish.

### 5. Clean up

```bash
# Reset the branch (implement-feature creates bollard/{runId})
git checkout main
git branch -D bollard/<runId>   # whatever the run ID was

# Remove generated artifacts
rm -rf .bollard/tests/contract/add-a-subtract-usd-method/
git checkout -- packages/engine/src/cost-tracker.ts packages/engine/tests/cost-tracker.test.ts

# Confirm clean
git status
```

**Do not commit anything.** This is a read-only sanity check. The goal is to confirm the pipeline still works; any generated code from this run is throwaway.

## What "GREEN" looks like this time

- 18/18 nodes passed (or whatever the current count is), 0 retries
- `verify-claim-grounding` reports at least 1 surviving claim
- Test suite goes from 486 → some number > 486 and comes back to 486 after cleanup
- No `BollardError` exceptions in the pipeline log
- No references to `bollard-extract-go` or `bollard-extract-rs` in the log (this is a TypeScript target — the helpers must not be invoked)

## What a regression looks like

Report any of the following:

- Any node failure that requires retry or `hand_to_human`
- `CONTRACT_TESTER_NO_GROUNDED_CLAIMS` or `CONTRACT_TESTER_OUTPUT_INVALID`
- `PROVIDER_NOT_FOUND` errors anywhere in the log
- Contract context empty when it shouldn't be (check the `extract-contracts` node output)
- Coder exhausting the turn budget (>80% of 60 turns)
- Test suite count != 486 after cleanup (means something leaked)
- Any error mentioning `bollard-extract-go` or `bollard-extract-rs` on a TypeScript target (means `getExtractor` routing is wrong)

If any of the above happen, **do not proceed to workstream 5**. Stop, report, and let me triage.

## Out of scope

- Running the pipeline against a Python, Go, or Rust target. Those are workstreams 10 (validation runs against non-TS targets), not this checkpoint. The Python/Go/Rust extractors are exercised only at the unit-test level until their contract graph providers land (workstreams 5/6/7).
- Any code changes. If you find a regression, stop and report — don't try to fix it inside this sanity run.
- Updating CLAUDE.md with new validation numbers. Wait for the full Stage 3b validation at workstream 10.

## Reporting back

Fill in this template:

```
Sanity re-run: Stage 3b checkpoint (post WS1-4)
Target: CostTracker.subtract() (Stage 3a baseline)

Nodes:      X/X passed, Y retries
Grounding:  N proposed / M grounded / N-M dropped
Tests:      486 → 486+K → 486 (after cleanup)
Contract:   .bollard/tests/contract/add-a-subtract-usd-method/<file>, L lines
Cost:       $X.XX
Duration:   Ym Ws
Helpers:    bollard-extract-go invoked: yes/no
            bollard-extract-rs invoked: yes/no
Regressions: none / <list>
```
