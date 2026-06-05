# ADR-0005: Capability-based model selection with a versioned model registry

**Status:** Proposed
**Date:** 2026-06-04
**Deciders:** Bruno (maintainer)
**Supersedes:** — (extends Stage 5d Phase 5 per-agent assignment)
**Related:** [09-model-selection.md](../09-model-selection.md) (full design), [adr/0004-determinism-local-frontier-tiers.md](./0004-determinism-local-frontier-tiers.md), [stage5d-token-economy.md](../stage5d-token-economy.md)

## Context

Stage 5d Phase 5 gave every agent role a hardcoded default model in `config.ts` (`DEFAULTS.llm.agents`), overridable via `.bollard.yml`. ADR-0004 settled *which tier* each kind of work belongs to (deterministic / local / frontier). What remains unsettled is *which model within the frontier tier* serves each step, and how that choice stays correct over time.

The forces:

- **Model churn is fast and consequential.** The current coder default, `claude-sonnet-4-20250514`, is already deprecated upstream (verified 2026-06-04). Anthropic's 4.6-generation repricing also inverted an assumption baked into Phase 5: Opus-class is now $5/$25 (was $15/$75), making "Opus for the coder" a 1.67×–2.25× question instead of a 5× one. Hardcoded defaults cannot track this.
- **Cost accounting is load-bearing.** `CostTracker`, `agentBudgets`, run history, and the cost-regression CI all derive from per-provider `PRICING` maps that are duplicated and partly stale. Design principle 17 says the token budget is a load-bearing constraint; the pricing data it rests on currently isn't.
- **The selection logic must stay deterministic.** Design principles 1 and 10: config resolution makes no network or LLM calls and is reproducible across machines.
- **Per-step needs genuinely differ.** The coder is multi-turn, creative, quality-load-bearing (tier 3 per ADR-0004). The three testers are single-shot generators whose output is deterministically filtered by grounding verifiers (ADR-0001) — errors are cheap. The same model cannot be optimal for both, and recent self-tests confirm Haiku testers run at 0% grounding drop while the coder consumes ~90% of run cost.

## Decision

Make per-agent model defaults **derived, not hardcoded**, from two versioned, deterministic data structures in `@bollard/llm`:

1. **`MODEL_REGISTRY`** — typed entries per model: capabilities (reasoning/codegen level, tool use, context, max output), pricing (input/output/cache), lifecycle status (`current`/`deprecated`/`retired`), and a `verifiedOn` audit date. Single source of truth for pricing; replaces all per-provider `PRICING` maps.
2. **`ROLE_REQUIREMENTS`** — per agent role, the capability profile its work shape needs. Requirements are the durable part; they change only when the work shape changes.

A pure resolver picks, within the default provider (Anthropic-first), the cheapest `current` model satisfying the role's requirements; explicit `.bollard.yml`/env/CLI overrides always win, unchanged. Lifecycle guardrails: deprecated-model warnings at config time, retired-model hard errors, `bollard doctor` registry staleness checks. Registry updates are deliberate PRs gated by the existing eval-regression and cost-regression CI.

Immediate default changes this produces: coder (and `llm.default`) moves from deprecated `claude-sonnet-4-20250514` to `claude-sonnet-4-6`; all other roles continue to resolve to `claude-haiku-4-5-20251001`. Opus 4.8 is *not* the coder default despite better coding benchmarks — see trade-off analysis.

## Options Considered

### Option A: Static defaults, better picks (status quo shape)

Update the hardcoded map to current models and move on.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Trivial |
| Cost | Zero implementation; recurring maintenance ambush |
| Scalability | Poor — every new role and every model release is a hand-edit with no rationale trail |
| Team familiarity | High |

**Pros:** Ships in minutes; fixes the deprecated coder default.
**Cons:** Repeats the failure mode that produced this ADR: nothing detects the *next* deprecation, pricing maps stay duplicated, and the Haiku-vs-Sonnet rationale stays in comments. No structural improvement.

### Option B: Capability registry + deterministic resolver (chosen)

Requirements per role, registry per model, pure resolution function, lifecycle guardrails.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium — two data files, one pure function, provider pricing unification |
| Cost | One-time; thereafter model updates are one-line registry PRs gated by existing CI |
| Scalability | Good — new roles declare requirements; new models declare capabilities; defaults derive |
| Team familiarity | High — plain TypeScript data + pure functions, same pattern as `concerns.ts` defaults |

**Pros:** Defaults track the registry automatically; deprecations warn before they break; pricing becomes single-source and auditable (`verifiedOn`); the "why this model for this step" rationale becomes a typed requirement instead of folklore; existing eval/cost CI become the quality and cost gates for model swaps.
**Cons:** The registry is curated data that can itself go stale (mitigated: doctor staleness warning at 90 days, loud unknown-model pricing warnings). Capability levels are coarse human judgements, not benchmarks — acceptable because the eval CI, not the label, is the final arbiter.

### Option C: Eval-driven dynamic selection

Benchmark candidate models per role with the Stage 5b eval framework; pick defaults from measured pass rates, possibly at runtime.

| Dimension | Assessment |
|-----------|------------|
| Complexity | High — eval matrix per role × model, selection state, CI cost |
| Cost | ~17 eval cases × N models recurring; plus self-test runs for the coder, which evals cover poorly |
| Scalability | Good in theory; brittle in practice — eval sets are small (2–5 cases/role) and saturated at 100% |
| Team familiarity | Medium |

**Pros:** Most rigorous grounding for claims like "Haiku is enough for the planner".
**Cons:** Current eval sets cannot discriminate between adequate models (everything passes at 100% since `stage5b-quality`); runtime selection would violate deterministic config resolution; cost and maintenance are disproportionate to a seven-role pipeline. Use evals as the *gate* on registry changes (Option B already does), not the *selector*.

## Trade-off Analysis

**The decisive trade-off is who pays attention, and when.** Option A concentrates attention at random failure moments (a retirement breaking prod runs). Option C demands continuous attention (eval matrix upkeep). Option B concentrates attention at deliberate registry-PR moments, with CI catching what attention misses — the same shape as ADR-0004's tier rule and Bollard's cost-baseline discipline.

**Coder: Sonnet 4.6 over Opus 4.8.** Opus 4.8 leads SWE-bench Verified 88.6% vs 79.6%, but costs 1.67× per token and its tokenizer emits up to ~35% more tokens — effectively ≈2.25× on the node carrying ~90% of run cost. Bollard's coder operates on bounded, planned, single-method tasks inside a deterministic verification harness; recent runs complete in 17–26 turns with zero grounding drop. The benchmark gap lives mostly in territory (large unplanned refactors) the pipeline deliberately avoids. Risk-adaptive Opus escalation is deferred, and the registry makes it cheap to add later.

**Testers: requirements, not aspirations.** The grounding verifiers convert tester quality from "load-bearing" to "filtered" — which is exactly what permits the `light` codegen requirement and the Haiku price point. If a future scope removes its verifier, its requirements must rise. The semantic reviewer (40–50% keep-rate vs 50% target) is resolved by experiment (design doc §8 Phase 4), not by precautionary upgrade.

## Consequences

**Easier:** surviving model deprecations (warned, not discovered); justifying per-step model choices (typed requirements); keeping cost data honest (one registry, `verifiedOn` audit trail); adding roles or adopting new models (one-line data changes gated by existing CI).

**Harder:** registry curation is a new recurring chore (~quarterly, doctor-nagged); capability levels invite bikeshedding — the rule is that the eval CI arbitrates, not the label; one more indirection when reading `forAgent` (mitigated by `source: "capability-resolved"` in `config show --sources`).

**To revisit:**
- If a self-test shows the coder failing on plan-conformant tasks at Sonnet 4.6, run the Opus 4.8 A/B before touching prompts (mirror of ADR-0004's "do not tune around a tier mismatch").
- If the semantic-reviewer experiment shows Sonnet closes the keep-rate gap, change its requirement to `reasoning: frontier` and let the default derive.
- Prompt caching (cache reads at 0.1× input) is likely a bigger cost lever than any model swap given the 94% input-token share — schedule as its own piece of work.

## Action Items

Scheduled as **Stage 5e Phases 4–6** in [ROADMAP.md](../ROADMAP.md):

1. [ ] **5e Phase 4** — `model-registry.ts`, pricing unification, coder/default → `claude-sonnet-4-6`; eval tag/diff + self-test + cost-baseline diff around the swap
2. [ ] **5e Phase 5** — `role-requirements.ts` + `resolveModelForRole` wired into `LLMClient.forAgent`; delete hardcoded `DEFAULTS.llm.agents`; golden resolution tests; lifecycle guardrails (config-time deprecation warning, retired hard error, `bollard doctor` registry section)
3. [ ] **5e Phase 6** — semantic-reviewer Haiku vs Sonnet 4.6 A/B (eval diff + 2–3 self-tests); decide requirement change on data
4. [ ] Backlog — prompt caching in `AnthropicProvider`; risk-adaptive coder escalation design note
