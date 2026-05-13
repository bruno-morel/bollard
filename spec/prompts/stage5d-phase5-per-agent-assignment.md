# Cursor Prompt — Stage 5d Phase 5: Per-Agent Model Assignment

> **Purpose:** With the local runtime (Phase 4/4b) and the patcher (Phase 2) in place, the last structural piece of the token economy is defaulting each agent to the cheapest model that can do its job. Today, every agent in the pipeline resolves through `LLMClient.forAgent` which already supports per-agent overrides via `.bollard.yml` `llm.agents.<role>` — but the defaults are uniform (all `anthropic / claude-sonnet-4-20250514`). Phase 5 bakes the correct defaults into `DEFAULTS` in `config.ts` and into the `bollard init` config generator, adds optional per-agent budget caps so the cost envelope is explicit, and documents the reasoning in `04-configuration.md`. No new infrastructure needed — `LLMClient.forAgent` already does the right thing; Phase 5 just populates the defaults.

Read CLAUDE.md fully before writing any code. Then read:
- `spec/stage5d-token-economy.md` — Phase 5 design and per-agent model rationale
- `spec/adr/0004-determinism-local-frontier-tiers.md` — the routing rule that determines which tier each agent belongs to
- `packages/llm/src/client.ts` — `LLMClient.forAgent`, `resolveProvider`
- `packages/engine/src/context.ts` — `BollardConfig`, current `llm.default` shape
- `packages/cli/src/config.ts` — `DEFAULTS`, `bollardYamlSchema`, `resolveConfig`, `AnnotatedValue`
- `packages/cli/src/agent-handler.ts` — `createAgenticHandler`, how `llmClient.forAgent(agentRole)` is called
- `packages/cli/src/init-ide.ts` — `generateIdeConfigs`, where `.bollard.yml` content is templated
- `spec/04-configuration.md` — the `.bollard.yml` reference doc (update here too)

---

## What to change

### 1 — `packages/engine/src/context.ts`: extend `BollardConfig`

Add an optional per-agent budget cap field to `BollardConfig.llm`:

```typescript
export interface BollardConfig {
  llm: {
    default: { provider: string; model: string }
    agents?: Record<string, { provider: string; model: string }>
    /** Optional per-agent hard cost caps in USD. Exceeding the cap falls back to the cheaper tier. */
    agentBudgets?: Record<string, number>
  }
  agent: {
    max_cost_usd: number
    max_duration_minutes: number
  }
  localModels?: Partial<LocalModelsConfig>
}
```

`agentBudgets` is optional and informational in Phase 5 — the enforcement hook (falling back to a cheaper tier when the budget is exceeded) is Phase 6 territory. For now, the field is parsed and stored so it appears in `config show --sources` output.

---

### 2 — `packages/cli/src/config.ts`: three changes

#### 2a — New `DEFAULTS` with per-agent model assignments

Replace the current `DEFAULTS` constant:

```typescript
const DEFAULTS: BollardConfig = {
  llm: {
    default: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
    agents: {
      planner:            { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      coder:              { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      "boundary-tester":  { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      "contract-tester":  { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      "behavioral-tester":{ provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      "semantic-reviewer":{ provider: "anthropic", model: "claude-haiku-4-5-20251001" },
    },
  },
  agent: { max_cost_usd: 50, max_duration_minutes: 30 },
}
```

**Rationale (must be preserved as comments or in nearby doc):**
- `planner` and all testers/reviewer → Haiku: structured output from a bounded context; no multi-step reasoning over unknown code. Phase 3 already stripped boilerplate from tester outputs.
- `coder` → Sonnet: creative, multi-step implementation from a plan. The one agent where frontier quality pays off.
- `default` → Sonnet: safety net for any agent role not listed above (custom blueprint nodes, future agents).

#### 2b — Update `bollardYamlSchema` to accept `agentBudgets`

In the `llm:` block of `bollardYamlSchema`, add:

```typescript
agentBudgets: z.record(z.number().positive()).optional(),
```

#### 2c — Populate `sources` for all default agent assignments

In `resolveConfig`, after building the final `config`, add annotation entries for each default agent assignment so they appear in `config show --sources`:

```typescript
for (const [role, assignment] of Object.entries(config.llm.agents ?? {})) {
  const isOverridden = data?.llm?.agents?.[role] !== undefined
  sources[`llm.agents.${role}.provider`] = {
    value: assignment.provider,
    source: isOverridden ? "file" : "default",
    ...(isOverridden ? { detail: "file:.bollard.yml" } : {}),
  }
  sources[`llm.agents.${role}.model`] = {
    value: assignment.model,
    source: isOverridden ? "file" : "default",
    ...(isOverridden ? { detail: "file:.bollard.yml" } : {}),
  }
}
```

Place this after the YAML loading and env-var application blocks so overrides are reflected correctly.

---

### 3 — `packages/llm/src/client.ts`: enforce agentBudgets (soft, log-only in Phase 5)

`LLMClient.forAgent` already works correctly — it resolves per-agent overrides from `config.llm.agents`. The only change needed is to log a `warn` when an agent's cumulative cost (tracked externally via `CostTracker`) exceeds its budget cap. Since `LLMClient` does not have access to `CostTracker`, this is deferred to Phase 6. **No code changes needed in `client.ts` for Phase 5.**

---

### 4 — `packages/cli/src/agent-handler.ts`: no structural changes needed

`createAgenticHandler` already calls `llmClient.forAgent(agentRole)` for every agent. With the new defaults in place, Haiku will be resolved for planner/testers/reviewer and Sonnet for coder automatically. No code changes needed.

**One important thing to verify:** The `extractionLlm` at line ~458 is `llmClient.forAgent("boundary-tester")`. With the new defaults, this will resolve to Haiku for the type extraction LLM call — which is correct, extraction is structured output from known context.

---

### 5 — `packages/cli/src/init-ide.ts`: update the generated `.bollard.yml` template

Find where the `.bollard.yml` content is assembled in `generateIdeConfigs` (or a helper it calls). Add a commented-out `llm.agents` block that shows the defaults and how to override them:

```yaml
# llm:
#   default:
#     provider: anthropic
#     model: claude-sonnet-4-20250514
#   agents:
#     planner:
#       provider: anthropic
#       model: claude-haiku-4-5-20251001        # cheap; structured output only
#     coder:
#       provider: anthropic
#       model: claude-sonnet-4-20250514          # frontier; creative implementation
#     boundary-tester:
#       provider: anthropic
#       model: claude-haiku-4-5-20251001
#     contract-tester:
#       provider: anthropic
#       model: claude-haiku-4-5-20251001
#     behavioral-tester:
#       provider: anthropic
#       model: claude-haiku-4-5-20251001
#     semantic-reviewer:
#       provider: anthropic
#       model: claude-haiku-4-5-20251001
#   # Uncomment to enable local inference (requires dev-local image):
#   # agents:
#   #   patcher:
#   #     provider: local
#   #     model: qwen2.5-coder-1.5b-instruct-q4_k_m
```

Add this block to the generated `.bollard.yml` for all IDE platforms (`cursor`, `claude-code`, `codex`, `antigravity`). The block should appear near the top of the file, after the `# Bollard configuration` header but before the `toolchain:` block.

---

### 6 — `spec/04-configuration.md`: document per-agent defaults

Find the `llm:` section in `04-configuration.md`. After the existing `agents:` subsection, add a new table showing the Phase 5 defaults:

| Agent role | Default provider | Default model | Rationale |
|---|---|---|---|
| `planner` | `anthropic` | `claude-haiku-4-5-20251001` | Structured JSON output from bounded codebase scan. No multi-step reasoning needed. |
| `coder` | `anthropic` | `claude-sonnet-4-20250514` | Creative implementation. Only agent where frontier quality pays off. |
| `boundary-tester` | `anthropic` | `claude-haiku-4-5-20251001` | Grounded property bodies from type signatures. Boilerplate stripped (Phase 3). |
| `contract-tester` | `anthropic` | `claude-haiku-4-5-20251001` | Same as boundary-tester. |
| `behavioral-tester` | `anthropic` | `claude-haiku-4-5-20251001` | Same as boundary-tester. |
| `semantic-reviewer` | `anthropic` | `claude-haiku-4-5-20251001` | Code review over a diff + metrics. Structured findings; no open-ended generation. |
| `default` (fallback) | `anthropic` | `claude-sonnet-4-20250514` | Safety net for custom blueprint agents not listed above. |

Also add a note: "Override any agent by adding its role to `llm.agents` in `.bollard.yml`. Local-model routing (`provider: local`) requires the `dev-local` image — see `CLAUDE.md` §Three images."

---

### 7 — `CLAUDE.md`: update Stage 5d Phase 5 section

Find the existing "Phase 5 (per-agent model assignment)" entry in the forward roadmap / DO NOT build section. Replace the placeholder with a completed section:

In the "Stage 5d (token economy)" section of the forward roadmap bullet, update from:
```
Phase 5 (per-agent assignment).
```
to:
```
Phase 5 DONE (per-agent model assignment — Haiku for planner/testers/reviewer, Sonnet for coder).
```

Add a new `### Stage 5d Phase 5 (DONE) — Per-Agent Model Assignment:` section (after the Phase 2 section) with:

> Baked Haiku defaults for `planner`, `boundary-tester`, `contract-tester`, `behavioral-tester`, `semantic-reviewer`; Sonnet for `coder`; Sonnet as fallback `default`. All defaults override-able per-agent in `.bollard.yml` `llm.agents`. `BollardConfig.llm.agentBudgets` field added (informational in Phase 5; enforcement is Phase 6). Per-agent sources populated in `resolveConfig` and visible in `config show --sources`. Generated `.bollard.yml` template updated with commented agent block.

Also update the test count line (e.g. "Test count: 997 passed / 6 skipped → 1005 passed / 6 skipped" — adjust to actual after running).

---

### 8 — Tests: update affected tests

#### 8a — `packages/cli/tests/config.test.ts`

The existing tests that assert `DEFAULTS.llm.default.model === "claude-sonnet-4-20250514"` should still pass (the default is unchanged). But tests that check the resolved config for any agent role will now see Haiku instead of Sonnet for planner/testers/reviewer. Scan for any assertion like `expect(config.llm.agents?.planner?.model).toBe(...)` and update accordingly.

Also add new tests:
- `resolveConfig()` returns `planner` assigned to `claude-haiku-4-5-20251001`
- `resolveConfig()` returns `coder` assigned to `claude-sonnet-4-20250514`
- `.bollard.yml` override for `planner` to `claude-sonnet-4-20250514` is respected and reported as `source: "file"`
- `sources["llm.agents.planner.model"]` is present with `source: "default"` when no override is set

#### 8b — `packages/llm/tests/client.test.ts`

`LLMClient.forAgent("planner")` with a config that has per-agent defaults should resolve Haiku. `LLMClient.forAgent("coder")` should resolve Sonnet. Add two tests. Mock the provider resolution (don't touch the actual API keys).

---

## Validation

```bash
# Tests must pass:
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test

# Verify defaults are present in config:
docker compose run --rm dev --filter @bollard/cli run start -- config show --sources | grep "llm.agents"
# Expected: lines for planner (haiku), coder (sonnet), boundary-tester (haiku), etc.

# Verify a live plan call uses Haiku (check the LLM spinner output):
docker compose run --rm -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY dev \
  --filter @bollard/cli run start -- plan --task "Add a no-op ping endpoint"
# The spinner should show the planner agent running. Cost should be meaningfully less than Sonnet.

# Verify init generates the agent block:
docker compose run --rm dev --filter @bollard/cli run start -- init --ide cursor
# Check .cursor/rules/bollard.mdc or generated .bollard.yml for the llm.agents commented block
```

No Bollard-on-Bollard self-test required for Phase 5 — the change is purely default configuration. The first measurable signal comes from comparing `bollard history summary` cost before and after across a handful of runs.

---

## Constraints

- **The coder stays on Sonnet.** Do not route the coder to Haiku or local. The coder's job is genuinely frontier work — multi-step creative implementation over partially-known code. This constraint is load-bearing: Haiku's quality on open-ended coder tasks degrades visibly on anything beyond trivial changes.
- **No new provider instantiation code.** `LLMClient.resolveProvider` already handles all four providers. Phase 5 is config-layer only.
- **`agentBudgets` is parse-and-store only.** Do not add enforcement logic — that is Phase 6. Adding enforcement now would require threading `CostTracker` into `LLMClient`, which is premature.
- **Model strings must be exact.** `"claude-haiku-4-5-20251001"` and `"claude-sonnet-4-20250514"` are the current canonical model IDs in this codebase (see `packages/llm/tests/client.test.ts` smoke tests). Do not introduce new strings.
- **`DEFAULTS` is the only canonical default location.** Do not hardcode model strings anywhere else. If a test or init template needs a model string, import from a shared constant or derive it from `DEFAULTS`.
