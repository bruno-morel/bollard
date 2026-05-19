# Cursor Prompt — Stage 5d Phase 10: Planner Prompt Plan Compression

> **Context:** The 2026-05-15 Phase 9 validation run (run id `20260515-0350-run-75c385`, `snapshotTotal(): number` task) achieved 31/31 nodes, $2.5592, zero rollbacks — but 47 coder turns vs the < 40 VALIDATED target. Root cause: the planner generated 9 acceptance criteria for a 3-line method, enumerating every state permutation ("returns correct value after add()", "after subtract()", "after reset()", "after divide()", "after multiple calls"...). The coder dutifully scaffolded a test assertion for each criterion, spending ~40 of 47 turns on test-writing.
>
> **This is a prompt-only change.** No code changes required. Edit `packages/agents/prompts/planner.md` only.

---

## What to change

### Rule 2 — acceptance_criteria count cap

Find Rule 2 in `packages/agents/prompts/planner.md`:

```
2. Acceptance criteria must be TESTABLE. Not "improve performance" but "response time for /api/users is under 200ms for 100 concurrent requests."
```

Replace with:

```
2. Acceptance criteria must be TESTABLE. Not "improve performance" but "response time for /api/users is under 200ms for 100 concurrent requests." Keep the list to 3–5 criteria. Do NOT enumerate every method interaction ("returns correct value after add()", "returns correct value after subtract()", "returns correct value after reset()" — these are test-implementation details, not criteria). One criterion like "returns the current accumulated total without modifying state" covers all of them. Mutation coverage is the test agent's job, not the plan's.
```

### Rule 9 — steps[].tests conciseness

Find the end of Rule 9 (the `runtimeConstraints` rule) and append:

```
Keep `tests` descriptions concise: name the properties to verify (e.g., "returns current total without side effects; idempotent under repeated calls"), not every permutation of states to test.
```

---

## Why these two locations

- **Rule 2** is where the planner decides how many acceptance criteria to generate. The old wording had no count constraint and implicitly encouraged completeness ("must be testable" → "cover every case"). The new wording gives an explicit ceiling and a concrete negative example drawn from the actual failure.

- **Rule 9 (`steps[].tests`)** is where the planner writes the test description that the coder treats as a specification. In the failing run, `steps[0].tests` listed 5 verification scenarios in full prose, which the coder interpreted as 5 mandatory test functions. The conciseness constraint redirects from enumeration to property naming.

---

## Validation

```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

Expected: clean typecheck, clean lint, test count unchanged (no code changed).

Then re-run the validation pipeline:

```bash
set -a && source .env && set +a
./scripts/bollard-metrics-run.sh "Add a snapshotTotal(): number method to CostTracker that returns the same value as total() at the moment of the call, without modifying any state. No parameters. Do not modify any existing methods or tests."
```

**VALIDATED criteria:**
- Cost < $3.00
- Coder turns < 40 (combined across all attempts)
- No rollback
- 31/31 nodes

With 3–5 acceptance criteria instead of 9, the coder should write 3–5 test cases and finish in ~28–35 turns on this task.

---

## Constraints

- Do not change any other rule in `planner.md`.
- Do not change `runtimeConstraints` semantics — that field is important for the boundary-tester agent.
- Do not lower `maxTurns` or touch executor constants — Phase 8 constants are validated and correct.
