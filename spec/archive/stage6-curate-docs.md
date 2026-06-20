---
name: stage6-curate-docs
overview: "Stage 6 docs domain, Layer 2: an LLM curate-docs agent that rewrites stale prose in README.md and CLAUDE.md to match reality. Mirrors the curate-tests feature end to end (agent + engine module + blueprint + CLI + MCP + handler wiring). Safety thesis: full freedom on phrasing/structure, HARD grounding on every fact — any number/version/identifier/capability/stage-claim in proposed new text must be corroborated by an authoritative corpus or the edit is dropped. Human gate is mandatory (no silent apply for prose in Phase 1)."
todos:
  - id: step-1-engine
    content: "Engine module packages/engine/src/docs-curation.ts: types, buildDocsCurationCorpus, parseDocsCurationPlan, verifyDocsCurationGrounding (fact-token grounding), extractFactTokens. +unit tests."
    status: pending
  - id: step-2-agent
    content: "docs-curator agent + prompt (no tools, fenced JSON edits with old_text/new_text/justification+grounding, ADR-0003 self-check). Register in agent-handler + buildDocsCuratorMessage + dispatch block."
    status: pending
  - id: step-3-blueprint
    content: "curate-docs blueprint mirroring curate-tests 9-node shape; trust gate review-only in Phase 1 (silent/auto-commit fall to human gate); staging under .bollard/curation/docs/."
    status: pending
  - id: step-4-cli-mcp
    content: "CLI bollard curate-docs (list-drift / run) + MCP bollard_curate_docs (dryRun). Wire into index.ts and tools.ts."
    status: pending
  - id: step-5-validate
    content: "Re-run audit-docs after apply (must pass), fixture before/after, full suite, mandatory human spot-check packet of every proposed rewrite."
    status: pending
  - id: step-6-docs
    content: "CLAUDE.md + ROADMAP (mark docs Layer 2 done), spec/09 or a short design note, archive prompt, commits."
    status: pending
isProject: false
---

# Stage 6 docs Layer 2 — `curate-docs`

## What this is

The LLM complement to `audit-docs` (deterministic Layer 1, which only *detects* numeric/structural drift). `curate-docs` *fixes* subjective drift in **README.md and CLAUDE.md** — stale stage-status prose, feature sections that lag shipped capabilities, outdated counts, resolved "known limitations" still listed as open. Scope is exactly those two files; nothing else.

This mirrors the **curate-tests** feature (Stage 6 Phase 2) end to end. Use it as the structural template for every piece — same agent shape, same grounding-verifier pattern, same blueprint node sequence, same trust gate, same CLI/MCP surface. Where this prompt says "mirror curate-X", read the real file and copy its structure.

| New file | Mirrors |
|---|---|
| `packages/engine/src/docs-curation.ts` | `packages/engine/src/test-quality.ts` |
| `packages/agents/src/docs-curator.ts` + `prompts/docs-curator.md` | `test-curator.ts` + `prompts/test-curator.md` |
| `packages/blueprints/src/curate-docs.ts` (+ `docs-curation-helpers.ts`) | `curate-tests.ts` (+ `curation-helpers.ts`) |
| `packages/cli/src/curate-docs.ts` | `curate.ts` |
| MCP `bollard_curate_docs` in `tools.ts` | `bollard_curate_tests` |
| agent-handler registration + `buildDocsCuratorMessage` | `test-curator` wiring in `agent-handler.ts` |

## THE SAFETY THESIS — read before writing the agent

A prose-rewriting LLM can hallucinate capabilities into your canonical docs. That is the failure mode this design exists to prevent. Two non-negotiable guardrails:

1. **Fact-grounding on the OUTPUT, not just the input.** The curate-tests grounding pattern verifies that a claim's `grounding[].quote` is a verbatim substring of a corpus. That works for discrete claims but NOT for free prose (new prose is, by definition, not a verbatim quote of anything). So `curate-docs` grounds differently: it extracts every **fact-token** from the proposed `new_text` — numbers, version strings, percentages, file paths, package names, PascalCase/camelCase identifiers, capability/stage names — and requires each to appear in the **authoritative reality corpus**. Subjective/connective prose ("powerful", "robust", reworded sentences) is free; **factual tokens must corroborate or the whole edit is dropped.** An agent cannot write "now supports Ruby" unless "Ruby"/a ruby detector actually exists in the corpus.

2. **Human gate mandatory in Phase 1.** Unlike curate-tests (which allows `silent`), `curate-docs` routes through a `human_gate` regardless of `takeover.docs.trust` — `silent` and `auto-commit` are parsed but fall to review with a yellow warning (exactly how `auto-commit` is deferred for tests). A prose rewrite must be human-approved before it touches a canonical doc. Document this clearly.

## Step 1 — Engine module `packages/engine/src/docs-curation.ts`

Mirror `test-quality.ts`. Types:

```ts
export interface DocsEdit {
  id: string
  file: "README.md" | "CLAUDE.md"        // path allowlist enforced at parse time
  oldText: string                         // exact existing text to replace (must match the file verbatim)
  newText: string                         // the rewrite
  rationale: string                       // why it's stale (human-readable)
  grounding: Array<{ quote: string; source: "claude-md" | "roadmap" | "code" | "audit" }>
}
export interface DocsCurationPlan { edits: DocsEdit[] }
export interface DocsGroundingResult {
  kept: DocsEdit[]
  dropped: Array<{ id: string; reason: "grounding_not_in_corpus" | "ungrounded_fact_token" | "old_text_not_in_file" | "file_not_allowed"; detail?: string }>
}
```

Functions:

- `buildDocsCurationCorpus(opts): string` — the authoritative reality bundle the agent reasons against AND the verifier grounds against. Include: full current `CLAUDE.md` (the canonical state-of-truth), `spec/ROADMAP.md`, the deterministic facts `audit-docs` already computes (test count, adversarial count, MCP tool count, the `spec/NN-*.md` + `spec/adr/NNNN-*.md` file lists), the package list (`packages/*` dir names), and the CLI command list (scan `index.ts` `if (command === "...")`). This is the same "broaden the corpus with real source text" move as the review-grounding fix — the corpus must contain reality so true rewrites ground and false ones don't.
- `extractFactTokens(text: string): string[]` — pull numbers (incl. `1555`, `v4.2.2`, `87%`), file paths, package names (`@bollard/*`), PascalCase/camelCase identifiers (≥4 chars, reuse the review-grounding identifier regex discipline), and explicit stage/phase tokens (`Stage 5e`, `Phase 6`). Exclude common English words.
- `verifyDocsCurationGrounding(plan, corpus, fileContents): DocsGroundingResult` — for each edit: (a) `file` must be in the allowlist (else `file_not_allowed`); (b) `oldText` must be a verbatim substring of the named file's current contents (else `old_text_not_in_file` — prevents edits to text that doesn't exist); (c) every `grounding[].quote` must be `corpus.includes(quote)` (else `grounding_not_in_corpus`); (d) **every fact-token from `extractFactTokens(newText)` must appear in the corpus** (else `ungrounded_fact_token`, with the offending token in `detail`). All four must pass to keep. This (d) is the hallucination guard.
- `parseDocsCurationPlan(raw: string): DocsCurationPlan` — strip fences, validate schema, throw `BollardError({ code: "CURATION_OUTPUT_INVALID" })` on failure (reuse the existing code).

Unit tests (`packages/engine/tests/docs-curation.test.ts`): fact-token extraction; a real-rewrite edit kept; a hallucinated-capability edit dropped on `ungrounded_fact_token` (THE safety test — must exist); an `oldText`-not-in-file edit dropped; a non-allowlisted file dropped; corpus includes the expected reality signals.

## Step 2 — Agent `packages/agents/src/docs-curator.ts` + prompt

Mirror `createTestCuratorAgent`: `{ role: "docs-curator", systemPrompt, tools: [], maxTurns: 10, maxTokens: 8192, temperature: 0.3 }`. Add `docs-curator` to `role-requirements.ts` only if it should be Haiku — but **this agent reasons over large docs and rewrites prose, which is reasoning-heavy; leave it to resolve to `llm.default` (Sonnet) by NOT adding a requirements entry**, matching test-curator. Note that in the prompt's header comment.

`packages/agents/prompts/docs-curator.md` instructs:
- Input: the current README.md + CLAUDE.md content, and the authoritative reality corpus (CLAUDE.md state, ROADMAP, computed facts, package/command lists).
- Task: find sections of README/CLAUDE.md that contradict reality and propose targeted `oldText → newText` edits. Rewrite freely for clarity, BUT every factual assertion in `newText` must be traceable to the corpus. Do not introduce any capability, count, version, or status not present in the corpus.
- Output: one fenced ```json doc, `{ "edits": [{ id, file, oldText, newText, rationale, grounding: [{quote, source}] }] }`. `oldText` must be copied verbatim from the file. Each edit needs ≥1 grounding quote from the corpus proving the new state is real.
- ADR-0003 self-check ("BEFORE EMITTING"): every `oldText` is a real substring of the named file; every fact in `newText` (numbers, names, versions, capabilities) appears in the corpus; no invented capabilities; files limited to README.md/CLAUDE.md; grounding quotes are verbatim.

Wire into `agent-handler.ts`: register `"docs-curator": await createDocsCuratorAgent(profile)` in the `agents` map; add `buildDocsCuratorMessage(ctx)` (reads `ctx.results["assess-docs-drift"].data` corpus + current file contents); add the `if (agentRole === "docs-curator") { userMessage = buildDocsCuratorMessage(ctx) }` dispatch block.

## Step 3 — Blueprint `packages/blueprints/src/curate-docs.ts`

Mirror the 9-node curate-tests shape (`maxCostUsd: 2`, `maxDurationMinutes: 10`). `const trust = config.takeover?.docs?.trust ?? "review"`. Nodes:

1. `read-ownership-manifest` — `FileOwnershipStore.read()`.
2. `detect-docs-conflicts` (`onFailure: "skip"`) — `detectManagedFileConflicts`; warn only.
3. `assess-docs-drift` (deterministic) — build the corpus (`buildDocsCurationCorpus`) + read current README/CLAUDE.md; emit them for the agent. (Optionally run `auditDocs` here and include its failures as a strong signal.)
4. `generate-docs-edits` (**agentic**, `agent: "docs-curator"`).
5. `verify-docs-grounding` (deterministic, `onFailure: "skip"`) — `parseDocsCurationPlan` + `verifyDocsCurationGrounding`; log `docs_curation_grounding_result { proposed, grounded, dropped }`; `skipped: true` if zero kept.
6. `stage-docs-changes` (deterministic) — write proposed edits under `.bollard/curation/docs/plan.json` + a unified-diff preview per file (apply `oldText→newText` to a staged copy). Do NOT touch the real files yet.
7. `apply-docs-trust-gate` — **always the `human_gate` variant in Phase 1.** Even if `trust === "silent"`, use the human gate and emit a yellow warning that silent docs apply is unsupported in Phase 1. The gate shows the staged diffs; rejection returns `{ rejected: true, applied: [] }`.
8. `apply-docs-changes` (deterministic, runs only if not rejected) — apply each kept edit's `oldText→newText` to the real file (verify `oldText` still matches before replacing; skip + warn if the file changed under it).
9. `verify-post-apply` (deterministic) — **re-run `auditDocs(workDir)`; if it now fails, this is a hard error** (`CURATION_OUTPUT_INVALID` or a new code) — the rewrite must not introduce new deterministic drift. Then `update-ownership-manifest`: `store.claim(file, "docs", runId, headSha)` for each applied file.

`CURATION_NO_PROGRESS` when nothing grounded/applied. Add `docs-curation-helpers.ts` for staging (mirror `curation-helpers.ts`): `DOCS_CURATION_STAGING_DIR = ".bollard/curation/docs"`, staged plan read/apply.

## Step 4 — CLI + MCP

- `packages/cli/src/curate-docs.ts`: `runCurateDocsCommand(rest, workDir)` with subcommands `list-drift` (dry — build corpus, run `auditDocs`, show drift signals, no agent) and `run` (full blueprint). Mirror `curate.ts`. Wire into `index.ts` (`if (command === "curate-docs")`).
- MCP `bollard_curate_docs` in `tools.ts`: `z.object({ workDir: z.string().optional(), dryRun: z.boolean().optional() })`; `dryRun: true` → corpus + audit-docs result + drift summary, no staging; `dryRun: false` → run pipeline. Mirror `bollard_curate_tests`.

## Step 5 — Validation gate

1. `docker compose run --rm dev run typecheck && ... lint && ... test` — full suite ≥ 1555 + new tests / 6 skip.
2. **The safety unit test must pass:** a hallucinated-capability edit is dropped on `ungrounded_fact_token`. This is the proof the prose rewriter can't invent facts.
3. **Live dry run:** `bollard curate-docs list-drift` — confirm it surfaces real drift without writing.
4. **Live full run** on the real repo (review gate): `bollard curate-docs run`. At the human gate, inspect the staged diffs. Produce a spot-check packet (`packages/verify/tests/fixtures/docs-curation/spot-check.md` or similar) listing every proposed edit with its grounding — same human-gate discipline as the review-grounding fix. **Mandatory human read:** every applied rewrite must be a factual improvement, zero invented claims. Reject the run if any edit hallucinates.
5. **Post-apply `audit-docs` must stay green** — node 9 enforces this; confirm in the run.

## Step 6 — Close out

1. `CLAUDE.md`: add a Stage 6 docs Layer 2 entry (curate-docs: agent + blueprint + fact-grounding verifier + review-only trust); update test count. (Ironic but fitting: curate-docs's own arrival is a CLAUDE.md edit.)
2. `spec/ROADMAP.md`: mark the docs-domain Layer 2 done; note `silent`/`auto-commit` for docs deferred (Phase 1 is review-only).
3. Short design note in `spec/` (or extend the audit-docs section) describing the two-layer docs-integrity model: audit-docs (deterministic, detects) + curate-docs (LLM, fixes, fact-grounded, human-gated).
4. Archive this prompt → `spec/archive/`. Commits: (1) engine + agent + blueprint + helpers + tests, (2) CLI + MCP + handler wiring + tests, (3) docs. Or two commits (code, docs) if cleaner.

## Out of scope — DO NOT

- DO NOT let the agent touch any file other than README.md / CLAUDE.md (enforce the allowlist in the verifier AND the apply node).
- DO NOT allow `silent`/`auto-commit` to bypass the human gate in Phase 1 — prose apply is human-reviewed, full stop.
- DO NOT weaken the fact-token grounding to raise the kept rate — an ungrounded fact is a potential hallucination; dropping it is correct. If the agent's good edits get dropped, BROADEN THE CORPUS (add the missing real source), never loosen the check (the review-grounding lesson).
- DO NOT regenerate whole files — edits are scoped `oldText→newText` replacements only.
- DO NOT change the deterministic `audit-docs` behavior; curate-docs consumes it, doesn't modify it.
- DO NOT touch the other curate-tests / graders code paths.
