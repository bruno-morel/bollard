---
name: adr0006-docs-resolver-and-checks
overview: "ADR-0006 increments 1-2 (deterministic, no LLM): a doc-set resolver that separates real docs from functional .md, a docs.homes config block, and two new audit-docs checks — link-integrity (dangling doc→doc and doc→code links) and doc-placement (eligible docs outside the configured homes). ADR-0006 is intentionally left unlinked in README as the live validation fixture; the new checks must flag it, then the PR links it to restore green."
todos:
  - id: step-1-resolver
    content: "packages/engine/src/docs-resolver.ts: resolveCuratableDocs + DocClassification (zones + *-results denylist + curate:/tier: front-matter). Pure, unit-tested."
    status: pending
  - id: step-2-config
    content: "docs: config block (homes, defaulted [docs, spec]) in cli/config.ts; thread docHomes into auditDocs options."
    status: pending
  - id: step-3-link-integrity
    content: "audit-docs link-integrity check: every relative link (doc→doc + doc→code) in the eligible set resolves on disk; dangling = fail; orphan (unreachable from roots) = advisory."
    status: pending
  - id: step-4-doc-placement
    content: "audit-docs doc-placement check: eligible docs outside docs.homes and not at root = flagged (advisory default)."
    status: pending
  - id: step-5-validate-and-link
    content: "Confirm new checks flag the unlinked ADR-0006 fixture + an intentional dangling-link fixture; unit tests; THEN link ADR-0006 in README+CLAUDE to restore green; full suite + audit-docs exit 0."
    status: pending
isProject: false
---

# ADR-0006 increments 1-2 — deterministic doc resolver + audit-docs checks

Implements [spec/adr/0006-docs-curation-scope.md](../adr/0006-docs-curation-scope.md) Action Items 1 and 2 only. **No LLM, no agent changes** — this is the deterministic foundation. Increment 3 (curate-docs consuming the resolver + tiers) is a later PR.

`audit-docs` already lives in `packages/engine/src/audit-docs.ts` (CLI shim at `packages/cli/src/audit-docs.ts`). Existing checks: `mcp-tool-count`, `spec-doc-links`, `adr-links`, `test-count-consistency` — each a `check*(...) → DocsCheckResult` function. Mirror that shape exactly.

## The built-in validation fixture (do not "fix" early)

ADR-0006 (`spec/adr/0006-docs-curation-scope.md`) is **intentionally not linked** in README — the existing `adr-links` check already fails on it (proof the harness works). Leave it unlinked through Steps 1-4; the new `link-integrity` orphan-advisory must also flag it. **Only in Step 5, as the final action, link ADR-0006 in the README + CLAUDE.md ADR tables** to restore `audit-docs` to green. Do not link it earlier — it is the live test that the new checks behave.

## Step 1 — Doc-set resolver `packages/engine/src/docs-resolver.ts` (NEW)

```ts
export type DocTier = "curate" | "detect-only" | "never-touch"
export interface DocClassification {
  path: string          // repo-relative
  eligible: boolean      // false → excluded (never-touch / not a doc)
  tier: DocTier
  reason: string         // why this classification (zone, denylist, marker, path-rule)
}
export async function resolveCuratableDocs(workDir: string, opts?: { homes?: string[] }): Promise<DocClassification[]>
```

Deterministic, pure file-system. Steps (precedence: front-matter marker > content-class denylist > path zone > path-tier default):

1. Glob `**/*.md` under `workDir`.
2. **Exclusion zones → `eligible: false, tier: "never-touch"`:** any path segment in `node_modules`, `.git`, `dist`, `.bollard`, `.cursor`, `plugin`, `spec/archive`, `spec/prompts`. (These remove the agent prompts, fixtures, generated config, archive — the `.md` ≠ doc cases.)
3. **Content-class denylist → `never-touch`:** basename matches `*-results.md`, `*-validation-results.md`, `self-test-*.md` (historical snapshots living alongside live specs).
4. **Front-matter markers** (parse leading `---\n…\n---` with the `yaml` dep): `curate: false` → `never-touch`; `tier: detect-only|curate` → that tier (overrides path default).
5. **Path-tier defaults for the eligible remainder:** `spec/0*-*.md`, `spec/adr/*.md`, `spec/ROADMAP.md` → `detect-only`; everything else eligible (root docs, `docs/`, package READMEs, `spec/README.md`) → `curate`.

Export helpers the checks need: `isEligible(path)`, and a pure `classifyDocPath(path, homes)` if it keeps the glob-walk testable.

Unit tests `packages/engine/tests/docs-resolver.test.ts`: agent prompt path → `never-touch` (zone); `spec/self-test-cap-results.md` → `never-touch` (denylist); `spec/01-architecture.md` → `detect-only`; `README.md` → `curate`; a fixture with `curate: false` front-matter → `never-touch`; precedence (marker beats path-tier).

## Step 2 — `docs.homes` config

In `packages/cli/src/config.ts`: add a `docs:` block to the YAML schema and `BollardConfig`:

```ts
docs: z.object({ homes: z.array(z.string()).optional() }).strict().optional()
```

Default `homes: ["docs", "spec"]` (root is always allowed implicitly; do not list it). Thread it through: the CLI `audit-docs` command and the curate-docs blueprint pass `config.docs?.homes` into `auditDocs`. **Engine must not read `.bollard.yml`** — `docHomes` arrives via the `auditDocs` options arg (extend the existing `options` param), defaulting to `["docs", "spec"]` inside the engine if absent.

## Step 3 — `audit-docs` `link-integrity` check

Add check ID `"link-integrity"` and `checkLinkIntegrity(...)` in `packages/engine/src/audit-docs.ts`. Operates on the **eligible set from `resolveCuratableDocs`** (never raw glob):

- For every eligible doc, parse relative markdown links `[text](target)` where `target` is **not** `http(s)://` and **not** a pure `#anchor`. Strip any `#anchor` suffix. Resolve `target` relative to the linking file's directory.
- **Dangling link → fail:** resolved target does not exist on disk. Report file + link in `actual`. This covers **doc→doc AND doc→code** (`packages/.../foo.ts`), catching renamed/deleted targets.
- **Orphan → advisory:** BFS from root entry points (`README.md`, `CLAUDE.md`, `CONTRIBUTING.md`) following `.md` links; any eligible doc reached by no root is an orphan. Report as a separate advisory line — **do not fail the build on orphans** (a doc may be intentionally standalone). ADR-0006, unlinked, must appear here until Step 5.
- External URLs and pure anchors are out of scope (no network; anchor resolution deferred).

`DocsCheckResult` already supports pass/fail + `expected`/`actual`; if you need to separate hard-fail (dangling) from advisory (orphan), either emit two results or add an `advisory?: boolean` field — keep `allPassed` driven only by dangling links, not orphans.

## Step 4 — `audit-docs` `doc-placement` check

Add check ID `"doc-placement"` and `checkDocPlacement(...)`. Over the **eligible set**: flag any doc whose path is not under any `docHomes` entry and is not at repo root (no `/` after workDir). Report the offenders. **Advisory by default** (don't break the build on placement); a future config flag can make it failing. This catches a genuine stray doc without touching functional `.md` (already excluded by the resolver). **Do not implement any move** — detection only (ADR-0006 §3; auto-move is deferred).

## Step 5 — Validate, then link the fixture

1. `docker compose run --rm dev run typecheck && … run lint && … run test` — resolver + check unit tests green; full suite ≥ current + new tests.
2. **Confirm the fixtures fire BEFORE linking ADR-0006:**
   - `docker compose run --rm dev --filter @bollard/cli run start -- audit-docs` → exits 1; `adr-links` fails on `0006-docs-curation-scope.md` AND `link-integrity` lists it as an orphan advisory.
   - Add a temporary intentional dangling link in a scratch eligible fixture (or a unit-test fixture) pointing at a nonexistent `packages/does-not-exist.ts` → confirm `link-integrity` fails on it; remove it after.
3. **Now link ADR-0006** in the README ADR table and the CLAUDE.md ADR table (the `| [0006](spec/adr/0006-docs-curation-scope.md) | … |` row). Re-run `audit-docs` → **exit 0** (adr-links satisfied; 0006 no longer orphan).
4. Confirm no real dangling links exist in the current repo — if `link-integrity` finds genuine ones (doc→code links to moved files), that's real drift it just caught; fix the links (that's the feature working) and note them.

## Step 6 — Close out

1. `CLAUDE.md`: note the resolver + `link-integrity` + `doc-placement` checks and the `docs.homes` config; bump test count; add the ADR-0006 row (Step 5).
2. `spec/ROADMAP.md`: mark ADR-0006 increments 1-2 done.
3. ADR-0006: flip Status to **Accepted**; check off Action Items 1-2.
4. Archive this prompt → `spec/archive/`.
5. Commit: (1) resolver + config + tests, (2) audit-docs checks + tests, (3) docs + ADR link + status. Targeted `git add` — do NOT commit `.bollard/`.

## Out of scope

- No `curate-docs` agent/blueprint changes (increment 3, later PR).
- No auto-move of stray docs (ADR-0006 deferred; detection only).
- No changes to existing `audit-docs` check logic — only add the two new checks.
- No anchor-level or external-URL link checking.
- Do not link ADR-0006 until Step 5 — it is the live fixture.
