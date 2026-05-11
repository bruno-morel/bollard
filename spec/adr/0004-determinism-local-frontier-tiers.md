# ADR-0004: Determinism, local model, frontier — the three-tier work-routing rule

**Status:** Accepted
**Date:** 2026-05-08
**Deciders:** Bruno (maintainer)
**Supersedes:** —
**Related:** [stage5d-token-economy.md](../stage5d-token-economy.md), [adr/0001-deterministic-filters-for-llm-output.md](./0001-deterministic-filters-for-llm-output.md), [adr/0003-agent-protocol-compliance.md](./0003-agent-protocol-compliance.md)

## Context

Bollard's `implement-feature` pipeline currently spends $0.63–$1.40 of frontier-model budget per run (the two anchor cost points in CLAUDE.md). The dominant line item is the coder agent, which works near the upper end of its 80-turn ceiling on non-trivial changes (the explicit datum in CLAUDE.md is 42 turns at the older 60-turn ceiling, and the line-range mode commit log cites 30–70 turns wasted on the exact-match search death spiral before that fix). Inspection of recent runs shows that a substantial fraction of those turns is mechanical work the architecture has no good place to route to: re-deriving information already present on disk via `read_file`/`search` calls, applying batched patches in response to the post-completion verification hook, regenerating boilerplate around adversarial test files. The post-completion verification hook compounds this — it batches 5 checks (typecheck, lint, test, audit, secretScan) into a single round-trip, and on failure the entire batch lands in the coder's context for a frontier turn.

The historical architecture had two tiers:

1. **Deterministic.** Hardcoded TypeScript: import resolution, ripgrep, `tsc --noEmit`, Biome, `bollard-extract-*` helper binaries, the existing claim-grounding verifiers from Stage 3a/4a.
2. **Frontier.** Anthropic / OpenAI / Google API calls: every agent (planner, coder, three testers, semantic reviewer, LLM fallback extractor).

A whole class of work fits cleanly in neither tier. Applying a structured patch to fix a typecheck error is more than ripgrep can do (it needs to understand what the error means), and dramatically less than a frontier model is good at (it does not need plan-level reasoning, multi-step exploration, or novel synthesis). Generating a fast-check property body from a grounded claim is creative — but the surrounding `describe(...)`, `it(...)`, imports, and helper setup are not. Classifying whether a diff hunk needs human review is a small, repeatable judgement — not a multi-turn reasoning problem.

Routing this middle-tier work to the frontier API has three problems:

1. **Cost.** Frontier rates are 5×–20× higher per token than a 1–3B local model, and the work is exactly the kind small models do well.
2. **Latency.** Frontier round-trips include network and rate-limit jitter. The patcher use case is high-frequency, low-latency-sensitive.
3. **Architectural confusion.** When every non-deterministic call is a frontier call, "use the LLM" stops being a meaningful design decision. Every node added to the pipeline gets a frontier call by default, and the cost grows with the spec.

The forces at play:

- A genuinely creative coder turn (multi-file refactor, novel test design, plan synthesis) cannot be replaced by a small model. Output quality drops measurably below 7B; frontier remains the right tier for this work.
- Mechanical patch-apply, structured rewriting from error-to-fix, single-shot classification, and boilerplate scaffolding all show negligible quality gap between a 1.5B coder model and a frontier model on the small token windows Stage 5d targets.
- Bollard's existing `LLMProvider` interface (`packages/llm/src/types.ts`) is provider-agnostic. Adding a `LocalProvider` is mechanical; the architecture already supports it. The decision is not "can we?" but "where does the routing rule live?"
- Determinism is always cheaper than any LLM tier, but only applies when there is a machine-checkable answer. ADR-0001 already formalized this for filtering LLM output; ADR-0004 generalizes the principle to **routing** of work, not just filtering.

## Decision

Adopt a **three-tier work-routing rule** for every non-deterministic call in the pipeline:

1. **Deterministic first.** If the work has a machine-checkable answer (import resolution, AST query, file-system check, regex over a known schema, template fill from a typed claim, autofixer output), it must be done deterministically. No LLM call, no model. This was already the rule from ADR-0001's filtering principle; ADR-0004 makes it the routing rule too.
2. **Local model second.** If the work is structured rewriting, single-shot classification, or boilerplate-stripped generation that fits a 1–3B model's competence — and there is no deterministic answer — route to a locally-hosted small model via the `LocalProvider`. The current default is llama.cpp + Qwen2.5-Coder-1.5B-Instruct (Q4_K_M) for code-shaped tasks and `fastembed-js` + `bge-small-en-v1.5` for embeddings.
3. **Frontier last.** If the work is genuinely creative, multi-turn, requires plan-level reasoning, or its output quality is load-bearing for the run's verification correctness, route to a frontier API. The current default is Anthropic Claude Sonnet for the coder; cheaper frontier (Haiku) for the testers once boilerplate is stripped (Stage 5d Phase 3).

The rule is enforced by **architectural placement**, not by runtime check:

- New blueprint nodes that call an LLM must justify in their PR description why the work cannot be done deterministically or locally. Reviewers reject nodes that route to frontier without that justification (mirrors the ADR-0003 protocol-compliance review pattern).
- New agent roles default to `local` provider in `.bollard.yml` defaults, with the per-agent override lifting them to frontier only when the work shape demands it (Stage 5d Phase 5).
- Cost regression CI (Stage 5d Phase 6) catches drift: if a node migrates from local to frontier (intentionally or by accident), the median cost-per-run jumps and CI flags it.

## Options Considered

### Option A: Two-tier (status quo) — deterministic + frontier only

Keep the architecture as it stands. Address coder cost by aggressive prompt tuning, lower temperatures, and incremental turn budget reductions.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low — no new infrastructure |
| Cost | Marginal improvement only; structural cost stays |
| Scalability | Poor — every new node defaults to frontier |
| Team familiarity | High |
| Load-bearing assumption | Prompt tuning reaches a useful asymptote |

**Pros:** Cheapest to implement. No new runtime, no new providers, no new schemas.
**Cons:** Does not address the structural problem. Mechanical work continues to pay frontier rates. Every future blueprint node compounds the cost. Prompt tuning has measurably diminishing returns past a point we are already near (Stage 4d hardening squeezed out the protocol-compliance wins; the next 30% cost reduction is not in prompts).

### Option B: Three-tier with local model (chosen)

Add a `LocalProvider` to `@bollard/llm`, route mechanical-rewriting and small-classification work to it, and codify the routing rule as ADR-0004 plus enforcement via PR review and Stage 5d Phase 6 cost regression CI.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium — new provider, runtime baked into dev image, model-pull volume strategy, per-agent routing |
| Cost | High one-time (Stage 5d Phases 1–6), low marginal cost per future node, ~70% reduction in steady-state per-run cost |
| Scalability | Good — adding a node forces an explicit tier choice; default is the cheapest tier that can do the work |
| Team familiarity | Medium — `LLMProvider` interface is familiar; llama.cpp ops is new |
| Load-bearing assumption | Local 1–3B models are sufficient for the targeted workloads, which Stage 5d Phase 2/5 implementation validates |

**Pros:** Eliminates the structural cost class. Aligns the architecture with the existing "deterministic first" principle from ADR-0001 by extending it to a routing rule. Makes future cost decisions explicit (a node that wants frontier must justify it). Embeddings via `fastembed-js` unlock Stage 5b prompt regression work too.
**Cons:** Adds a runtime to the dev image (mitigated: llama.cpp binary is ~10 MB, models in a Docker volume not the image). Adds operational complexity (model pull, cache management, version pinning). Introduces a new failure mode (local model timeout / pull failure) that needs new error codes. Requires PR-review discipline to prevent silent regressions to frontier.

### Option C: Three-tier with hosted small models (e.g., Haiku-only middle tier)

Same shape as Option B but the middle tier is a smaller frontier model (Haiku) rather than a local model. Skip the local runtime entirely.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low — already supported via `.bollard.yml` per-agent routing |
| Cost | Modest improvement (Haiku is ~3× cheaper than Sonnet); patcher use case still costs frontier rates per call |
| Scalability | Same as Option A — middle tier is still on the API, costs grow with usage |
| Load-bearing assumption | Haiku is cheap enough that the structural cost class doesn't matter |

**Pros:** No new runtime. Ships in days rather than weeks.
**Cons:** Does not address latency (still a network round-trip). Does not address the architectural-confusion problem (every non-deterministic call still goes to a hosted API). Patcher use case at 1–3 calls per run × 30 runs/day quickly accumulates real cost. The reasoning in Stage 5d's motivation — "frontier should be reserved for genuinely creative work" — applies whether the middle tier is Haiku or local; routing it to a hosted API just means we're still paying network and metered-token costs for mechanical work.

## Trade-off Analysis

The decisive trade-off is **how the architecture handles the next 12 months of new nodes**, not the current cost number.

Option A keeps shipping nodes that default to frontier; the cost number creeps up monotonically. Option C makes the cost creep cheaper per token but does not change the curve's shape — every new blueprint node still funds Anthropic / OpenAI on every run. Option B changes the curve: most new nodes will fit the deterministic or local tier by default, and the frontier budget stays roughly flat as the pipeline grows.

The local-runtime cost (Stage 5d Phase 4 — image binary, Docker volume, error codes, pull mechanism) is real but one-time. It pays back inside ~3 months at current run frequency. After that, the marginal cost of every new local-tier node is zero in dollars and ~50 ms in latency.

The "must run locally" constraint (the user's stated dev-image footprint requirement) shaped the runtime choice: llama.cpp's static-binary deployment with lazy-pull volume keeps the image floor unchanged. Ollama would have added a service layer Bollard does not need; Candle would have needed broader model coverage than it currently has; ONNX Runtime + Transformers.js would have worked but with measurably worse small-model performance on CPU. llama.cpp is the right tier-2 runtime for Bollard's workload shape.

## Principle: when work belongs in tier 1 (deterministic)

Same conditions as ADR-0001's filter rule, generalized to routing:

1. **There is a machine-checkable answer.** Import resolution, AST queries, regex over typed schemas, template fills from typed claims, autofixer output.
2. **The cost of being wrong is bounded and recoverable.** A deterministic miss falls through to a higher tier; it does not silently produce a bad artifact.
3. **The deterministic implementation does not encode domain knowledge that needs to learn over time.** If the answer evolves with the codebase or with the model's improving competence, this is the wrong tier.

## Principle: when work belongs in tier 2 (local model)

Add to tier 2 when **all** of the following hold:

1. **The work is structured.** The input has a known schema (a typecheck error, a diff hunk, a claim with grounding) and the output has a known shape (a unified-diff patch, a binary classification, a property body matching a typed claim).
2. **A 1–3B model produces output indistinguishable from frontier on the same input.** Validate empirically during Stage 5d Phase 2/5 implementation; track via the Phase 6 cost regression eval set.
3. **The token surface per call is small.** Local CPU inference on 1.5B at Q4 handles a few thousand tokens in seconds; longer contexts are tier 3 territory.
4. **Latency tolerance is loose.** Tier 2 is for non-interactive pipeline work, not for the IDE hot path.

## Principle: when work belongs in tier 3 (frontier)

Reserve tier 3 for:

1. **Genuinely creative, multi-turn work.** The coder implementing a plan against a partially-known codebase. Novel adversarial property design that cannot be templated.
2. **Plan-level reasoning.** Decomposing an ambiguous task into ordered steps with risk scoring. Synthesizing a behavioral test from `BehavioralContext` that requires inferring failure modes the deterministic extractor missed.
3. **Output quality is load-bearing for verification correctness.** The semantic-reviewer's findings on flagged hunks (after the local diff classifier filters): a missed bug here defeats the whole verification stack, so the quality of the call matters more than its cost.

## Principle: when this rule does NOT apply

- **One-off scripts and migrations.** Stage 5d targets the per-run hot path. Quarterly `bollard doctor` audits or one-time spec-archive transformations are fine to write against frontier directly.
- **The local model is genuinely worse on a specific task.** If empirical validation shows tier 2 produces measurably-worse output for a given role, lift it to tier 3 explicitly. Document the override in `.bollard.yml`. Do not silently work around it.
- **The deterministic implementation would itself encode an LLM call (e.g., embedding-based ranking).** This is a category error in the framework: embeddings via `fastembed-js` are tier 2, not tier 1, even though they look mechanical. The tier reflects where the model lives, not how creative the call appears.

## Worked example: the verification feedback loop

**Today.** The coder finishes implementing, declares completion, and the post-completion hook runs typecheck + lint + test + audit + secretScan. On failure, the hook returns a string of batched failures to the coder, who runs another full frontier turn to apply the fixes — at Sonnet rates, against a context that includes the entire conversation history. The hook retries up to 3 times (`maxVerificationRetries: 3` in `agent-handler.ts`). When verification fails on a non-trivial change, this loop typically consumes 1–2 frontier turns per run.

**After Stage 5d Phase 2.**

1. **Tier 1 (deterministic):** `biome check --write --unsafe` runs first (already exists for lint), `tsc` autofix where available, language-specific autofixers from the profile. Many failures resolve here at zero LLM cost.
2. **Tier 2 (local patcher):** Remaining structured errors plus the relevant file slices go to Qwen2.5-Coder-1.5B-Instruct via `LocalProvider`. The model emits unified-diff hunks. Apply, re-run checks. 2 patcher rounds maximum.
3. **Tier 3 (frontier coder):** Only the residual errors the local patcher could not resolve reach the frontier coder. The existing `maxVerificationRetries: 3` becomes a budget for frontier escalations, not for any failed check.

The architectural shape mirrors ADR-0001's producer/verifier separation: tier 1 produces, tier 2 patches what tier 1 missed, tier 3 escalates what tier 2 could not handle. Each tier has bounded responsibility, and a failure at any tier degrades to the next without losing correctness.

## Consequences

**Easier:**
- Adding new pipeline nodes — the tier choice forces the right routing decision up front. New nodes default to the cheapest tier that can do the work.
- Reasoning about per-run cost — every node has a tier annotation; the budget shape is predictable.
- Incremental optimization — moving a node from tier 3 to tier 2 (or tier 2 to tier 1) is a localized refactor, not a pipeline-wide change.
- Onboarding new contributors — the three-tier rule is short and explicit.

**Harder:**
- Operating the local-model tier — model pulls, cache eviction, version pinning, llama.cpp upgrades all become Bollard concerns (mitigated: lazy-pull pattern keeps the burden out of the build pipeline; LRU cache eviction is automatic).
- Reviewing PRs that add LLM calls — reviewers must check the tier justification, not just the prompt quality. Adds a review-checklist item.
- Debugging a tiered call — when the local patcher emits a bad diff, the frontier coder sees the residual errors but not the patcher attempt. Mitigation: log every tier transition with the input/output shape; surface in `bollard history show <run-id>`.
- Validation across model versions — Qwen2.5-Coder-1.5B today; Qwen3-Coder-1.7B in 6 months. The tier-2 default needs revalidation when the upstream model changes (Stage 5d Phase 6's cost regression CI catches this).

**To revisit:**
- If two consecutive Stage 5d phases ship and the median cost-per-run does not drop, the routing rule is wrong somewhere — investigate which tier the work is actually landing in (Phase 6 telemetry).
- If a tier-2 node's quality regression blocks a Stage 5b eval, lift that role to tier 3 explicitly. Do not work around it with prompt tuning at tier 2 — that is the failure mode this ADR is designed to prevent.
- If GPU-attached local inference becomes useful (likely Stage 6 if patcher latency dominates), tier 2 widens to include 7B-class models. The routing rule does not change; only the model defaults do.

## Action Items

1. [ ] Land Stage 5d Phase 1 (deterministic context expansion) — validates the determinization principle without local-model dependency
2. [ ] Land Stage 5d Phase 3 (adversarial test scaffolding) — validates the templating principle in parallel with Phase 1
3. [ ] Land Stage 5d Phase 4 (local runtime — `LocalProvider`, llama.cpp binary, lazy-pull volume) — unlocks Phases 2 and 5
4. [ ] Land Stage 5d Phase 2 (verification-feedback patcher) — first tier-2 production user; revalidates the tier-2 quality assumption
5. [ ] Land Stage 5d Phase 5 (per-agent model assignment defaults) — operationalizes the routing rule in `.bollard.yml` defaults
6. [ ] Land Stage 5d Phase 6 (cost regression CI) — closes the loop; prevents silent drift back to tier 3
7. [ ] Add a "tier" annotation to each agent in `agent-handler.ts` (comment-only, no runtime behavior) so the routing intent is visible at the source
8. [ ] Update `04-configuration.md` to document the per-agent provider defaults and the tier-2 model pull mechanism
