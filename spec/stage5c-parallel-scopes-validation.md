# Stage 5c — Parallel Scope Execution Validation

**Date:** 2026-05-27  
**Status:** Infrastructure **GREEN** (unit + integration tests). Full Bollard-on-Bollard pipeline self-test deferred (requires `ANTHROPIC_API_KEY` + ~$1–5 run).

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

## Live pipeline self-test (optional)

```bash
docker compose run --rm -e BOLLARD_AUTO_APPROVE=1 dev sh -c \
  'pnpm --filter @bollard/cli run start -- run implement-feature \
    --task "Add CostTracker.reset(): void method that sets _total back to 0" \
    --work-dir /app'
```

**Success criteria:** CLI success; **17/17** top-level steps; `history show` lists **31** leaf nodes; overlapping timestamps for `generate-tests`, `generate-contract-tests`, and `generate-behavioral-tests` during `scope-chains`.

Record run id, cost, and wall-time delta vs a pre-5c run here when executed.
