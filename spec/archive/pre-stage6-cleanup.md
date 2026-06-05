---
name: pre-stage6-cleanup
overview: "Three pre-Stage 6 checks: fix flaky behavioral-extractor timeout, run bollard eval diff to verify prompt changes didn't regress eval scores, and read-only confirm Stage 6 Phase 0 types match ROADMAP Phase 1 spec."
todos:
  - id: fix-flaky-test
    content: "Add { timeout: 15000 } to describe('buildBehavioralContext') in behavioral-extractor.test.ts; validate 1460/6"
    status: pending
  - id: eval-diff
    content: "Run bollard eval diff; confirm all 5 agents still at 100% vs stage5b-quality baseline"
    status: pending
  - id: type-review
    content: "Read context.ts TakeoverModeConfig + errors.ts TAKEOVER_* codes + config.ts takeoverYamlSchema; confirm shapes match ROADMAP Phase 1 spec; report any misalignments"
    status: pending
  - id: commit-push
    content: "Commit test timeout fix; push; archive prompt"
    status: pending
isProject: false
---

## Goal

Three small checks before starting Stage 6 Phase 1 infrastructure work. No new features.
The only code change is the behavioral-extractor timeout — everything else is read-only
verification.

---

## Step 1 — Fix flaky behavioral-extractor timeout

**File:** `packages/verify/tests/behavioral-extractor.test.ts`

The `describe("buildBehavioralContext", ...)` block creates temp directories and writes
files. Under Stage 5c's parallel scope execution, Vitest's default 5s timeout can be
exceeded when the machine is under load. Fix: increase the timeout for this describe block.

Change:
```typescript
describe("buildBehavioralContext", () => {
```

To:
```typescript
describe("buildBehavioralContext", { timeout: 15000 }, () => {
```

No other changes. Run the suite to confirm:

```bash
docker compose run --rm dev run test
```

Gate: **1460 passed / 6 skipped / 0 failed** (same count as post-breakdown; the timeout
fix adds 0 tests).

If `{ timeout: 15000 }` on the describe block doesn't work in the current Vitest version,
use `it("...", async () => { ... }, 15000)` on each individual test instead.

---

## Step 2 — Run eval diff

We changed `coder.md` (write_file enforcement language) and `boundary-tester.md` (BEFORE
EMITTING checklist) since the `stage5b-quality` baseline was set. Both agents are
eval-tracked. Verify no regression:

```bash
docker compose run --rm -e ANTHROPIC_API_KEY dev sh -c \
  'pnpm --filter @bollard/cli run start -- eval diff'
```

**Expected:** all 5 agents pass at 100% (planner, coder, boundary-tester, contract-tester,
behavioral-tester). `bollard eval diff` exits 0.

**If any agent regresses** (passRate drops > 10pp from baseline):
- Report which agent and which eval cases failed
- Do NOT auto-fix — stop and surface the finding; a prompt rollback or eval case update
  may be needed before Stage 6

`semantic-reviewer` is NOT in the eval set — the live self-tests are its only validation,
which we've already run.

---

## Step 3 — Stage 6 Phase 0 type review (read-only)

Read the three Phase 0 files and confirm shapes match the ROADMAP Phase 1 spec.
**Do not edit anything in this step.**

### What to read

1. `packages/engine/src/context.ts` — `TakeoverModeConfig` and its 5 domain interfaces:
   - `TakeoverTestsConfig` (tests domain: `minMutationScoreToTrigger`, `maxFilesPerCycle`)
   - `TakeoverCiConfig` (ci domain: optional `platforms?: CiPlatformId[]`)
   - `TakeoverDepsConfig` (deps domain: `securityOnly`)
   - `TakeoverDomainConfig` for docs and monitoring (base: `enabled`, `trust`)
   - `TakeoverTrustLevel` = `"review" | "auto-commit" | "silent"`

2. `packages/engine/src/errors.ts` — TAKEOVER error codes:
   - `TAKEOVER_CONFLICT`
   - `OWNERSHIP_MANIFEST_INVALID`
   - `CURATION_NO_PROGRESS`
   - `TAKEOVER_TRUST_GATE`

3. `packages/cli/src/config.ts` — `takeoverYamlSchema` and `applyTakeoverConfig`:
   - Zod schema validates all 5 domains with correct field names and types
   - `applyTakeoverConfig` wired into `resolveConfig`

### What Phase 1 will consume from these

Phase 1 adds `TestOwnershipManifest`, `FileOwnershipStore`, and `detectManagedFileConflicts`
to `@bollard/engine`. It does NOT change the existing Phase 0 types — it builds on top of them.
The only new field on `PipelineContext` Phase 1 adds is `ownershipManifest?: TestOwnershipManifest`.

**Report:** list any misalignment between what's in the files and what the ROADMAP describes.
Specifically flag if any domain config is missing a field the ROADMAP Phase 1 spec expects to
read, or if error codes are absent. If everything matches, state "Phase 0 types confirmed
correct — Phase 1 can build on them directly."

---

## Step 4 — Commit + push

If eval diff passes (exit 0) and type review finds no misalignments:

```bash
git add packages/verify/tests/behavioral-extractor.test.ts
git commit -m "test: increase behavioral-extractor describe timeout to 15s (parallel load)"
git push origin main
```

Archive this prompt:
```bash
git mv spec/prompts/pre-stage6-cleanup.md spec/archive/
git add spec/archive/pre-stage6-cleanup.md
git rm spec/prompts/pre-stage6-cleanup.md
git commit -m "chore: archive pre-stage6-cleanup prompt"
git push origin main
```

**If eval diff finds a regression:** do not commit anything — report the failing agent and
cases. Stage 6 work pauses until resolved.

**If type review finds a misalignment:** report the specific field discrepancy. A targeted
fix to context.ts or config.ts may be needed before Phase 1 starts.

---

## Self-check

1. `docker compose run --rm dev run test` — **1460 passed / 6 skipped / 0 failed**
2. `bollard eval diff` — exit 0, all 5 agents ≥ baseline
3. Type review report — "confirmed correct" or explicit list of misalignments
4. `git log --oneline -3` — timeout fix + archive commit on main
5. `ls spec/prompts/` — empty

---

## Out of scope

- DO NOT start `TestOwnershipManifest` or `FileOwnershipStore` — those are Phase 1
- DO NOT change the Phase 0 type shapes unless type review reveals a concrete ROADMAP mismatch
- DO NOT re-run the full self-test pipeline — eval diff only
