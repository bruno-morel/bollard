# Self-Test: CostTracker.multiply() — Validation Results

**Date:** 2026-05-23
**Run ID:** 20260523-2300-run-90d8e9
**Task:** Add multiply(factor: number): CostTracker to CostTracker

## Overall Result

| Metric | Value |
|--------|-------|
| Status | ✗ failure |
| Total cost | $1.66 |
| Duration | 397.4s |
| Nodes | 14/31 (failed at `verify-claim-grounding`) |
| Coder turns (successful attempt) | 33 |
| Coder turns (attempt 1, rolled back) | 53 |

Pipeline exited with `CONTRACT_TESTER_OUTPUT_INVALID` after the contract-tester agent hit `max_tokens` (4096 output tokens) and produced truncated JSON. The coder **implement** node succeeded on retry 2/2; downstream adversarial scopes did not complete.

## Token Economy

| Metric | Value | vs baseline |
|--------|-------|-------------|
| Total coder input tokens (both attempts) | 1,449,703 | — |
| Total coder output tokens (both attempts) | 14,045 | — |
| Avg input tokens/turn (both attempts) | 16,857 | prev: ~16,596 |
| Successful attempt input tokens | 488,249 | — |
| Successful attempt output tokens | 5,686 | — |
| Successful attempt avg input/turn | 14,795 | — |
| Forced-completion injected | no | — |
| Rollback occurred | yes | attempt 1 at turn 54 start (~$3.01 cumulative) |

**Coder attempt 1:** 53 turns, $3.01 cumulative agent cost, rollback before turn 54 completed (per-attempt cost cap). Spent ~40 turns writing exhaustive unit tests (20 cases) instead of minimal plan-scoped coverage.

**Coder attempt 2:** 33 turns, $1.55 implement-node cost, all verification hooks passed.

## Grounding Results

| Scope | Proposed | Grounded | Dropped | Drop rate |
|-------|----------|----------|---------|-----------|
| Boundary | 0 | 0 | 0 | — (parse fail: `BOUNDARY_TESTER_OUTPUT_INVALID`, truncated at 4096 tokens) |
| Contract | 0 | 0 | 0 | — (parse fail: `CONTRACT_TESTER_OUTPUT_INVALID`, truncated at 4096 tokens) |
| Behavioral | skipped | — | — | — (pipeline halted before extract-behavioral-context) |

Both boundary-tester and contract-tester stopped with `stop=max_tokens` and `output_tokens=4096`. Downstream write nodes were skipped (boundary) or the pipeline halted (contract).

## Signal 1 — Promotion Candidates

none — `approve-pr` gate never reached.

## Cost Regression

| Metric | Value |
|--------|-------|
| Baseline ceiling | $1.96 |
| This run cost | $1.66 |
| `cost-baseline diff` | insufficient data (0 successful implement-feature runs since baseline; failed run not counted) |

Run cost is under the $1.96 ceiling, but the run is not recorded as a successful baseline comparison.

## Test Suite

| Before run | After run |
|------------|-----------|
| 1126 passed / 6 skipped | 1143 passed / 6 skipped |

+17 tests from coder-written `multiply()` describe block in `cost-tracker.test.ts`. Lint clean post-run.

## Protocol Compliance

| Platform | Score |
|----------|-------|
| cursor | 5/5 |
| claude-code | 5/5 |

## Issues Found

1. **Pipeline failure — tester output truncation:** `boundary-tester` and `contract-tester` both hit the 4096 output-token ceiling on turn 1 (`stop=max_tokens`). JSON claim documents were truncated (`Unterminated string in JSON at position 12977` / `12768`), causing grounding parse failures. This is the primary blocker — not a grounding-quality regression but an output-budget regression for adversarial testers on a method-addition task with a large contract graph context (contract-tester input: 31,240 tokens).

2. **Coder rollback on attempt 1:** 53 turns burned ~$3.01 before per-attempt cost cap triggered rollback. Root cause: over-scoped test writing (20 test cases enumerating every edge case from plan `steps[].tests`) despite planner producing only 4 acceptance criteria (Phase 10 held on criteria count, but `steps[].tests` still enumerated permutations).

3. **Forced-completion did not fire:** Attempt 1 reached turn 52–53 without `[forced-completion]` injection in the log. Phase 9 runtime injection may not have triggered because the agent was still in tool-use loops without attempting completion JSON.

4. **Wasted tester spend:** $0.0233 (boundary) + $0.0517 (contract) = ~$0.075 on unusable truncated outputs.

5. **No static-checks / run-tests failures:** Both passed on the successful coder attempt.

## Observations vs Previous Runs

| Run | Cost | Coder turns | Nodes | Boundary | Contract | Notes |
|-----|------|-------------|-------|----------|----------|-------|
| 2026-05-18 runCount() | $0.88 | 19 | 31/31 ✓ | 11/11 | 5/8 | Baseline anchor |
| 2026-05-19 formatCost() | $1.63 | 32 | 31/31 ✓ | — | — | Tier 1 patcher validated |
| **2026-05-23 multiply()** | **$1.66** | **33** (86 total w/ rollback) | **14/31 ✗** | **0/0** | **blocked** | Tester max_tokens regression |

**Improvements:** Successful coder attempt (33 turns) is in line with format: formatCost() run (32 turns). Avg input tokens/turn on successful attempt (14,795) is **below** the ~16,596 baseline — Phase 8 context caps appear effective on retry.

**Regressions:**
- First pipeline failure since Stage 5a self-tests began completing 31/31
- Coder attempt 1 exceeded 35-turn watch threshold (53 turns) due to test over-scaffolding
- Adversarial testers unusable — new failure mode not seen in runCount()/formatCost() runs
- Signal 1 promotion path untested this run

## Recommended Follow-ups

1. **Raise tester max output tokens or add continuation turns** for boundary-tester and contract-tester when `stop=max_tokens` — truncated JSON is a hard pipeline stop for contract scope (boundary degrades gracefully; contract does not).

2. **Deterministic JSON repair / partial-claim recovery (ADR-0001 tier):** Attempt to salvage complete claims from truncated tester output before failing the pipeline.

3. **Contract context size guard:** contract-tester received 31,240 input tokens — consider pruning contract graph for single-method additions (similar to Stage 3a information-barrier closure).

4. **Coder scope guard tightening:** Attempt 1 wrote 20 unit tests for a 4-criteria plan. Prompt or hook should cap new test case count or defer exhaustive coverage to adversarial testers.

5. **Re-run self-test** after tester output-budget fix to validate full 31/31 GREEN and Signal 1 promotion surfacing for the multiply boundary test.

## Re-run: 2026-05-24 (post maxTokens fix)

**Run ID:** 20260524-2217-run-7f6185
**Status:** ✗ failure (10/31 — halted at `write-tests`)
**Total cost:** $2.49
**Duration:** 278.9s
**Coder turns:** 53 (method already existed — planner flagged verification-only; coder ignored scope guard)
**Implement node cost:** $2.40 (~241s)

**Context:** Re-verification run on code already merged to `main`. Planner correctly recognized `multiply()` as complete (`affected_files.modify: []`) but the coder still burned 53 turns verifying, briefly editing `errors.ts`, and creating a stray `test-multiply.ts` (reverted before completion).

### Grounding Results

| Scope | Proposed | Grounded | Dropped | Drop rate |
|-------|----------|----------|---------|-----------|
| Boundary | 13 | 13 | 0 | 0% |
| Contract | skipped | — | — | — (pipeline halted before contract nodes) |
| Behavioral | skipped | — | — | — |

Boundary-tester completed on turn 1 with `output_tokens=3098`, `stop=end_turn` (was `max_tokens` at 4096 on first run). **maxTokens fix validated for boundary scope.**

### Signal 1 — Promotion Candidates

none — `approve-pr` not reached (`write-tests` failed first).

### Cost Regression

`cost-baseline diff`: insufficient data (0 successful implement-feature runs since baseline). Run cost **$2.49** exceeds **$1.96** ceiling (+27%).

### Test Suite (post-run)

1143 passed / 6 skipped (unchanged).

### Token Economy

| Metric | Value |
|--------|-------|
| Coder input tokens | 769,564 |
| Coder output tokens | 6,373 |
| Avg input tokens/turn | 14,520 |
| Forced-completion injected | no |
| Rollback occurred | no |

### Conclusion

The **maxTokens fix resolved the truncation failure** — boundary-tester produced valid JSON (13/13 grounded, 0% drop). However, the re-run did **not** achieve 31/31. A new failure appeared at `write-tests`: `NODE_EXECUTION_FAILED: No affected files to generate tests for`. Root cause: planner set `affected_files.modify: []` (already implemented), so `extract-signatures` had no target files and `write-tests` could not derive a test path despite 13 grounded boundary claims. Contract, behavioral, mutation, review, and Signal 1 promotion were never exercised. Coder scope guard also regressed — 53 turns and $2.40 on a no-op task.

**Status updated (2026-05-24):** `write-tests` verification-only fallback shipped — infers source file from claim IDs / plan steps when `affected_files.modify` is empty; degrades to `skipped: true` instead of hard fail. Re-run of full 31/31 pipeline pending.

## Re-run: 2026-05-24 (post all fixes)

**Run ID:** `20260524-2344-run-794b98`
**Status:** ✓ success (**31/31** nodes completed; CLI `Result: ✓ success`)
**Total cost:** $0.43
**Duration:** 140.6s
**Coder turns:** 11
**Implement node cost:** $0.25 (~48.5s)

**Context:** Verification-only re-run after `write-tests` / `write-contract-tests` claim-inference fallbacks and `runTests` adversarial vitest routing (`vitest.adversarial.config.ts`). Planner: `affected_files.modify: []`. Coder confirmed existing `multiply()` implementation (11 turns, no rollback).

### Watched nodes

| Step | Node | Status | Notes |
|------|------|--------|-------|
| 11 | `run-tests` | **fail** (skipped) | Routed `packages/engine/tests/cost-tracker.adversarial.test.ts` via adversarial config (`RUN v3.2.4 /app`). **14/14 tests failed** — `new CostTracker()` without `limitUsd` (`Limit must be a non-negative finite number, got: undefined`). `onFailure: skip` — pipeline continued. |
| 10 | `write-tests` | ok | Log: `write-tests: inferred source file from claims (verification-only run)` — `inferredFile: packages/engine/src/cost-tracker.ts`, `firstClaimId: bnd1` |
| 16 | `write-contract-tests` | ok | Log: `write-contract-tests: inferred source file from claims (verification-only run)` — `inferredFile: packages/engine/src/cost-tracker.ts`, `firstClaimId: c1` (plan-step fallback; claim IDs use short `c1` form, not `ctr-Module`) |
| 17 | `run-contract-tests` | ok | `.bollard/tests/contract/add-a-multiply-factor-number-c/cost-tracker.contract.test.ts` — **4 passed / 0 failed** (479ms) |
| 21 | `write-behavioral-tests` | ok | Behavioral scope **disabled** in profile (`scopes.behavioral.enabled: false`); nodes 18–22 completed without hard-fail |
| 31 | `approve-pr` | ok | Auto-approved; **no Signal 1 promotion block** printed (semantic review listed 4 plan-divergence findings on infra/doc diff) |

### Grounding results

| Scope | Proposed | Grounded | Dropped | Drop rate |
|-------|----------|----------|---------|-----------|
| Boundary | 14 | 14 | 0 | 0% |
| Contract | 9 | 4 | 5 | 55.6% (`c2`, `c3`, `c4`, `c5`, `c8`) |
| Behavioral | — | — | — | scope disabled |

### Signal 1 — Promotion candidates

**none surfaced** at `approve-pr` — boundary adversarial file failed execution (0 passed); contract file passed (4/4) but no promotion candidate list appeared in gate output.

### Cost regression

| Metric | Value |
|--------|-------|
| Baseline ceiling | $1.96 |
| This run cost | $0.43 |
| vs prior multiply runs | −74% vs $1.66 (2026-05-23); −83% vs $2.49 (2026-05-24 pre write-tests fix) |

Well under ceiling; lowest multiply self-test cost to date.

### NODE_EXECUTION_FAILED

**none** — prior blockers (`write-tests`, `write-contract-tests` hard-fail) resolved.

### Fixes validated

1. **`write-tests` verification-only fallback** — inferred `cost-tracker.ts` from `bnd1` + plan steps; wrote adversarial file (3267 bytes).
2. **`write-contract-tests` verification-only fallback** — inferred same source; wrote contract file under `.bollard/tests/contract/...`.
3. **`runTests` adversarial routing** — vitest ran adversarial file (config correct); failures are **test-body quality** (missing constructor arg), not discovery/routing.

### Remaining issues (non-blocking for 31/31)

1. **`run-tests` adversarial test quality:** Boundary tester emits `new CostTracker()` without required `limitUsd` — all 14 adversarial cases fail. Follow-up: assembler preamble or boundary-tester prompt should pass a finite limit (e.g. `new CostTracker(100)`).
2. **Contract claim ID format:** Tester used `c1`…`c9` not `ctr-CostTracker-…` — inference still worked via plan-step fallback, not `ctr-` regex path.
3. **Stryker:** `run-mutation-testing` logged vitest runner plugin error; node ok with 0 mutants (scopedToFiles: false, affectedFileCount: 0).
4. **Signal 1:** Not exercised — no promotion candidates listed despite contract tests passing.

### Observations vs previous runs

| Run | Cost | Coder turns | Nodes | Boundary | Contract | Notes |
|-----|------|-------------|-------|----------|----------|-------|
| 2026-05-23 multiply() | $1.66 | 33 | 14/31 ✗ | 0/0 (truncation) | blocked | maxTokens |
| 2026-05-24 2217 | $2.49 | 53 | 10/31 ✗ | 13/13 | skipped | write-tests fail |
| 2026-05-24 2255 | — | — | 15/31 ✗ | — | — | write-contract-tests fail |
| **2026-05-24 2344 (post fixes)** | **$0.43** | **11** | **31/31 ✓** | **14/14** | **4/9** | Full pipeline; run-tests fail/skipped |

### Conclusion

**31/31 GREEN** for pipeline completion and verification-only fallbacks. Adversarial vitest routing confirmed. `run-tests` still records `fail` (test assertion/setup), not infra skip. Signal 1 and boundary test pass rate remain follow-ups.

## Re-run: 2026-05-25 (post extract-signatures plan-steps fallback)

**Run ID:** `20260525-0006-run-19742a`
**Status:** ✓ success (**31/31**)
**Total cost:** $0.39
**Duration:** 136.4s
**Coder turns:** 10

**Fix validated:** `extract-signatures` logged `source: plan-steps-fallback` for `packages/engine/src/cost-tracker.ts`; corpus included `constructor(limitUsd: number)`.

| Step | Node | Result |
|------|------|--------|
| 7 | `extract-signatures` | ok — `filesExtracted: 1` |
| 11 | `run-tests` | ok — **16 passed / 0 failed** (`cost-tracker.adversarial.test.ts`) |
| boundary grounding | — | 16/16 (0% drop) |

**Conclusion:** Verification-only multiply self-test is **fully GREEN** on adversarial execution — boundary tests use valid `new CostTracker(<limit>)` instantiation. Promoted multiply-focused adversarial tests committed to `packages/engine/tests/cost-tracker.adversarial.test.ts`.

## Forward Run: 2026-05-25 (clamp() — executor fix validation)

**Run ID:** `20260525-0038-run-ee973e`
**Status:** ✓ success (**31/31**)
**Task:** Add `clamp(min: number, max: number): CostTracker` method

**Context:** First full forward run (non-verification-only) after all infrastructure fixes from the multiply self-test series. Also validated the executor hard-exit `tool_use`/`tool_result` pairing fix. A prior clamp attempt (`20260525-0019-run-45addb`) failed at `messages[106]` with `400: tool_use id without matching tool_result` when the hard-exit fired at turn 53 and the executor pushed a plain string user message instead of stub `tool_result` blocks.

### Fix validated

**Executor pairing fix (`packages/agents/src/executor.ts`):** When `stopReason === "tool_use"` and the hard-exit fires, the follow-up user message is now a content block array:
- One stub `tool_result` per pending `tool_use` (matching `toolUseId`, `text: "[forced completion — ignoring tool result]"`)
- One `text` block with the existing `SYSTEM: You have N turns remaining…` instruction

Coder crossed turn 53 (the prior failure point) and completed at turn 54 with `stop=end_turn`. No `LLM_PROVIDER_ERROR`.

### Summary table (all multiply/clamp forward runs)

| Run | Cost | Coder turns | Nodes | Notes |
|-----|------|-------------|-------|-------|
| 2026-05-23 multiply() | $1.66 | 33 | 14/31 ✗ | maxTokens regression |
| 2026-05-24 2217 | $2.49 | 53 | 10/31 ✗ | write-tests fail |
| 2026-05-24 2255 | — | — | 15/31 ✗ | write-contract-tests fail |
| 2026-05-24 2344 | $0.43 | 11 | 31/31 ✓ | verification-only, run-tests fail/skip |
| 2026-05-25 0006 | $0.39 | 10 | 31/31 ✓ | verification-only, run-tests 16/16 ✓ |
| **2026-05-25 0038 (clamp)** | **—** | **54** | **31/31 ✓** | **forward run, executor pairing fix** |
