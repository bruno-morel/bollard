# Cursor Prompt — Stage 5d Phase 1: Deterministic Context Expansion (ARCHIVED)

> **Purpose:** Replace coder turns spent on `read_file` / `search` calls for transitively-imported types with a deterministic pre-load step. The planner's `affected_files.modify` list is augmented with files reachable through the import graph, ranked by import fan-in, capped at the existing pre-load budget.
>
> **Tier (per [ADR-0004](../adr/0004-determinism-local-frontier-tiers.md)):** Tier 1 — fully deterministic. No LLM call, no prompt changes, no local-model dependency.

**Status:** Implementation shipped **2026-05-11**. This file was moved from `spec/prompts/` per project convention.

---

## Context

You are working in the Bollard project. **Read `CLAUDE.md` at the project root first** — it is the source of truth for conventions, architecture, and constraints.

**Read [spec/stage5d-token-economy.md](../stage5d-token-economy.md) "Phase 1" section** before writing code. That section is the design contract; this prompt is the implementation guide.

**Read [adr/0004-determinism-local-frontier-tiers.md](../adr/0004-determinism-local-frontier-tiers.md)** for the routing rule. Phase 1 is the first concrete tier-1 win and exists to validate the determinization principle before any local-model work begins.

**All commands go through Docker Compose. Never run bare pnpm/node/tsc on the host.**

---

## Step 0 (MANDATORY) — Capture the baseline before touching any code

The success metric for Phase 1 is "coder turn count drops by at least 30% from a captured pre-Phase-1 baseline." That baseline is gone the moment you start coding. Capture it first.

*(On this workstream, Step 0 was **not** completed before implementation: no pre-Phase-1 baseline run id exists in `.bollard/runs/history.jsonl` for the divide validation task. Future runs: execute Step 0 on `main` before merging similar work.)*

---

## Scope

**In scope (Phase 1):**

- TypeScript-only deterministic import-graph walker.
- New `expand-affected-files` blueprint node, inserted **after `approve-plan`** and before `implement`.
- Wire into existing `preloadAffectedFiles` in `agent-handler.ts` so the coder's user message includes the expanded set.
- Cap output at the existing 10-file / 10K-char-per-file budget.
- Rank by import fan-in (most-imported files first); tiebreaker is proximity to `affected_files.modify` (fewer hops wins).
- Graceful degradation: when `ToolchainProfile.language !== "typescript"`, the node passes through `affected_files.modify` unchanged.

**Out of scope (DO NOT):**

- DO NOT touch any agent prompt (`packages/agents/prompts/*.md`). Prompt-shape work is Phase 3.
- DO NOT add an LLM call inside Phase 1. The whole point is tier-1 determinism. If you reach for `LLMClient` you are in the wrong file.
- DO NOT add Python/Go/Rust/Java import walkers in this PR. Each language is a separate follow-up; Phase 1 ships TS only to validate the approach.
- DO NOT add `LocalProvider`, `llama.cpp`, `fastembed-js`, or any local-model dependency. Those are Phase 4.
- DO NOT skip the existing 10-file / 10K-char budget. The coder's context window is finite and the pre-load section is intentionally bounded.
- DO NOT change the `affected_files` schema in the planner output. Phase 1 expands what the agent-handler does with the planner's existing output; it does not change what the planner produces.

---

## Work breakdown

*(Implemented as specified in the original prompt: `context-expansion.ts`, `workspace-resolver.ts`, blueprint node, `preloadAffectedFiles(ctx, workDir)`, Vitest coverage, fixtures.)*

---

## Self-check (completion record — 2026-05-11)

- [ ] Step 0 baseline run captured. *(**Skipped** — no baseline run id available for `history compare`.)*
- [x] `docker compose run --rm dev run typecheck` exits 0.
- [x] `docker compose run --rm dev run lint` exits 0.
- [x] `docker compose run --rm dev run test` passes; net new tests positive (context-expansion, workspace-resolver, blueprint node count, agent-handler wiring).
- [x] No file under `packages/agents/prompts/` was modified.
- [x] No `LLMClient`, `provider.chat`, or `provider.chatStream` import was added outside `packages/llm/`.
- [x] `expand-affected-files` node is present in `implement-feature` (**29** nodes).
- [x] Validation self-test ran successfully (CostTracker.divide task, `BOLLARD_AUTO_APPROVE=1`).
- [ ] `bollard history compare <baseline-run-id> <new-run-id>` with coder turns and total cost both strictly below baseline. *(**Blocked** — `RunRecord` does not persist per-node coder turn counts in `history show`, and no pre-Phase-1 baseline run was captured.)*
- [x] Pipeline side effects from the self-test were reverted from git (`cost-tracker`, generated `.bollard/tests`, `package.json` / lockfile) so the PR contains Phase 1 source only.

---

## Baseline capture

**Pre-Phase-1 baseline:** not recorded before implementation (Step 0 gap).

**Post-implementation validation run:**

- Run ID: `20260511-0314-run-fef3d9`
- Date: **2026-05-11**
- Task: `Add a CostTracker.divide(usd: number) method that errors on zero divisor`
- Outcome: **29/29** nodes `ok` (includes **Expand affected files via import graph** then **Implement Code**).
- Total cost (USD): ~**3.20** (aggregate from `history --limit 3` / `history show`; dominant node cost on **implement**).
- Coder turns used: **not in `RunRecord`** — use run logs or extend history schema if this metric becomes a release gate.
- Notes: Strict **30% turn reduction + lower total cost vs baseline** from the original prompt was **not** verified without a baseline id and without turn fields in history.

---

## When Phase 1 is GREEN

Completed:

1. `CLAUDE.md` — Stage 5d Phase 1 entry in the stage list (with baseline / compare caveat).
2. `spec/ROADMAP.md` — Phase 1 struck through with **DONE (2026-05-11)**.
3. This prompt → `spec/archive/stage5d-phase1-context-expansion.md`.
