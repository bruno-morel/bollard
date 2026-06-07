# Stage 6 docs Layer 1 — `bollard audit-docs` (archived prompt)

> Shipped 2026-06-07. Layer 1 deterministic doc-stats audit — four checks, zero LLM, CI in `bollard-verify.yml`.

## Goal

Deterministic guard against README drift (2026-06-05 incident). Mirrors `bollard audit-protocol` shape.

## Checks

1. **mcp-tool-count** — README claim vs `packages/mcp/src/tools.ts` text scan (`/name: "bollard_/g`). No cli→mcp import (circular dep).
2. **spec-doc-links** — every `spec/NN-*.md` linked in README
3. **adr-links** — every `spec/adr/NNNN-*.md` linked in README
4. **test-count-consistency** — README vs CLAUDE.md main + adversarial counts

## Files

- `packages/cli/src/audit-docs.ts`
- `packages/cli/tests/audit-docs.test.ts`
- `.github/workflows/bollard-verify.yml` (audit-docs step)

## Out of scope

Layer 2 `curate-docs` agent, `takeover.docs`, auto-fix, separate workflow.
