---
name: review-grounding-corpus
overview: "Follow-up from the Stage 5e Phase 6 A/B finding (keep-rate ceiling is filter-bound, not model-bound). Diagnose the actual semantic-review drops from real run data, confirm whether they are FALSE drops (good findings lost to a matching technicality) or CORRECT drops (genuine hallucinations), and ONLY if false drops dominate, broaden the review grounding corpus — mirroring the contract-grounding corpus fix — without loosening the filter's safety property."
todos:
  - id: step-1-capture
    content: "Capture raw reviewer findings + drop reasons from real runs (recover from Phase 6 history if persisted, else 2 diagnostic self-tests). Save as fixtures."
    status: completed
  - id: step-2-classify
    content: "Classify every dropped finding: FALSE drop (real, lost to matching) vs CORRECT drop (ungrounded/hallucinated). Quantify the dominant drop reason. THIS GATES THE FIX."
    status: completed
  - id: step-3-fix-corpus
    content: "ONLY if false drops dominate: broaden buildReviewCorpus to cover the specific failure mode (task text, post-change source contents, plan-source identifier fallback) — corpus broadening only, never match loosening."
    status: completed
  - id: step-4-validate
    content: "Deterministic before/after replay on captured fixtures: keep-rate up AND zero hallucinations newly admitted (every newly-kept finding manually verified real). +unit tests."
    status: completed
  - id: step-5-confirm
    content: "Optional: one live self-test for an in-vivo keep-rate point. Docs (close Phase 6 follow-up in 09 §8), CLAUDE.md, archive."
    status: completed
isProject: false
---

# Review Grounding Corpus — diagnose, then (maybe) broaden

## Where this comes from

Stage 5e Phase 6 A/B (semantic-reviewer Haiku vs Sonnet 4.6) found both models stuck at ~50% review grounding keep-rate. Two models a full capability tier apart producing the same keep-rate is evidence the ceiling is the **deterministic grounding filter** (`packages/verify/src/review-grounding.ts`), not model quality. This prompt acts on that — but the Phase 6 finding is a *hypothesis* until the actual dropped findings are read. **Confirm before fixing.**

## The safety property you must not break

`verifyReviewGrounding` is an ADR-0001 deterministic filter: its job is to drop ungrounded LLM findings (hallucinations, paraphrase-as-fact). The Phase 6 concern is that it *also* drops good findings. The only sanctioned fix is **broadening the corpus with legitimate source text** (more real material for a true quote to match against) — exactly what the contract-grounding fix did (`contractContextToCorpus` gained `task` + `acceptance_criteria` + `sourceContents`; see CLAUDE.md "Contract grounding corpus" + Stage 5e Phase 1). **Never loosen the match logic** (`quoteMatchesCorpus`) or the all-grounding-items-must-pass rule to chase keep-rate — that admits hallucinations and defeats the filter. If the diagnosis shows the drops are *correct*, the right answer is "no change — the filter works, the reviewer is just noisy, ~50% is honest." That is a valid and acceptable outcome.

## Step 1 — Capture the real drops (data, not assumption)

The verifier returns `{ kept, dropped }` and the `verify-review-grounding` node logs `semantic_review_result` with `{ proposed, kept, dropped, dropRate }` (`packages/blueprints/src/implement-feature.ts` ~L1680). You need, for several real runs: the **raw reviewer findings** (the full JSON the LLM produced, including dropped ones) and **each drop's `reason` + `detail`** (`grounding_not_in_corpus`, `grounding_source_mismatch`, `grounding_empty`, etc.).

1. First try to recover from the Phase 6 runs: `bollard history show <run-id>` for the five Phase 6 runs (Arm A `69c903`/`e5644d`/`0a6216`, Arm B `7a9d00`/`4da0ad`, + run 3 if completed). If the node `data` (kept + dropped detail) is persisted in `.bollard/runs/history.jsonl`, extract it.
2. If the raw findings/drops are **not** persisted (likely — history stores summaries), run **2 diagnostic self-tests** on a fresh `CostTracker` method (grep to confirm absent), capturing the raw `semantic-review` node output and the `verify-review-grounding` `dropped` array. The cheapest reliable capture: temporarily log `ctx.results["semantic-review"].data` (raw) and the full `dropped` array at the `verify-review-grounding` node, run, collect, then revert the logging. (These 2 runs double as the in-vivo baseline for Step 5.)
3. Save the captured findings + drops as a **fixture** in `packages/verify/tests/fixtures/` (real reviewer output, anonymised only if needed). This fixture is the deterministic substrate for Steps 2 and 4 — once captured, no more LLM calls are needed to iterate on the fix.

## Step 2 — Classify every drop (this gates whether there is a fix at all)

For each dropped finding in the captured data, read the finding text + its grounding quotes against the actual diff/plan, and label it:

- **FALSE drop** — the finding describes a real issue genuinely present in the diff/plan, but the grounding quote failed to match (paraphrase, cross-line quote, quoted unchanged-context code, quoted the source body rather than the `+`-prefixed diff line, or cited `source:"plan"` with no plan-identifier fallback). These are the filter's fault.
- **CORRECT drop** — the finding is ungrounded: hallucinated behavior, vague restatement, an issue not actually in the change. The filter did its job.

Tabulate: count of FALSE vs CORRECT, and the dominant `reason` among FALSE drops. **Decision gate:**

- If **CORRECT drops dominate** → stop. The filter is working; ~50% keep-rate is honest. Write that up (Step 5 docs) as the conclusion and make **no code change**. This closes the Phase 6 follow-up with "filter validated, reviewer is noisy."
- If **FALSE drops dominate** → proceed to Step 3, and note exactly which failure mode(s) account for them. The fix targets only those.

## Step 3 — Broaden the corpus for the confirmed failure mode(s) only

Map the dominant FALSE-drop reason to the minimal corpus broadening (do only what the data justifies):

- **Quotes of source-body / unchanged-context code that isn't in the diff hunks** → add the **post-change contents of touched source files** to the corpus as `source:"diff"` entries (the contract-grounding `sourceContents` precedent). `buildReviewCorpus` currently only has the `+/-` diff hunks; a reviewer quoting a method body line without the diff prefix fails. This is the most likely dominant mode.
- **Quotes of the task description** → add `ctx.task` to the corpus (currently absent; plan summary/criteria are there but not the task). Same as the contract fix.
- **`source:"plan"` paraphrase with no fallback** → extend the identifier-presence fallback (`findingIdentifiersInCorpus`) to also apply to `source:"plan"` groundings (today it is diff-only, `verifyReviewGrounding` L341). Keep the ≥4-char identifier guard.

Implementation: extend `buildReviewCorpus(diff, plan)` to `buildReviewCorpus(diff, plan, opts?)` with optional `task?: string` and `sourceContents?: string[]`; thread them from the `verify-review-grounding` node (read `ctx.task` and the touched source files post-implementation, mirroring how `verify-claim-grounding` already reads affected sources). Do **not** change `quoteMatchesCorpus` or the per-finding all-items rule. Each broadening must be defensible as "this is real source text the reviewer legitimately quoted," never "this makes matching looser."

## Step 4 — Validate deterministically (the strong part — no LLM needed)

Using the captured fixtures from Step 1:

1. **Before/after replay:** run `verifyReviewGrounding(fixtureFindings, oldCorpus)` vs `(fixtureFindings, newCorpus)`. Report keep-rate before → after on the *same* real findings. This is a controlled, deterministic measurement of the fix's effect — far cleaner than noisy self-test keep-rates.
2. **Zero-hallucination guard (mandatory):** every finding that is *newly kept* under the new corpus must be one you labelled FALSE-drop in Step 2 (a real finding). If the broadening newly keeps any finding you labelled CORRECT-drop (a hallucination), the corpus is too broad — tighten it. Assert this explicitly.
3. **Unit tests** in `packages/verify/tests/review-grounding.test.ts`: fixture-based cases proving (a) a real finding previously dropped on `grounding_not_in_corpus` is now kept via the broadened corpus, and (b) a genuinely ungrounded finding is **still dropped**. The second test is the safety regression guard — it must exist. +N tests; full suite ≥ 1550/6.

## Step 5 — Confirm in vivo (optional) + close out

1. Optional single live self-test on a fresh method: confirm the `semantic_review_result` keep-rate moved in the expected direction on a genuinely new diff. One data point, not a study — the deterministic replay (Step 4) is the real evidence.
2. `spec/09-model-selection.md §8 Phase 4`: append the resolution — "Phase 6 follow-up actioned: review corpus broadened (<what>), keep-rate on Phase 6 fixtures <X>%→<Y>%, zero hallucinations admitted" — OR, if Step 2 said correct-drops dominate, "Phase 6 follow-up closed: filter validated, drops are genuine; no change."
3. `CLAUDE.md`: one-line note under the grounding/known-limitations section describing the broadened review corpus (or the validated-no-change outcome).
4. Archive this prompt → `spec/archive/`. Commit: code+tests as one commit, docs as a second.

## Out of scope — DO NOT

- DO NOT loosen `quoteMatchesCorpus`, the all-grounding-items-must-pass rule, or any schema/severity/category check to raise keep-rate. Corpus broadening only.
- DO NOT touch the semantic-reviewer prompt — this is a verifier-side fix, and a prompt change would confound any before/after.
- DO NOT chase a keep-rate target. The objective is "keep real findings, drop hallucinations." If the data says the drops are correct, ship no code.
- DO NOT change other graders (contract/boundary/behavioral) — even if they share helpers, scope this to review grounding.
- DO NOT skip the zero-hallucination guard test — it is the proof the filter still does its job.
