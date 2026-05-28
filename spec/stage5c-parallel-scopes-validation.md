# Stage 5c — Parallel Scope Execution Validation

**Date:** 2026-05-27 (infrastructure) / 2026-05-28 (live self-test)  
**Status:** **GREEN** ✅ — infrastructure + Bollard-on-Bollard self-test both passing

## Summary

Parallel node groups allow independent blueprint branches to run concurrently while sharing `PipelineContext.results` (disjoint node IDs per branch). Branches are joined with **`Promise.allSettled`** (not `Promise.all`) so one branch throwing or failing does not cancel siblings; `onBranchFailure: "skip"` is evaluated only after every branch settles.

## Changes

| Area | Detail |
|------|--------|
| `packages/engine/src/blueprint.ts` | `BlueprintNodeGroup`, `BlueprintEntry`, `flattenBlueprintNodes`, `countBlueprintSteps`, `isParallelGroup` |
| `packages/engine/src/runner.ts` | `runBlueprintNode`, `executeParallelGroup`, `group_start` / `group_complete` progress events |
| `packages/blueprints/src/implement-feature.ts` | Two groups: `scope-extraction`, `scope-chains` |
| `packages/cli/src/index.ts` | CLI progress for parallel groups |
| `packages/cli/src/history-record.ts` | `extractNodeSummaries` uses flattened leaf nodes |

## Pipeline shape

- **Top-level steps:** 17 (was 31 sequential entries)
- **Leaf nodes:** 31 (unchanged semantics)
- **Groups:** `scope-extraction` (3 branches), `scope-chains` (3 branches), both `onBranchFailure: "skip"`

## Baseline (pre-change)

| Check | Result |
|-------|--------|
| Tests | 1336 passed / 6 skipped |
| Typecheck | clean |
| Lint | clean |

## Post-change (2026-05-27)

| Check | Result |
|-------|--------|
| Tests | **1347** passed / 6 skipped |
| Typecheck | clean |
| Lint | clean |
| New tests | +11 (runner parallel groups + blueprint helpers) |

## Unit validation highlights

- Duplicate node IDs across branches → `NODE_EXECUTION_FAILED` before execution
- `onBranchFailure: "skip"` continues pipeline; `"stop"` fails run
- Per-node `onFailure: "skip"` honored inside branches
- Branch timing test: two 80ms nodes complete in &lt;140ms wall time (concurrent)
- `flattenBlueprintNodes` order: extraction branches then chain branches

## Live pipeline self-test — GREEN ✅

**Run ID:** `20260528-0353-run-f616b1`  
**Date:** 2026-05-28  
**Task:** `Add CostTracker.reset(): void method that sets _total back to 0`  
**Result:** CLI success — **17/17** top-level steps complete

### Metrics

| Metric | Value |
|--------|-------|
| Total cost | $3.3844 |
| Duration | 348s |
| Coder turns | 36 |
| Boundary grounding | 12/12 (drop 0%) |
| Contract grounding | 0/8 (short claim IDs c1–c8; fallback fires — known issue) |
| Stryker | `stryker_no_mutants` (Babel parse error on syntax artifact in cost-tracker.ts) |

### Parallel execution confirmed

**Group 1 `scope-extraction` `[7/17]`:** three branches ran concurrently:
- `extract-signatures` → ✓ 36ms
- `assess-contract-risk` + `extract-contracts` → ✓ 235ms / 419ms
- `extract-behavioral-context` → ✓ (behavioral scope disabled)
- Group wall time: **655ms** (sequential would have been ~700ms)

**Group 2 `scope-chains` `[8/17]`:** all three adversarial agents started simultaneously:
- `[boundary-tester] turn 1/5 starting` — concurrent with contract and behavioral
- `[contract-tester] turn 1/10 starting` — concurrent
- Behavioral chain completed before LLM agents (no behavioral context)
- Group wall time: **11.8s** (sequential would have been ~23s+)

### Notes

- Coder turns elevated (36) due to `cost-tracker.test.ts` edit loop — existing test had `const previousTotal = tracker.reset()` pattern; scope guard blocked edits mid-run after 3 failed verification attempts.
- `static-checks` failed (skipped per `onFailure: skip`) — typecheck caught missing `}` to close `remaining()` before `reset()` in the generated source. Stryker hit the same Babel parse error.
- `ls` was not in the allowlist at run time (turn 16 error); fix committed post-run (`fix: add ls to DEFAULT_ALLOWED_COMMANDS`).
