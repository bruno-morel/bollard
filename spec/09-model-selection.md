# 09 — Capability-Based Model Selection

> Source of truth for how Bollard chooses which LLM serves each pipeline step.
> Decision record: [ADR-0005](adr/0005-capability-based-model-selection.md).
> Related: [ADR-0004](adr/0004-determinism-local-frontier-tiers.md) (tier routing), [stage5d-token-economy.md](stage5d-token-economy.md) (Phase 5 per-agent assignment).

## 1. Problem

Stage 5d Phase 5 shipped per-agent model assignment: a hardcoded `DEFAULTS.llm.agents` map in `packages/cli/src/config.ts` (Haiku for planner/testers/reviewer, Sonnet for coder), overridable via `.bollard.yml` `llm.agents`. This works, but it has four structural weaknesses:

1. **Defaults rot silently.** The coder default is `claude-sonnet-4-20250514` — **deprecated by Anthropic as of the 4.6 generation** (verified 2026-06-04 against the [model docs](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions)). When it is retired, every run fails at the first coder call. Nothing in Bollard knows or warns.
2. **Rationale is a comment.** *Why* Haiku is right for the testers (single-shot, bounded corpus, grounding verifier downstream) and Sonnet for the coder (multi-turn creative work, quality is load-bearing) lives in a code comment. When a new agent role is added, there is no structured way to decide its model — people copy the nearest line.
3. **Pricing is duplicated and stale.** Each provider file carries its own `PRICING` map; `anthropic.ts` still prices Opus 4 at $15/$75 (current Opus models are $5/$25). Unknown models silently fall back to `DEFAULT_PRICING`, which skews `CostTracker`, `agentBudgets` enforcement, run history, and the cost-regression CI — the entire token-economy loop is only as accurate as these maps.
4. **"Best model per step" is not expressible.** The right model for a step is a function of the work shape (reasoning depth, codegen quality, context size, output structure) and the price. Today that function is evaluated in a maintainer's head once per stage and frozen.

## 2. Design overview

Three pieces, all deterministic (design principle 1 and 10 — no LLM calls, no network calls at resolution time):

```
ROLE_REQUIREMENTS (what each step needs)
        │
        ▼
resolveModelForRole() ──reads──► MODEL_REGISTRY (what each model offers, costs, and its lifecycle status)
        │
        ▼
LLMClient.forAgent(role)   ← .bollard.yml / env / CLI overrides still win, unchanged
```

- **Model registry** — one typed, versioned TypeScript data file describing every model Bollard knows: capabilities, pricing, lifecycle status, and the date the entry was last verified against vendor docs. Replaces the three per-provider `PRICING` maps as the single pricing source.
- **Role requirements** — each agent role declares the capability profile its work shape needs. Requirements change rarely (only when the work shape changes); they are the durable part.
- **Resolver** — a pure function mapping requirements → the cheapest *current* model of the default provider that satisfies them. Model defaults are now *derived*, not hardcoded: when the registry is updated (new model, price drop, deprecation), defaults move automatically and the change is visible in one diff.

Anthropic-first: the resolver selects only within `llm.default.provider` (anthropic out of the box). OpenAI / Google / local remain explicit per-agent overrides in `.bollard.yml`, exactly as today. Cross-provider auto-routing is out of scope (§9).

## 3. Types

In `packages/llm/src/model-registry.ts`:

```ts
export type CapabilityLevel = "frontier" | "standard" | "light"

export interface ModelCapabilities {
  /** Plan-level / multi-step reasoning quality. */
  reasoning: CapabilityLevel
  /** Code generation quality (agentic coding benchmarks, tool-use loops). */
  codegen: CapabilityLevel
  toolUse: boolean
  streaming: boolean
  contextWindow: number
  maxOutput: number
}

export interface ModelPricing {
  /** USD per 1M tokens. */
  input: number
  output: number
  cacheRead?: number
  cacheWrite5m?: number
}

export type ModelStatus = "current" | "deprecated" | "retired"

export interface ModelRegistryEntry {
  id: string // e.g. "claude-sonnet-4-6"
  provider: "anthropic" | "openai" | "google" | "local"
  status: ModelStatus
  capabilities: ModelCapabilities
  pricing: ModelPricing
  /** ISO date this entry was last checked against vendor docs. */
  verifiedOn: string
  /** Operational caveats, e.g. "Opus 4.7+ tokenizer uses up to 35% more tokens". */
  notes?: string
}

export interface ModelRequirements {
  reasoning: CapabilityLevel
  codegen: CapabilityLevel
  needsToolUse: boolean
  minContext: number
  minOutput: number
}
```

`CapabilityLevel` ordering is `light < standard < frontier`. A model satisfies a requirement when its level is ≥ the required level on every dimension and every boolean/numeric requirement holds.

## 4. The registry (initial content, verified 2026-06-04)

Anthropic lineup and pricing per the [official pricing page](https://platform.claude.com/docs/en/about-claude/pricing):

| id | status | reasoning | codegen | context | $/MTok in/out | notes |
|----|--------|-----------|---------|---------|----------------|-------|
| `claude-opus-4-8` | current | frontier | frontier | 1M | 5 / 25 | 88.6% SWE-bench Verified; new tokenizer ≈ +35% tokens |
| `claude-opus-4-6` | current | frontier | frontier | 1M | 5 / 25 | |
| `claude-sonnet-4-6` | current | frontier | frontier | 1M | 3 / 15 | 79.6% SWE-bench Verified; best $/quality for agentic coding |
| `claude-sonnet-4-5-20250929` | current | standard | standard | 200K | 3 / 15 | |
| `claude-haiku-4-5-20251001` | current | standard | standard | 200K | 1 / 5 | |
| `claude-sonnet-4-20250514` | **deprecated** | standard | standard | 200K | 3 / 15 | current coder default — must migrate |
| `claude-opus-4-20250514` | deprecated | frontier | standard | 200K | 15 / 75 | |
| `qwen2.5-coder-1.5b-q4` | current | light | light | 32K | 0 / 0 | local tier-2 (ADR-0004), patcher only |

OpenAI / Google entries carry whatever models the existing provider `PRICING` maps already know, marked with their own `verifiedOn` dates. The registry does not need to be exhaustive — it needs to be **honest**: any model not in the registry triggers a loud warning (see §6), never a silent default price.

Registry maintenance is a deliberate PR (same discipline as a dependency bump): update entries, run `bollard eval diff` if a derived default changes, merge. The `verifiedOn` field makes staleness auditable — `bollard doctor` warns when the default provider's entries are older than 90 days.

## 5. Role requirements and the derived default matrix

In `packages/llm/src/role-requirements.ts`:

| role | work shape | reasoning | codegen | toolUse | minOutput | resolves to (2026-06) |
|------|-----------|-----------|---------|---------|-----------|------------------------|
| `planner` | read-only exploration → structured JSON plan; quality gated by eval CI + human gate | standard | light | yes | 8K | `claude-haiku-4-5-20251001` |
| `coder` | multi-turn creative implementation; quality is load-bearing (ADR-0004 tier 3) | frontier | frontier | yes | 16K | `claude-sonnet-4-6` |
| `boundary-tester` | single-shot claims JSON from signatures; grounding verifier downstream | standard | light | no | 16K | `claude-haiku-4-5-20251001` |
| `contract-tester` | single-shot claims JSON from contract graph; grounding verifier downstream | standard | light | no | 16K | `claude-haiku-4-5-20251001` |
| `behavioral-tester` | single-shot claims JSON from behavioral context; grounding verifier downstream | standard | light | no | 16K | `claude-haiku-4-5-20251001` |
| `semantic-reviewer` | single-shot diff judgement; findings advisory but verification-adjacent | standard | light | no | 8K | `claude-haiku-4-5-20251001` |
| `test-curator` | test quality scoring and curation proposals (Stage 6) | standard | light | no | 8K | `claude-haiku-4-5-20251001` |

`llm-fallback-extractor` is not resolved via `forAgent` — `getExtractor` receives an explicit provider+model. A `ROLE_REQUIREMENTS` entry exists for forward use only.

Rationale anchors:

- **Coder → Sonnet 4.6.** The deciding trade-off is Sonnet 4.6 vs Opus 4.8. Opus 4.8 is measurably better at agentic coding (88.6% vs 79.6% SWE-bench Verified) but costs 1.67× per token *and* its tokenizer emits up to 35% more tokens — effective ≈ 2.25× per coder turn, on the node that already carries ~90% of run cost ($0.95–$1.44 of the $1.05–$1.55 recent anchors). Bollard's task shape (bounded single-method tasks, plan provided, deterministic guardrails downstream) sits well inside Sonnet-class competence — recent self-tests complete in 17–26 turns with 0% boundary/contract grounding drop. Pay the Opus premium only when the work shape demands it (§8, risk-adaptive escalation — deferred).
- **Testers stay Haiku.** The grounding verifiers (ADR-0001 pattern) make tester output cheap to be wrong about: ungrounded claims are dropped deterministically, and drop-rate is tracked per run. Recent runs show 0% boundary/contract drop at Haiku — there is no quality gap left for a bigger model to close. `maxTokens: 16384` (truncation fix, 2026-05-23) is encoded as `minOutput`.
- **Semantic reviewer stays Haiku (settled 2026-06-19, Stage 5e Phase 6 A/B).** Pre-registered controlled A/B on fixed task `usedFraction()`, identical deterministic grounding filter in both arms. Haiku mean keep-rate **54%** (80% / 33% / 50%, N=3) vs Sonnet 4.6 **53%** (40% / 67%, N=2 — run 3 skipped; +15pp bar mathematically unreachable after run 2). Sonnet sat at parity, not ahead; cost delta unmeasurable (coder-retry variance dominated). **Decision: keep `reasoning: standard` → Haiku.** Headline finding: keep-rate ceiling is the grounding filter, not the model — follow-up is review grounding corpus work in `review-grounding.ts`, not a model swap.
- **Planner stays Haiku.** 100% eval pass rate at the `stage5b-quality` baseline, plan compression rules (Phase 10) hold, and the human gate catches plan-level misses. The eval-regression CI is the tripwire if a future prompt change exceeds Haiku.

## 6. Resolver semantics

```ts
export function resolveModelForRole(
  role: string,
  provider: string,
  registry: ModelRegistryEntry[] = MODEL_REGISTRY,
): ModelRegistryEntry | undefined
```

1. Look up `ROLE_REQUIREMENTS[role]`; if absent, return `undefined` (caller uses `llm.default` for unknown/custom roles).
2. Collect current entries for `provider`. If **zero entries** exist in the registry for that provider (e.g. `mock`, custom name), return `undefined` — caller falls to `llm.default` (§6 step 3 escape hatch).
3. Filter to entries satisfying all requirements (`status === "current"` already applied in step 2).
4. Pick the cheapest by **output price**, tie-break by input price, then by newest `verifiedOn`. (Output price dominates because Bollard's per-call output is bounded by `maxTokens` while input is managed by Phase 8 context caps — and output is 5× input on every current Anthropic model.)
5. Filtered set empty but provider had current entries → throw `BollardError` `MODEL_NOT_AVAILABLE` with the requirements in `context`. No silent fallback to a model that can't do the work.

`LLMClient.forAgent(role)` resolution order (only step 2 is new):

1. `.bollard.yml` / env / CLI per-agent override — **always wins**, exactly as today.
2. `resolveModelForRole(role, config.llm.default.provider)`.
3. `config.llm.default` — kept as the escape hatch when the registry has no entries for the configured provider (e.g. a custom provider name).

`config show --sources` annotates step-2 results as `source: "capability-resolved"` so the derivation is inspectable.

**Pricing unification.** `estimateCost` in all three providers reads the registry. Unknown model: keep the conservative fallback price so cost tracking never zeroes out, but emit a one-time stderr warning per process (`unknown model "<id>" — cost estimates use fallback pricing; add it to model-registry.ts`) and annotate the run record so `bollard history show` can flag estimated-cost runs.

**Lifecycle guardrails.**
- `forAgent` resolving (via override or default fallback) to a `deprecated` model → yellow warning naming the replacement candidate. `retired` → hard error at config time, not at first API call mid-run.
- `bollard doctor` gains a registry section: deprecated/retired models in the active config, entries older than 90 days.
- Eval-regression CI (Stage 5b Phase 2) is the quality gate for any PR that changes a derived default; cost-regression CI (Stage 5d Phase 6) is the cost gate. Both already exist — the registry just gives them a single place to watch.

## 7. Config surface (unchanged)

`.bollard.yml` keeps the exact same shape — `llm.default` and `llm.agents.<role>` with `provider` + `model`. No new YAML. The change is in what happens when you *don't* override: instead of a frozen hardcoded map, the default derives from requirements × registry. Existing user configs keep working verbatim; `overriddenAgentRoles` semantics are untouched.

## 8. Migration plan

This work ships as **Stage 5e Phases 4–6** ([ROADMAP.md](ROADMAP.md)) — it continues 5e's cost-hardening theme (deterministic infrastructure, no new agentic capability) and runs orthogonal to the Stage 6 takeover track. Local phase numbers below map: Phase 1 → 5e Phase 4; Phases 2–3 → 5e Phase 5; Phase 4 → 5e Phase 6.

- ~~**Phase 1 — registry + pricing unification (shipped 2026-06-05, Stage 5e Phase 4).**~~ `model-registry.ts` shipped; providers unified; unknown-model warning; coder/default → `claude-sonnet-4-6`; doctor registry section. Self-test `budgetStatus()` GREEN ($1.15, 16 coder turns). Cost baseline **`post-model-registry`**.
- ~~**Phase 1b — eval per-agent model resolution (shipped 2026-06-05, Stage 5e Phase 4b).**~~ `runAllAgentScores` resolves models via `forAgent(role)`; per-score `model` on baseline; eval baseline **`stage5b-sonnet-4-6`**. Eval-regression CI unblocked.
- ~~**Phase 2 — requirements + resolver (shipped 2026-06-15, Stage 5e Phase 5).**~~ `role-requirements.ts` + `resolveModelForRole`; wired into `forAgent` step 2; deleted hardcoded `DEFAULTS.llm.agents`; `config show --sources` `capability-resolved` annotation; golden resolution test (7 roles unchanged); unknown roles + unregistered providers → `llm.default`. Self-test `headroom()` GREEN ($1.54, 17/17). **1550 pass / 6 skip.**
- **Phase 3 — lifecycle guardrails.** Doctor registry section, deprecated/retired warnings in `resolveConfig`, run-record annotation for fallback-priced runs.
- ~~**Phase 4 (experiment, decided 2026-06-19, Stage 5e Phase 6) — semantic-reviewer A/B: NO, Haiku retained.**~~ Pre-registered controlled A/B (rule: Sonnet wins only if mean keep-rate ≥ 50% **and** ≥ 15pp over Haiku **and** kept findings genuinely useful), fixed task `usedFraction()`, N=3 per arm (Arm B run 3 skipped — decision locked after run 2), identical deterministic grounding filter in both arms so only the finding-producing model varies. **Result: no measurable advantage for Sonnet 4.6.** Review grounding keep-rate — Haiku **54%** mean (80% / 33% / 50%) vs Sonnet 4.6 **53%** mean (40% / 67%; run 3 not executed). The binding condition (+15pp over Haiku) was mathematically unreachable after run 2: with Haiku fixed at 54%, Sonnet's 3-run mean needed run 3 to be ~100% just to reach the 69% bar. Sonnet sat at parity, not ahead. Cost delta was unmeasurable — dominated by coder-retry variance (one Haiku run hit $8.52 on a 45-turn retry), so the reviewer's own +$/run never rose above noise, which itself argues against paying for it. **Decision: keep `semantic-reviewer` at `reasoning: standard` → Haiku. No code change.** Requirement, golden test, and §5 table unchanged. **Headline finding (the reason the experiment was worth running): the keep-rate ceiling is the grounding filter, not the model.** Two models a full capability tier apart (Haiku standard, Sonnet frontier) produced the same ~54% keep-rate. When a frontier model can't beat a light one on a metric, the metric isn't bounded by model quality. Kept Sonnet findings were genuinely useful (plan-divergence, missing-coverage); dropped finding bodies were not persisted in run artifacts — tier parity supports a filter-bound ceiling. The 50% target is therefore **filter-bound** — the lever is the review grounding corpus (`review-grounding.ts` / `findingIdentifiersInCorpus`), mirroring the contract-grounding corpus fixes (Stage 5e Phase 1), **not** a model swap. **Phase 6 follow-up (2026-06-20):** Diagnostic fixtures from two capture runs (`usedFraction`, `headroom`) — **6/6 dropped findings were FALSE** (demonstrably real plan-divergence / unintended-change issues lost to missing `non_goals`, `affected_files`, and `task` in corpus). Corpus broadened in `buildReviewCorpus` (plan `non_goals`, `affected_files`, `notes`, `task`, post-change `sourceContents` as diff entries). Fixture keep-rate **33%→100%** (`1238f9`) and **20%→100%** (`3a278e`); human spot-check on newly-kept findings signed off; zero hallucinations admitted.

Follow-up worth its own line: **prompt caching.** Input tokens are ~94% of run cost (Stage 5d Phase 8 finding) and Anthropic cache reads are 0.1× input price. The coder's system prompt + plan + tool schemas repeat across all turns of a run — `cache_control` on the system block is plausibly a larger cost lever than any model swap in this doc. Out of scope here (it's a request-shaping change in `AnthropicProvider`, not model selection), but the registry's `cacheRead` field is there so the cost model can represent it.

## 9. Out of scope (do not build)

- **Cross-provider auto-routing** ("pick the best model anywhere"). Multiplies API-key requirements, makes runs non-reproducible across environments, and the eval baseline currently only validates Anthropic models. Revisit only if a non-Anthropic model is demonstrably better *and* a maintainer commits to a second eval baseline.
- **Risk-adaptive escalation** (risk gate output lifts coder to Opus 4.8 for high-risk plans). Attractive, but needs cost-cap interplay design (`max_cost_usd`, per-attempt caps assume Sonnet rates). Deferred; the registry makes it a small change later.
- **Runtime benchmark-driven selection** (querying leaderboards or running evals at resolution time). Violates determinism of config resolution; selection data enters via registry PRs only.
- **A `models:` YAML block for user-defined registry entries.** Wait for a real request; the TS registry covers Bollard's own pipeline.
