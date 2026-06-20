---
name: adr0006-increment3-curate-tiers
overview: "ADR-0006 increment 3: make curate-docs consume resolveCuratableDocs and its tiers. Widen editable scope from hardcoded README+CLAUDE to the full curate tier; make detect-only (specs/ADRs) report-only and NEVER editable (the core ADR-0006 safety line); never-touch stays invisible. Replaces the DocsEditFile literal-union pin with a resolver-driven runtime allowlist."
todos:
  - id: step-1-widen-type
    content: "Replace DocsEditFile union with string; make verifyDocsCurationGrounding gate 1 a resolver-driven runtime allowlist (curate-tier set); fix resolveCuratableDocs to honor its homes opt."
    status: pending
  - id: step-2-dynamic-corpus
    content: "buildDocsCurationCorpus reads the curate-tier file set dynamically (not fixed README/CLAUDE/ROADMAP); returns per-file contents map + corpus + detect-only file list."
    status: pending
  - id: step-3-blueprint-agent
    content: "Blueprint nodes + buildDocsCuratorMessage + docs-curator.md prompt use the resolved curate-tier set, not README/CLAUDE literals. Surface detect-only as a report, never fed to the agent for edits."
    status: pending
  - id: step-4-tests
    content: "Safety test: edit targeting a detect-only or never-touch file is dropped file_not_allowed. Resolver-driven scope tests. Update all DocsEditFile-shaped tests."
    status: pending
  - id: step-5-validate
    content: "typecheck/lint/test; live run shows curate-tier docs editable + detect-only listed-not-edited; audit-docs green; close out."
    status: pending
isProject: false
---

# ADR-0006 increment 3 — curate-docs consumes resolver tiers

Implements [spec/adr/0006-docs-curation-scope.md](../adr/0006-docs-curation-scope.md) Action Item 3. Increments 1-2 (resolver + `audit-docs` checks) are shipped. The resolver (`packages/engine/src/docs-resolver.ts`) is currently **dead-ended** — `resolveCuratableDocs` is never called by curate-docs. This wires it in.

## The decision this makes real

ADR-0006's core safety distinction is **curate (rewrite) vs detect-only (report, never rewrite)**. Right now curate-docs hardcodes scope to README+CLAUDE (both curate-tier), so the distinction has never been exercised. Increment 3:

- **curate tier → editable** (widen from 2 files to the full resolved set: root docs, `docs/`, package READMEs, `spec/README.md`).
- **detect-only tier → report-only, NEVER editable** (`spec/0N-*.md`, `spec/adr/*`, ROADMAP). The agent is not given these to rewrite; an edit targeting one is dropped. They may be *surfaced* as drift to review, but auto-rewriting an intent doc is the failure ADR-0006 forbids.
- **never-touch → invisible** (archive, `*-results`, generated, functional `.md`).

This is the safety line. The proof it holds is a test: an edit whose `file` is a detect-only or never-touch path is dropped `file_not_allowed`.

## The structural blocker

`packages/engine/src/docs-curation.ts:6` — `export type DocsEditFile = "README.md" | "CLAUDE.md"`. This literal union forces `Record<DocsEditFile, string>` through the blueprint, helpers, agent-handler. **Replace `DocsEditFile` with `string`** and move enforcement from the *type* to a *runtime allowlist* derived from the resolver's curate-tier set. The 9 hardcode sites (from research):

| File | Line(s) | Change |
|---|---|---|
| `packages/engine/src/docs-curation.ts` | 6 | `DocsEditFile` → `string` (alias kept for readability is fine, but no longer a literal union) |
| `packages/engine/src/docs-curation.ts` | 32 | `ALLOWED_FILES` set → passed-in resolved curate set |
| `packages/engine/src/docs-curation.ts` | 147-149 | dynamic curate-tier reads, not fixed README/CLAUDE/ROADMAP |
| `packages/engine/src/docs-curation.ts` | 282 | `isValidDocsEdit` file check → no literal check (runtime allowlist enforces) |
| `packages/blueprints/src/curate-docs.ts` | 68, 140-143, 178-181 | `docPaths` / `fileContents` maps → resolved curate set |
| `packages/blueprints/src/docs-curation-helpers.ts` | 66 | `stageDocsEdits` loop over resolved files, not `["README.md","CLAUDE.md"]` |
| `packages/agents/prompts/docs-curator.md` | 35,40,53,81 | scope language → "only the files listed in your message" |
| `packages/cli/src/agent-handler.ts` | 605-609 | emit all curate-tier file contents, not just README/CLAUDE |

## Step 1 — Widen the type + resolver-driven allowlist

1. `docs-curation.ts`: `DocsEditFile` → `string` (or `type DocsEditFile = string`). `DocsEdit.file: string`. Remove the literal check in `isValidDocsEdit` (line 282) — schema validation no longer pins the filename; the runtime allowlist does.
2. `verifyDocsCurationGrounding(plan, corpus, fileContents, allowedFiles: Set<string>)` — add an `allowedFiles` param (the resolved curate-tier set). Gate 1 (`file_not_allowed`) becomes `if (!allowedFiles.has(edit.file))`. This is where detect-only/never-touch edits are dropped.
3. **Fix `resolveCuratableDocs` to honor its `homes` opt** — it currently ignores `_opts` (underscore-prefixed). Wire `opts.homes` into `classifyDocPath` / `isDocAtHome` so `config.docs?.homes` actually affects resolution.
4. New helper in `docs-curation.ts` (or import from resolver): `resolveCurateScope(workDir, homes?): Promise<{ editable: string[]; detectOnly: string[] }>` — `editable = classifications.filter(c => c.eligible && c.tier === "curate").map(c => c.path)`; `detectOnly = … tier === "detect-only"`.

## Step 2 — Dynamic corpus + per-file contents

`buildDocsCurationCorpus({ workDir, docHomes? })`:

- Resolve the curate scope. Read **each editable file's** current content into a `Record<string,string>` (replaces the fixed `readmeContent`/`claudeContent` fields — return `fileContents: Record<string,string>` instead).
- Corpus (the authoritative reality bundle) is unchanged in spirit but should still include CLAUDE.md and ROADMAP as **source-of-truth context even though they're editable/detect-only respectively** — the corpus is "reality to ground against," a superset of the editable set. Keep CLAUDE.md, ROADMAP, audit facts, package list, CLI commands. Append each editable file's content (so cross-file facts ground).
- Also return `detectOnly: string[]` so the pipeline can surface it.

Downstream (`assess-docs-drift`, grounding node, staging node) consume `fileContents` (the map) and the resolved `allowedFiles` set instead of the two hardcoded names.

## Step 3 — Blueprint, message, prompt

- **Blueprint** (`curate-docs.ts`): node 2 `detect-docs-conflicts` iterates the resolved editable set, not `["README.md","CLAUDE.md"]`. Nodes 5/6 build `fileContents` and `allowedFiles` from `ctx.results["assess-docs-drift"].data` (which now carries the resolved scope). Thread `allowedFiles` into `verifyDocsCurationGrounding`. Node 9 `verify-post-apply` claims ownership per applied file (already per-file, just no longer typed to two names).
- **Detect-only surfacing:** `assess-docs-drift` includes the `detectOnly` list in its data; the human gate / `list-drift` output prints it as: "detect-only tier (NOT auto-curated — review manually for drift): spec/01-…, spec/adr/…". The agent is **never given these files to edit.** (An LLM-driven drift *report* on detect-only docs is a clean follow-up — increment 3b — explicitly out of scope here.)
- **Message** (`buildDocsCuratorMessage`): replace the two `## README.md`/`## CLAUDE.md` blocks with a loop over the editable `fileContents` map — one `## <path> (current)` block per curate-tier file. Keep the corpus block.
- **Prompt** (`docs-curator.md`): replace all README/CLAUDE scope language (lines 35,40,53,81) with "you may only propose edits to the files presented under `## <path> (current)` blocks in your message; never invent a path." Keep every other guardrail (fact grounding, verbatim oldText, ADR-0003 self-check).

## Step 4 — Tests (the safety line is the gate)

- **Safety test (mandatory):** `verifyDocsCurationGrounding` with an edit whose `file` is `spec/01-architecture.md` (detect-only) → dropped `file_not_allowed`; same for an archive/never-touch path. This proves intent-docs can't be rewritten even if the agent proposes it.
- **Scope test:** `resolveCurateScope` on a fixture tree classifies a package README as editable, `spec/01-*.md` as detect-only (not editable), an archive file as neither.
- **Editable-widening test:** an edit to a non-README/CLAUDE curate-tier file (e.g. `CONTRIBUTING.md` or `docs/foo.md`) is *kept* when grounded (proves scope widened).
- Update every `DocsEditFile`-shaped test + the `auditResult.checks.length` assertions if touched. `homes`-honoring resolver test.

## Step 5 — Validate + close out

1. `docker compose run --rm dev run typecheck && … lint && … test` — full suite green; safety test passes.
2. `docker compose run --rm dev --filter @bollard/cli run start -- curate-docs list-drift` — confirm it now reports the editable curate set AND lists detect-only docs separately as "not auto-curated."
3. Live `curate-docs run` (your key, human gate): confirm it proposes edits across curate-tier docs (not just README/CLAUDE) and that **no detect-only doc ever appears in the staged edits.** Spot-check the gate diffs as before.
4. `audit-docs` exit 0 after.
5. Close out: `CLAUDE.md` (curate-docs now resolver-driven, tiers live; detect-only never rewritten), `spec/ROADMAP.md` (ADR-0006 item 3 done), ADR-0006 (check item 3), `spec/stage6-docs-integrity.md` (tier behavior). Archive this prompt. Commits: (1) engine type-widen + resolver scope + corpus, (2) blueprint + helpers + agent + prompt, (3) docs. Targeted `git add`, no `.bollard/`.

## Out of scope

- LLM-driven drift *report* on detect-only docs (increment 3b) — this increment only *lists* them, never edits or analyzes them with the LLM.
- Auto-move of stray docs (ADR-0006 deferred).
- Any change to the `audit-docs` deterministic checks (increments 1-2, done).
- Widening the corpus beyond the editable set + existing reality sources.

## Watch-outs

- **Token budget:** the corpus already runs ~200k chars with CLAUDE.md; adding all curate-tier file contents to the message grows it. If a curate run gets large, that's a real cost — note it; a per-run file cap is a possible follow-up, not part of this increment.
- **Human-gate burden:** widening to N files means potentially many staged edits. Acceptable for Phase 1 (human reviews them), but flag if the first live run produces an unwieldy diff set.
- **`verify-post-apply` advisory filter:** keep advisory checks (`link-orphans`, `doc-placement`) excluded from `allPassed` so post-apply audit isn't blocked by non-fatal warnings (the increment-2 risk note).
