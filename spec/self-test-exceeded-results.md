# Self-Test: CostTracker.exceeded() — Phase 18c Validation

**Run ID:** `20260527-0353-run-f157de`  
**Date:** 2026-05-27  
**Task:** Add `CostTracker.exceeded(): boolean` method that returns true when `_total > _limit`  
**Purpose:** Validate Phase 18c `blockedTestPaths` guard (block `run_command` on write-once test files)

## Result: RED (Phase 18c not exercised)

Pipeline CLI **success** (31/31), but this was a **degenerate cap-style verification run** — the planner and coder treated the task as a no-op because `exceeded()` already exists and is covered in `cost-tracker.test.ts`. Phase 18c requires a `write_file` on a new `*.test.ts` followed by a blocked test `run_command`; neither occurred.

| Metric | Value | Target |
|--------|-------|--------|
| Nodes completed | 31/31 | 31/31 |
| Coder turns | 5 | < 15 |
| Total cost | $0.21 | < $1.00 (informational) |
| Phase 18c fired | **NO** | YES |
| `write-once guard` error in log | **NO** | YES |
| `cost-tracker-exceeded.test.ts` written | **NO** | YES (for full validation) |

## Why Phase 18c did not fire

### Plan shape (approve-plan)

```json
"affected_files": {
  "modify": [],
  "create": [],
  "delete": []
}
```

Planner rationale: method already at `cost-tracker.ts` lines 62–64; tests already in `cost-tracker.test.ts`. Explicit `non_goals` included **"Do NOT add new test files; existing tests are comprehensive"** — contradicts Rule 11 for Stryker-dedicated unit test files when the task wording is "Add … method".

With `modify: []`, `injectUnitTestIfMissing()` in `agent-handler.ts` does not inject `cost-tracker-exceeded.test.ts` (early return when `modifyFiles.length === 0`).

### Coder behavior (implement, 5 turns)

| Turn | Tool | Notes |
|------|------|-------|
| 1 | `search` | `exceeded()` in `packages/engine/src` |
| 2 | `read_file` | `cost-tracker.ts` lines 60–69 |
| 3 | `search` | `exceeded()` in tests |
| 4 | `read_file` | `cost-tracker.test.ts` lines 55–79 |
| 5 | `read_file` | `cost-tracker.ts` line 65 | 
| 6 | `end_turn` | Completion JSON: `files_created: []`, `tests_added: 0` |

No `write_file`, no `run_command` on a new test path — Phase 18b/18c guards never engaged.

### Log evidence

```bash
grep -F "write-once guard" .bollard/last-exceeded-run.log
# (no matches)
```

## Pipeline outcomes (still useful signal)

| Scope | Proposed | Grounded | Dropped | Drop rate |
|-------|----------|----------|---------|-----------|
| Boundary | 10 | 9 | 1 | 10% |
| Contract | 4 | 1 | 3 | 75% |

- **Mutation:** Stryker `stryker_no_mutants` (300s timeout path; 0 mutants — no source diff scoped to `cost-tracker.ts`)
- **Semantic review:** 1 error finding (`plan-divergence`) — adversarial test file churn vs plan "no changes"
- **Branch diff vs main:** `cost-tracker.adversarial.test.ts` rewrite + `stryker.config.json` tweak only (no dedicated unit test file)

## Node timeline (`bollard history show`)

```
Run:       20260527-0353-run-f157de
Status:    success
Cost:      $0.21 | Duration: 6m 30s
Branch:    bollard/20260527-0353-run-f157de

Implement Code               39s      $0.11  5t
Generate Plan                14s      $0.03  2t
Mutation Testing             300s     (stryker_no_mutants)
```

## Conclusion

**RED for Phase 18c validation:** Infrastructure on `main` is unchanged and unit-tested in `tools.test.ts`; this live pipeline run **did not** exercise `blockedTestPaths` because the planner/coder correctly (for a no-op task) avoided creating `cost-tracker-exceeded.test.ts`.

### Recommended re-run to achieve GREEN

Force Rule 11 / inject path so the coder must write the dedicated test file:

1. **Task wording** that implies net-new work without claiming the method is missing, e.g. *"Add unit test file `packages/engine/tests/cost-tracker-exceeded.test.ts` for the existing `CostTracker.exceeded()` method"* — or
2. **Pre-merge** only the empty test file stub on a forward branch so the planner lists it in `create`, or
3. **Planner prompt** clarification: verification-only re-runs for existing methods still require Rule 11 `create` entry for `<basename>-<method>.test.ts` even when implementation exists (for Stryker + Phase 18c guard validation).

Contrast: **floor** run `20260527-0259-run-2b1364` wrote `cost-tracker-floor.test.ts` once but hit **23 turns** from repeated `run_command` **before** Phase 18c — the guard this run was meant to validate.

## Artifacts

- Full log: [`.bollard/last-exceeded-run.log`](../.bollard/last-exceeded-run.log)
- Prompt (not archived — RED): [spec/prompts/self-test-exceeded.md](prompts/self-test-exceeded.md)
