# Cursor Prompt — Bollard-on-Bollard Self-Test: CostTracker.summary()

> **Purpose:** Run Bollard's full 28-node `implement-feature` pipeline against itself to validate the complete stack (planner, coder, boundary/contract/behavioral testers, probe extraction, mutation testing, semantic review, docker verification) post Stage 4c Part 1.

---

## Context

You are working in the Bollard project — an artifact integrity framework for AI-assisted software development. **Read `CLAUDE.md` at the project root before doing anything else.** It is the single source of truth for architecture, conventions, and constraints.

Bollard is at Stage 4c Part 1 (684 tests passing, 28-node pipeline, all three LLM providers streaming). The goal is to run the full `implement-feature` pipeline against itself as a self-test.

---

## Task

Run the Bollard `implement-feature` pipeline with this task:

```
Add a summary() method to CostTracker that returns a human-readable string summarizing total cost, remaining budget, and the percentage consumed. The format should be: "$X.XX / $Y.YY (Z.Z% used)" where X is total, Y is limit, and Z is the percentage. When the budget is exceeded, append " [EXCEEDED]".
```

### How to run

**All commands go through Docker Compose. Never run bare pnpm/node/tsc on the host.**

```bash
docker compose run --rm -e BOLLARD_AUTO_APPROVE=1 dev sh -c \
  'pnpm --filter @bollard/cli run start -- run implement-feature \
    --task "Add a summary() method to CostTracker that returns a human-readable string summarizing total cost, remaining budget, and the percentage consumed. The format should be: \"\$X.XX / \$Y.YY (Z.Z% used)\" where X is total, Y is limit, and Z is the percentage. When the budget is exceeded, append \" [EXCEEDED]\"." \
    --work-dir /app'
```

**Required env:** `ANTHROPIC_API_KEY` must be in `.env` at the project root.

**BOLLARD_AUTO_APPROVE=1** auto-approves the human gates (plan approval and PR approval) so the pipeline runs unattended.

### What the pipeline will do (28 nodes)

1. Create a git branch `bollard/{runId}`
2. **Planner agent** explores the codebase, produces a JSON plan for the `summary()` method
3. Human gate (auto-approved) — approve plan
4. **Coder agent** implements the plan: modifies `packages/engine/src/cost-tracker.ts`, writes tests in `packages/engine/tests/cost-tracker.test.ts`
5. Static checks (typecheck, lint, audit)
6. Extract type signatures from changed files
7. **Boundary tester** generates adversarial tests probing edge cases (NaN, Infinity, empty state, exceeded state)
8. Write + run boundary tests
9. Assess contract risk (checks if exported symbols changed)
10. **Contract tester** generates contract-scope tests from the module graph
11. Verify contract claim grounding
12. Write + run contract tests
13. **Behavioral tester** generates behavioral-scope tests (if endpoints detected)
14. Verify behavioral claim grounding
15. Write + run behavioral tests
16. **Extract probes** from behavioral claims (deterministic, ADR-0001 pattern)
17. Run mutation testing (Stryker on changed files)
18. Generate review diff
19. **Semantic reviewer** reviews the diff
20. Verify review grounding
21. Docker-isolated verification
22. Generate final diff
23. Human gate (auto-approved) — approve PR

### What to check when it finishes

1. **All 28 nodes should pass.** If any fail, check the error and fix. Common issues:
   - Coder might exhaust 60 turns on overly complex changes — the task is small enough this shouldn't happen
   - Static checks might fail on Biome formatting — the coder should run `biome check --fix`
   - Boundary tests might include false-positive tests that don't match the actual API

2. **Tests should still pass:** Run `docker compose run --rm dev run test` after — the new `summary()` method and its tests should integrate cleanly with the existing 684 tests.

3. **Review the generated adversarial tests** in `.bollard/tests/`:
   - `boundary/` — should test edge cases like `summary()` on a fresh tracker (0%), at exactly the limit (100%), over the limit (EXCEEDED)
   - `contract/` — should test the `summary()` method's relationship with `add()`, `subtract()`, `reset()`
   - Check that no tests reference private fields (`_total`, `_limit`) — the information barrier should prevent this

4. **Check the probe extraction** — if behavioral claims reference any endpoint, probes should appear in `.bollard/probes/`. For a pure library method like `summary()`, there may be zero probes (that's correct).

5. **Check cost** — typical self-test costs ~$1-2 with Claude Sonnet. The pipeline prints a cost summary at the end.

### The target file

`packages/engine/src/cost-tracker.ts` — current public API:

```typescript
export class CostTracker {
  constructor(limitUsd: number)
  add(costUsd: number, ctx?: PipelineContext): void
  subtract(usd: number): void
  total(): number
  exceeded(): boolean
  remaining(): number
  reset(): number
  snapshot(): Readonly<{ totalCostUsd: number }>
  // NEW: summary(): string
}
```

The `summary()` method is a pure function of internal state — no side effects, no async, no dependencies. It should be straightforward for the coder agent.

### After the run

1. Save the output log — it shows per-node timing, cost, and status
2. Run the full test suite: `docker compose run --rm dev run test`
3. If everything is green, the self-test validates the full Stage 4c Part 1 stack
4. Check `git diff main` to see exactly what the pipeline produced
5. Clean up: `git checkout main && git branch -D bollard/{runId}`

### Known gotchas from past bollard-on-bollard runs

(From `memory/project_bollard_on_bollard_findings.md`)

- **Coder file rewrites:** The coder agent sometimes rewrites entire files instead of using `edit_file`. If `cost-tracker.ts` is fully rewritten and loses formatting, that's a known issue.
- **Shallow type extraction:** The extractor might not capture `Readonly<{ totalCostUsd: number }>` correctly. The boundary tester works around this by testing behavior, not types.
- **Profile detection:** `--work-dir /app` should detect TypeScript/pnpm correctly. If the profile shows wrong detection, check `docker compose run --rm dev --filter @bollard/cli run start -- verify --profile`.

---

## Success Criteria

The bollard-on-bollard self-test is **GREEN** when:

- 28/28 pipeline nodes pass
- `summary()` method is correctly implemented with the specified format
- Full test suite passes (684 + new tests)
- No information barrier violations (no private field references in adversarial tests)
- Typecheck + lint clean
