# Review grounding spot-check (fixture replay)

Deterministic replay after corpus broadening (`task`, `non_goals`, `affected_files`, `sourceContents`).
Human gate: every newly-kept finding below must describe a **real** issue visible in the fixture diff/plan.

## 20260620-0352-run-1238f9 (usedFraction) — newly kept

### r1 | error | plan-divergence

**Finding:** Plan requires dedicated `cost-tracker-usedFraction.test.ts`; diff rewrites `cost-tracker.adversarial.test.ts` and removes breakdown() tests.

**Quote:** `Do not modify existing test files (cost-tracker.test.ts, cost-tracker-*.test.ts)`

**Matched in plan corpus:** `non_goals` entry in fixture plan.

**Verdict:** Real plan divergence — adversarial file rewritten instead of new unit test file.

### r3 | warning | unintended-change

**Finding:** 165 lines of breakdown() adversarial tests removed without plan step to deprecate breakdown().

**Quote:** `-it('breakdown returns object with exactly five properties', () => {`

**Matched in diff:** `-it('breakdown returns object with exactly five properties', () => {`

**Verdict:** Real unintended test churn — breakdown coverage removed.

## 20260620-0355-run-3a278e (headroom) — newly kept

### r1 | error | plan-divergence

**Finding:** Plan creates `cost-tracker-headroom.test.ts` but diff modifies `cost-tracker.adversarial.test.ts`.

**Quote:** `"create": [\n      "packages/engine/tests/cost-tracker-headroom.test.ts"\n    ]`

**Matched in plan corpus:** `affected_files` JSON block.

**Verdict:** Real plan divergence.

### r2 | error | plan-divergence

**Finding:** Adversarial test file replaced; plan non_goals forbid modifying existing test files.

**Quote:** `Do NOT modify existing test files (cost-tracker.test.ts, cost-tracker-*.test.ts) — only create the new dedicated test file`

**Matched in plan corpus:** `non_goals` entry.

**Verdict:** Real plan divergence.

### r3 | warning | unintended-change

**Finding:** Temporary review-grounding capture block added to `implement-feature.ts` outside plan scope.

**Quote:** `// Temporary capture for review-grounding corpus diagnosis — remove after fixture freeze`

**Matched in diff:** `+          // Temporary capture for review-grounding corpus diagnosis — remove after fixture freeze`

**Verdict:** Real unintended change (capture-run artifact; not shipped in final code).

### r4 | warning | unintended-change

**Finding:** `.bollard/.gitignore` updated with `review-grounding-capture/` — not in plan.

**Quote:** `+review-grounding-capture/`

**Matched in diff:** `+review-grounding-capture/`

**Verdict:** Real unintended change (capture-run artifact; not shipped in final code).

## Sign-off

All newly-kept findings above describe demonstrable issues in the captured diff/plan. No hallucinations admitted by corpus broadening.
