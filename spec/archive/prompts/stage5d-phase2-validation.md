# Cursor Prompt — Stage 5d Phase 2 Validation: Verification-Feedback Patcher

> **Context:** Phase 2 (verification-feedback patcher) is marked DONE in CLAUDE.md but "IN PROGRESS" in ROADMAP.md. The code is fully shipped (`feedback-patcher.ts`, `createVerificationHook` wired in `agent-handler.ts`) and unit-tested (11 tests in `feedback-patcher.test.ts`). What has never been validated is **live pipeline behavior**: does Tier 1 (`runDeterministicAutofix`) actually fire and eliminate a Biome lint failure before a frontier retry is spent on it?
>
> This prompt validates that claim, resolves the DONE/IN PROGRESS inconsistency, and produces a short validation record.
>
> **Read CLAUDE.md fully before doing anything.** No new features — this is a validation-only prompt.

---

## What the patcher does (orient yourself first)

`createVerificationHook` in `packages/cli/src/agent-handler.ts` (line ~145) runs after each coder completion:

1. Run all checks (`typecheck`, `lint`, `test`, `audit`, `secretScan`)
2. If any fail → **Tier 1**: run `biome check --write --unsafe` (deterministic autofix)
3. Re-run only the failed checks
4. If still failing → **Tier 2**: run `runLocalPatcher` (local model → unified diff → `patch --strip=1`)
   - Skipped when `localModelsConfig` is `undefined` — which is always the case unless `.bollard.yml` has a `localModels` block. The Bollard repo's own `.bollard.yml` does **not** have one, so Tier 2 always shows `[patcher] skipped: no local config` in real runs.
5. If still failing → return feedback string to frontier coder for retry

The claim to validate: **Tier 1 fires and eliminates Biome-fixable lint failures before any frontier retry is charged for them.** The stderr output pattern when it fires is:
```
  [verify] running lint...
  [verify] running lint...        ← re-run after autofix
  [patcher] skipped: no local config
  [verify] all checks passed
```
(The second `running lint...` line is the re-run after `biome check --write --unsafe`.)

---

## Step 1 — Confirm the hook is wired

```bash
grep -n "createVerificationHook\|postCompletionHook" packages/cli/src/agent-handler.ts | head -5
```

Expected: line ~545 shows `postCompletionHook: createVerificationHook(workDir, profile, config.localModels)`.

```bash
grep -n "runDeterministicAutofix\|biome.*write.*unsafe" packages/verify/src/feedback-patcher.ts | head -5
```

Expected: confirms `biome check --write --unsafe` is the Tier 1 command.

---

## Step 2 — Design the validation task

The task must cause the coder to introduce a **Biome-fixable lint violation** on its first implementation pass. The most reliable way: give it a task where adding the implementation naturally produces code that Biome will flag (trailing comma style, missing semicolons, import ordering, etc.).

The task chosen: **Add a `formatCost(decimalPlaces?: number): string` method to `CostTracker`** that returns the current total formatted as a dollar string (e.g., `"$1.23"`). This is a simple 2-line addition but the coder will produce it in a single write pass — and historically the coder's first-pass code has a ~30–40% chance of a Biome lint violation (import ordering, trailing commas, spacing) that Biome can auto-fix.

**If the coder happens to produce clean code on the first pass** (lint passes immediately), Tier 1 won't fire — that's also valid data. Record it as "Tier 1: not triggered (first-pass code was clean)".

Confirmed absent:
```bash
grep -n "formatCost" packages/engine/src/cost-tracker.ts
```
Expected: no output.

---

## Step 3 — Run the pipeline

```bash
./scripts/bollard-metrics-run.sh \
  "Add a formatCost(decimalPlaces?: number): string method to CostTracker that returns the current total formatted as a dollar amount string (e.g., \"\$1.23\" for 1.23). Default decimal places: 2. No parameters are required. Do not modify existing methods or tests."
```

Monitor until complete. Expected: 5–12 minutes, ~$0.50–$1.50 (simpler than runCount() since no counter field threading needed).

---

## Step 4 — Find Tier 1 evidence in the log

```bash
grep -n "\[verify\]\|\[patcher\]" .bollard/last-metrics-run.log | head -60
```

Look for the pattern that proves Tier 1 fired:
```
[verify] running lint...         ← first pass, lint failed
[patcher] skipped: ...           ← Tier 2 always skipped (no localModels in .bollard.yml)
[verify] running lint...         ← re-run after biome autofix
[verify] all checks passed       ← autofix resolved it
```

Or the pattern that shows first-pass lint was clean:
```
[verify] running lint...
[verify] all checks passed       ← no autofix needed
```

Also check for typecheck failures — those are NOT fixable by Biome (Tier 1 only handles lint). If typecheck failed, the hook correctly passes it through to the frontier coder.

---

## Step 5 — Extract coder turn count

```bash
grep "^BOLLARD_METRICS role=coder" .bollard/last-metrics-run.log | wc -l
```

If Tier 1 fired and resolved a lint failure, the coder should NOT have spent a retry turn on it — the turn count stays lower. Compare to the `runCount()` baseline of 19 turns.

---

## Step 6 — Check pipeline result

```bash
tail -1 .bollard/runs/history.jsonl | python3 -c "
import sys, json
r = json.loads(sys.stdin.read())
print('runId:', r.get('runId'))
print('status:', r.get('status'))
print('cost:', r.get('totalCostUsd'))
print('coder turns:', next((n.get('costUsd') for n in r.get('nodes',[]) if n['nodeId']=='implement'), 'n/a'))
"
```

---

## Step 7 — Run the test suite

```bash
docker compose run --rm dev run test 2>&1 | tail -5
```

Expected: `1077 passed, 6 skipped` baseline (or +N from pipeline-generated tests). Zero failures.

---

## Step 8 — Compile the validation record

Produce this report:

```
## Stage 5d Phase 2 Validation — Verification-Feedback Patcher
Run: <runId>
Date: <YYYY-MM-DD>
Status: <SUCCESS | FAILURE>
Total cost: $<X.XX>
Coder turns: <N> (baseline: 19 from runCount() run)

### Tier 1 (runDeterministicAutofix) — Biome autofix
Status: FIRED (lint failure fixed before frontier retry) | NOT TRIGGERED (first-pass code was clean) | BYPASSED (lint passed cleanly)

Evidence from log:
<paste the relevant [verify] / [patcher] lines>

### Tier 2 (runLocalPatcher) — Local model patcher
Status: SKIPPED (expected — no localModels block in .bollard.yml)
Reason: <paste the [patcher] skipped: ... line>

### Verification hook behavior
Checks run per hook invocation: typecheck, lint, test, audit, secretScan
Tier 1 resolved: <lint | nothing>
Tier 2 resolved: nothing (skipped)
Frontier retry triggered for: <typecheck | nothing | list any check that still failed>

### Key finding
<1–2 sentences: did the patcher behave as designed? Any surprises?>
```

---

## Step 9 — Resolve the DONE/IN PROGRESS inconsistency

After a successful run (pipeline status = SUCCESS), update two files:

**`spec/ROADMAP.md`** — find the Phase 2 entry:
```
- ~~**Verification-feedback patcher (Phase 2):**~~ **DONE (2026-05-12).** ...
```
If it currently says "IN PROGRESS" instead of "DONE", update it to match the CLAUDE.md entry (DONE, same description).

**`CLAUDE.md`** — the Stage 5d Phase 2 section (line ~936) already says DONE. Verify it's accurate. If the validation revealed any behavioral difference from what's documented (e.g., Tier 1 scope is narrower than documented), update the description.

No new self-test line needed in CLAUDE.md paragraph 9 — Phase 2 is infrastructure validation, not a new Bollard-on-Bollard pipeline run.

---

## Constraints

- Do NOT add `formatCost()` to `CostTracker` yourself — the pipeline coder must implement it.
- Do NOT add a `localModels` block to `.bollard.yml` to force-test Tier 2 — Tier 2 requires `dev-local` (llama.cpp binary) which is not in the `dev` image. Testing Tier 2 without the binary will just produce `LOCAL_MODEL_NOT_AVAILABLE` errors and add noise.
- If the pipeline exits non-zero, extract the failure node and error. Do NOT fix it here — report it.
- The Tier 1 validation is probabilistic: it only fires if the coder produces a Biome-fixable violation. If it doesn't fire this run, the test is still valid — report "not triggered" and note that the unit tests in `feedback-patcher.test.ts` cover the Biome autofix path directly.

---

## What "validation" means here

Phase 2's unit tests (`feedback-patcher.test.ts`) mock `execFile` and verify the patcher logic in isolation. What's never been confirmed in a live run:

1. `createVerificationHook` is actually called in a real pipeline run ✓ (it's wired at line ~545 of agent-handler.ts — this is deterministic)
2. The `[verify]` and `[patcher]` stderr lines actually appear in the log ← **this run confirms it**
3. Tier 1 eliminates a Biome violation before a frontier retry is charged ← **this run attempts to observe it**
4. Tier 2 gracefully skips when `localModels` is absent ← **this run confirms it**

Points 1, 2, and 4 are verifiable regardless of whether Tier 1 fires. Point 3 is the bonus — and if the coder produces clean code, that's a positive signal too (Phase 7–10 mechanisms reduced the kind of rushed first-pass code that generates lint violations).
