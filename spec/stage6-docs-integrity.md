# Stage 6 — Docs integrity (two-layer model)

Bollard maintains **README.md** and **CLAUDE.md** through two complementary layers:

## Layer 1 — `bollard audit-docs` (deterministic)

**Detects** numeric and structural drift. Zero LLM.

Four checks:

1. README MCP tool count vs `packages/mcp/src/tools.ts` (`name: "bollard_"` scan)
2. All `spec/NN-*.md` files linked in README
3. All `spec/adr/NNNN-*.md` files linked in README
4. README ↔ CLAUDE.md test-count consistency

Implementation: `@bollard/engine` (`audit-docs.ts`); CLI shim + `formatAuditDocsResult`. CI: `.github/workflows/bollard-verify.yml`.

## Layer 2 — `bollard curate-docs` (LLM + fact grounding)

**Fixes** subjective drift the deterministic layer cannot: stale stage-status prose, feature sections lagging shipped capabilities, resolved limitations still listed as open.

### Safety thesis

1. **Fact-token grounding on output:** Every number, path, package name, identifier, and stage/phase token in proposed `newText` must appear in the authoritative corpus (`buildDocsCurationCorpus`). Subjective rewording is free; ungrounded facts drop the entire edit (`ungrounded_fact_token`).
2. **Human gate mandatory (Phase 1):** All applies go through `apply-docs-trust-gate` regardless of `takeover.docs.trust`. `silent` and `auto-commit` are parsed but deferred with a warning.

### Pipeline (9 nodes)

`read-ownership-manifest` → `detect-docs-conflicts` → `assess-docs-drift` → `generate-docs-edits` (docs-curator, Sonnet via `llm.default`) → `verify-docs-grounding` → `stage-docs-changes` (`.bollard/curation/docs/`) → human gate → `apply-docs-changes` → `verify-post-apply` (re-run `audit-docs` + ownership claim).

### Surfaces

- CLI: `bollard curate-docs list-drift|run`
- MCP: `bollard_curate_docs` (`dryRun` for corpus + audit only)
- Blueprint: `curate-docs`

See [archive/stage6-curate-docs.md](./archive/stage6-curate-docs.md) for the original implementation prompt.
