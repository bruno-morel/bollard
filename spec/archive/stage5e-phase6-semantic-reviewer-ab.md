---
name: stage5e-phase6-semantic-reviewer-ab
overview: "Stage 5e Phase 6: controlled A/B experiment — semantic-reviewer Haiku vs Sonnet 4.6. Verdict: NO, Haiku retained."
todos:
  - id: step-0-preregister
    content: "Pre-register: fix the task, N per arm, the exact decision rule and cost ceiling — write them down BEFORE running anything"
    status: completed
  - id: step-1-control-haiku
    content: "Arm A (control): run N self-tests on the fixed task with semantic-reviewer on Haiku (current default); record keep-rate + cost per run"
    status: completed
  - id: step-2-treatment-sonnet
    content: "Arm B (treatment): override llm.agents.semantic-reviewer to claude-sonnet-4-6; run N self-tests on the SAME task; record keep-rate + cost + reviewer model confirmation"
    status: completed
  - id: step-3-analyze
    content: "Compare mean keep-rate, cost delta, and a qualitative read of kept-vs-dropped findings quality against the pre-registered rule"
    status: completed
  - id: step-4-decide
    content: "Apply the decision rule. YES → lift role requirement + golden test + docs. NO → document negative result, revert override"
    status: completed
  - id: step-5-closeout
    content: "Write results into 09-model-selection §8 Phase 4; revert the experiment override regardless; archive prompt; commit"
    status: completed
isProject: false
---

# Stage 5e Phase 6 — Semantic-Reviewer Haiku-vs-Sonnet A/B

Archived 2026-06-19. Verdict: **NO — Haiku retained.** Full write-up in [09-model-selection.md §8 Phase 4](../09-model-selection.md).

## Results (pre-registered + recorded)

- Fixed task: Add a usedFraction(): number method to CostTracker that returns total/limit as a value in [0,1], returning 0 when the limit is Infinity (unlimited) and 0 when the limit is 0 and total is 0 — confirmed absent from packages/engine/src/cost-tracker.ts (2026-06-18)
- N per arm: 3 planned; Arm A completed N=3; Arm B completed N=2 (run 3 skipped — +15pp bar mathematically unreachable after run 2)
- Decision rule (copied from Step 0): Sonnet mean keep-rate ≥ 50% AND Sonnet mean exceeds Haiku mean by ≥ 15pp AND qualitative read confirms kept findings are genuinely useful
- Cost ceiling: note if Arm B per-run cost rises > ~$0.30 over Arm A — **unmeasurable** (coder-retry variance dominated; one Arm A run $8.52 on 45-turn retry)

| run | arm | proposed | kept | keep-rate | total cost | reviewer model (from log) |
|-----|-----|----------|------|-----------|------------|---------------------------|
| 20260619-0354-run-69c903 | A | 5 | 4 | 80% | $8.52 | claude-haiku-4-5-20251001 |
| 20260619-0410-run-e5644d | A | 3 | 1 | 33% | $4.84 | claude-haiku-4-5-20251001 |
| 20260619-0419-run-0a6216 | A | 4 | 2 | 50% | $1.43 | claude-haiku-4-5-20251001 |
| 20260619-0423-run-7a9d00 | B | 5 | 2 | 40% | $4.34 | claude-sonnet-4-6 |
| 20260619-0432-run-4da0ad | B | 6 | 4 | 67% | $0.64 | claude-sonnet-4-6 |

- Mean keep-rate — Haiku: **54%** · Sonnet: **53%** (N=2)
- Mean cost — Haiku: **$4.93** · Sonnet: **$2.49** (N=2; not comparable — coder variance dominates)
- Qualitative read: Kept Sonnet findings genuinely useful (plan-divergence, missing-coverage on both Arm B runs). Dropped finding bodies not persisted in run artifacts — cannot confirm/deny verbatim-quote over-dropping on individual drops. Tier parity (~54% vs ~53%) supports filter-bound ceiling, not model-bound.
- **Verdict: NO — keep Haiku.** No change to `role-requirements.ts`, golden test, or §5 table. Follow-up: review grounding corpus (`review-grounding.ts` / `findingIdentifiersInCorpus`), out of scope for model-selection arc.
