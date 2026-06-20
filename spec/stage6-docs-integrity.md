# Stage 6 — Docs integrity (two-layer model)

Bollard maintains canonical docs through two complementary layers. Layer 2 edits the **curate tier** (root docs, `docs/`, package READMEs, etc.) — not only README and CLAUDE.

## Layer 1 — `bollard audit-docs` (deterministic)

**Detects** numeric and structural drift. Zero LLM.

Hard checks (fail the build):

1. README MCP tool count vs `packages/mcp/src/tools.ts` (`name: "bollard_"` scan)
2. All `spec/NN-*.md` files linked in README
3. All `spec/adr/NNNN-*.md` files linked in README
4. README ↔ CLAUDE.md test-count consistency
5. **link-integrity** — every relative link in the eligible doc set resolves on disk (doc→doc and doc→code)

Advisory checks (report only):

6. **link-orphans** — eligible docs unreachable from README / CLAUDE / CONTRIBUTING via `.md` links
7. **doc-placement** — eligible docs outside `docs.homes` and not at repo root

Eligible set: `resolveCuratableDocs` (exclusion zones, `*-results` denylist, `curate:`/`tier:` front-matter). Config: `docs.homes` in `.bollard.yml` (default `["docs", "spec"]`).

Implementation: `@bollard/engine` (`docs-resolver.ts`, `audit-docs.ts`); CLI shim + `formatAuditDocsResult`. CI: `.github/workflows/bollard-verify.yml`. Design: [adr/0006-docs-curation-scope.md](./adr/0006-docs-curation-scope.md).

## Layer 2 — `bollard curate-docs` (LLM + fact grounding)

**Fixes** subjective drift the deterministic layer cannot: stale stage-status prose, feature sections lagging shipped capabilities, resolved limitations still listed as open.

### Safety thesis

1. **Fact-token grounding on output:** Every number, path, package name, identifier, and stage/phase token in proposed `newText` must appear in the authoritative corpus (`buildDocsCurationCorpus`). Subjective rewording is free; ungrounded facts drop the entire edit (`ungrounded_fact_token`).
2. **Human gate mandatory (Phase 1):** All applies go through `apply-docs-trust-gate` regardless of `takeover.docs.trust`. `silent` and `auto-commit` are parsed but deferred with a warning.

### Tier behavior (ADR-0006 increment 3)

`resolveCurateScope` drives Layer 2 scope:

| Tier | LLM action |
|------|------------|
| **curate** | Editable — agent receives file contents; `verifyDocsCurationGrounding` enforces runtime allowlist |
| **detect-only** | Report only — listed by `list-drift`, never sent to the agent; edits targeting these paths drop `file_not_allowed` |
| **never-touch** | Invisible — excluded from resolver eligible set |

### Drift-targeted selection (ADR-0006 increment 3b)

`selectDriftCandidates` chooses which **curate-tier** docs the agent receives (not the full tier every run):

- **Audit implication:** failing content-drift checks (`link-integrity` owners, README/CLAUDE for test-count, README for MCP/spec/ADR link checks). `doc-placement` stays advisory-only in `list-drift` — not an LLM candidate.
- **Git staleness:** doc last-commit older than newest referenced code (markdown doc→code links; package README also checks `packages/<name>/src/`).
- **Empty candidates** → `CURATION_NO_PROGRESS` (agent skipped, zero LLM cost).
- **`--all`** — deliberate full curate-tier sweep (high token cost).

`list-drift` prints **drift candidates** (paths + reasons), then full editable and detect-only lists.

### Pipeline (9 nodes)

`read-ownership-manifest` → `detect-docs-conflicts` → `assess-docs-drift` → `generate-docs-edits` (docs-curator, Sonnet via `llm.default`) → `verify-docs-grounding` → `stage-docs-changes` (`.bollard/curation/docs/`) → human gate → `apply-docs-changes` → `verify-post-apply` (re-run `audit-docs` + ownership claim).

### Surfaces

- CLI: `bollard curate-docs list-drift|run [--all]`
- MCP: `bollard_curate_docs` (`dryRun` for corpus + audit + candidates; `all` for full tier)
- Blueprint: `curate-docs`

See [archive/stage6-curate-docs.md](./archive/stage6-curate-docs.md) for the original implementation prompt.
