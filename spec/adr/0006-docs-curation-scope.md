# ADR-0006: Docs curation scope — deterministic doc-set resolution, link-graph integrity, and rewrite tiers

**Status:** Accepted
**Date:** 2026-06-20
**Deciders:** Bruno (maintainer)
**Supersedes:** — (extends Stage 6 docs Layer 1 `audit-docs` + Layer 2 `curate-docs`)
**Related:** [stage6-docs-integrity.md](../stage6-docs-integrity.md) (full design), [adr/0001-deterministic-filters-for-llm-output.md](./0001-deterministic-filters-for-llm-output.md), [adr/0004-determinism-local-frontier-tiers.md](./0004-determinism-local-frontier-tiers.md)

## Context

Stage 6 shipped two-layer docs integrity: `audit-docs` (deterministic — counts/consistency/link coverage) and `curate-docs` (LLM — prose drift fixes). Both are deliberately scoped to **README.md + CLAUDE.md** as a Phase 1 safety bound. The first live `curate-docs run` (2026-06-20) validated the LLM tier: 5/5 grounded edits, zero hallucinations, all real drift (Node/TS versions, pipeline node counts, coder turn budget, missing spec entries).

The open question is how to extend beyond two files to the project's full doc surface **without** weakening the safety property. The repo has **198 `.md` files**, but only **~30 are live curatable docs**:

- **112** in `spec/archive/` — explicitly "not current guidance"
- **~30** `spec/*-results.md` / `self-test-*.md` — point-in-time validation records (immutable history)
- **~10** generated (`.cursor/`, `.github/` templates, `plugin/`) or scratch (`.bollard/`)
- **~30** live: root docs (README, CLAUDE, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT), `spec/01-09`, ROADMAP, 5 ADRs, `docs/`, package READMEs

The forces:

- **Naive `**/*.md` is actively dangerous.** It would point a prose-rewriting LLM at historical records and archived snapshots, corrupting the project's own audit trail. The scope problem is primarily an *exclusion* problem, and the exclusions carry the safety.
- **Not all live docs are equally safe to rewrite.** Design specs and ADRs are *intent* documents — divergence from the shipped code is frequently **deliberate** (the spec is the plan; the code evolved). An agent "fixing" a spec to match code can silently erase design rationale. README/CLAUDE/CONTRIBUTING, by contrast, are *descriptive* — divergence from reality is simply drift.
- **Link rot is real, common, and fully deterministic.** A link to a renamed/deleted doc or source file is the most annoying drift and the most mechanically detectable. By design principles 1 and 16 (determinism first; ADR-0004 tiering), this must never be an LLM job.
- **Selection and tiering should themselves be deterministic and auditable** — the same discipline `audit-docs` and toolchain detection already follow. Only the prose edits stay non-deterministic, grounded + human-gated.
- **Doc placement drifts too, and "the docs folder" is not one folder.** Docs sprawl into random locations over time, which is real drift worth surfacing. But the project has no single doc home: live docs live in `spec/` (47), root (6), and `docs/` (2). And most `.md` files outside those are **not docs at all** — `packages/agents/prompts/*.md` are agent prompts loaded by path at runtime, `packages/verify/tests/fixtures/*.md` are test fixtures, `packages/*/.cursor/*.md` are generated config. `.md` ≠ doc. Any placement rule must operate on the *eligible doc set* (post-exclusion), never raw `.md`, or it will relocate functional files and break the build.

## Decision

Extend docs integrity along three deterministic axes plus a tiered LLM layer. **No part of doc-set selection, tiering, or link checking uses an LLM.**

### 1. Deterministic doc-set resolver

`resolveCuratableDocs(workDir): DocClassification[]` — pure file-system, no LLM. Steps:

1. Glob `**/*.md`.
2. Apply **path exclusion zones** (config-driven, defaulted): `node_modules`, `.git`, `dist`, `.bollard`, `.cursor`, `plugin`, `spec/archive`, `spec/prompts`.
3. Apply **content-class exclusions** for historical snapshots living alongside live specs: a path-pattern denylist (`*-results.md`, `self-test-*.md`, `*-validation-results.md`) **and** an explicit per-file opt-out marker — `curate: false` in YAML front-matter — which takes precedence and is the auditable escape hatch when a pattern is too coarse.

The result is the **eligible set**. The marker beats the pattern beats the zone, all deterministic and greppable.

### 2. Rewrite tiers (deterministic by path-class)

Each eligible doc is assigned a tier by path rule (overridable by front-matter `tier:`):

| Tier | Files | LLM action | Ground truth / corpus |
|------|-------|-----------|------------------------|
| **curate** | README, CLAUDE, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, `docs/`, package READMEs | propose `oldText→newText` edits (as today) | code reality + CLAUDE.md + audit facts |
| **detect-only** | `spec/01-09`, `spec/adr/*`, ROADMAP | emit a drift **report**, never an edit | code + CLAUDE.md, advisory |
| **never-touch** | `spec/archive`, `*-results`, generated configs | excluded entirely (not in eligible set) | — |

The **curate vs detect-only** split is the core safety decision: rewriting is reserved for *descriptive* docs whose ground truth is unambiguous; *intent* docs (specs/ADRs) are only flagged, because their divergence from code is often correct and an auto-rewrite would destroy rationale.

### 3. Doc-home config + deterministic placement detection (detect, never auto-move)

New generic config block `docs:` in `.bollard.yml` (defaulted, deterministic):

```yaml
docs:
  homes: ["docs", "spec"]   # directories where docs are expected to live; root is always allowed
  # exclusions reuse the resolver zones (§1); placement runs on the eligible set only
```

`audit-docs` gains a `doc-placement` check: over the **eligible doc set only** (§1 — so prompts, fixtures, generated config are already gone), flag any doc that lives outside `docs.homes` and is not at repo root. A stray (`notes.md` dropped in a random package dir) is reported; this is **advisory by default**, promotable to failing via config. It catches genuine sprawl without ever touching functional `.md`.

**Auto-move is explicitly deferred and out of scope for content drift.** Relocating a doc breaks every referrer (the exact drift the §4 link-integrity check exists to catch) and risks moving files that must stay put. If ever built, it is a *separate, opt-in, link-aware* capability: atomic rewrite of all referrers (doc→doc and doc→code), human gate, and a post-move `link-integrity` re-verify that asserts zero new dangling links — plus the eligible-set restriction so it can never move an agent prompt or fixture. The default is and stays **detect**. Structure changes and content drift are different risk classes; they do not share a trigger.

### 4. Link-graph integrity — a deterministic Layer-1 check (extends `audit-docs`)

New `audit-docs` check `link-integrity` (generalizes the existing `spec-doc-links` / `adr-links`):

- Parse every relative markdown link in the eligible set — **doc→doc AND doc→code** (e.g. `packages/.../foo.ts`). Resolve relative to the linking file; the target must exist on disk. A missing target is a **dangling link → check fails** (the "link doesn't exist anymore" drift).
- Walk reachability from root entry points (README, CLAUDE, CONTRIBUTING). Eligible docs reachable from no root are **orphans** — an **advisory** signal (a doc may be intentionally standalone), not a hard failure.
- External URLs (`http(s)://`) and pure anchors (`#section`) are out of scope for the local check (no network; anchor-resolution is a later refinement).

Because it is deterministic and zero-cost, `link-integrity` runs in `audit-docs` and therefore in the `bollard-verify` CI step — broken internal links fail the build, exactly like a stale count does today.

### 5. Drift-candidate selection — the deterministic layer gates the LLM pass

Sending every curate-tier doc's full content to the agent on every run does not scale: the curate tier is ~20 docs (~200K+ chars), and a naive full pass is a ~100K-token firehose producing an unreviewable gate diff at real cost. Worse, it spends frontier tokens on docs that almost certainly haven't drifted (`CODE_OF_CONDUCT.md` does not go stale relative to code).

So a **deterministic candidate selector decides which curate-tier docs the LLM sees** — and whether it runs at all. `selectDriftCandidates(workDir, editable)` returns the subset of curate-tier docs with a real drift signal:

- **audit-docs implication:** the doc appears in a *content*-relevant failing check — it owns a dangling link (`link-integrity`), or it's README/CLAUDE with a count mismatch. **Not** `doc-placement` (a location problem the rewriter can't fix — surfaced separately) or `link-orphans` (reachability, not content).
- **git staleness vs references:** the doc's last-commit time is older than the newest last-commit time among the code it points at — its `doc→code` links (reusing the link-integrity parser) and, for a package README, its package's `src/`. "The code moved, the doc didn't" is the highest-signal, fully-deterministic staleness indicator.

A doc with **no** drift signal is **not sent** — zero LLM cost. If the candidate set is empty, the run is a no-op (`CURATION_NO_PROGRESS`), and the LLM is never called. A `--all` escape hatch forces the full curate tier for a deliberate sweep. Git unavailable → the staleness signal degrades to empty (audit-implication still applies); `--all` always works.

This is design principles 1 and 16 applied to curation itself: the deterministic layer (audit-docs + git + the resolver) does the selection; the frontier model is spent only where there is a concrete signal that a specific doc lags reality. Detect-only docs are reported regardless (no LLM); never-touch stays invisible.

### Resulting flow

`audit-docs` (Layer 1) gains `link-integrity` and `doc-placement` over the eligible set (both deterministic, both CI-gated). `curate-docs` (Layer 2) consumes the resolver + tiers: rewrites the curate tier (grounded, human-gated, as validated in Phase 1), reports the detect-only tier, never sees the never-touch set. Auto-move stays out of both layers (deferred, Decision §3).

## Options Considered

### Option A — Widen the `curate-docs` allowlist to all `.md`
Trivial. **Rejected:** points the rewriter at 112 archived + ~30 historical-record files; corrupts the audit trail; ignores the intent-vs-descriptive distinction. Maximizes hallucination surface on exactly the docs where "drift" is most ambiguous.

### Option B — Link-reachability as the primary selector
Walk from README; curate whatever is reachable. Elegant but **insufficient as the gate:** CLAUDE.md's narrative log links *to* the historical self-test-results, so reachability pulls immutable records back in. Reachability is a good *secondary* signal (orphan detection), not the primary filter.

### Option C — Deterministic tiered resolver + deterministic link integrity (chosen)
Path-config exclusion zones + content-class denylist + front-matter marker for selection; path-class tiers for rewrite-vs-report; link integrity as a deterministic Layer-1 check covering doc→doc and doc→code; configurable doc-homes with deterministic placement *detection*. **Chosen:** selection and tiering are deterministic and auditable; link rot and misplacement are caught deterministically and gated in CI; the LLM is confined to grounded prose edits on descriptive docs only.

### Option D — Enforce a single docs home by auto-moving stray `.md` (rejected for this phase)
Configure one docs folder; during the drift pass, move any `.md` found elsewhere (except root) back into it. **Rejected:** (a) the repo has no single home — docs live across `spec/`, root, and `docs/`; (b) most `.md` outside those are functional, not docs — moving `packages/agents/prompts/*.md` breaks agents that load them by path, and moving test fixtures corrupts tests; (c) relocation breaks every referring link, manufacturing the precise drift Option C's link check exists to detect. The legitimate intent (surface sprawl) is preserved as deterministic *detection* on the eligible set (Decision §3); auto-move is deferred to a separate opt-in, link-aware capability.

## Trade-off Analysis

**The decisive split is descriptive vs intent docs.** Phase 1 proved the LLM tier is safe *when ground truth is unambiguous* (README/CLAUDE vs code). Specs and ADRs break that assumption — their divergence from code is often the point. Option C keeps the rewriter on solid ground and downgrades the ambiguous docs to detect-only, where a human adjudicates whether a divergence is drift or intent. This is the same instinct as ADR-0001 (deterministic filter where the answer is mechanical) applied to *which docs* rather than *which claims*.

**Link integrity belongs in Layer 1, full stop.** It is 100% deterministic; placing it in the LLM tier would violate design principle 1 and waste tokens on something `rg` + `fs.stat` settles. Generalizing it to doc→code links is nearly free and catches a high-frequency drift class (renamed source files) that nothing currently guards.

**Placement is detect-only because move and content-drift are different risk classes.** Rewriting a doc's prose is reversible and local; moving a file is a structural change with repo-wide link blast radius. Folding auto-move into the drift pass would couple a safe content operation to a dangerous structural one under a single trigger and default. The `.md` ≠ doc evidence (agent prompts, fixtures) makes the cost of getting it wrong concrete: a broken build, not a stale sentence. Detection delivers the value (sprawl is surfaced) at none of that cost; the move, if ever wanted, earns its own opt-in capability with link-aware atomicity.

**Front-matter marker as the escape hatch.** Path patterns for historical snapshots (`*-results.md`) are fragile; the `curate: false` marker makes any file's exclusion explicit, local, and greppable — better than growing a central denylist over time.

## Consequences

**Easier:** scaling docs curation without expanding hallucination risk (tiering contains it); catching link rot in CI (new deterministic check); auditing why any file is in/out of scope (path config + marker, all deterministic).

**Harder:** maintaining the tier assignment as new docs land (mitigated: path-class defaults + front-matter override); the detect-only report is advisory, so spec drift still needs human follow-through (acceptable — auto-rewriting intent docs is the worse failure).

**To revisit:**
- Anchor-level link checking (`#section` targets) — deferred refinement of `link-integrity`.
- Whether any `detect-only` doc earns promotion to `curate` once its ground-truth corpus is proven strong enough (mirror the Phase 6 "settle with data" discipline).
- Auto-move of stray docs as a separate opt-in, link-aware capability (atomic referrer rewrite + human gate + post-move `link-integrity` re-verify + eligible-set restriction). Only if detection shows sprawl is frequent enough to be worth the machinery.
- Per-tier corpus construction detail belongs in [stage6-docs-integrity.md](../stage6-docs-integrity.md), not here.

## Action Items

Build increments (deterministic first, agent last — ADR-0004 ordering):

1. [x] `resolveCuratableDocs` + `DocClassification` (zones + `*-results` denylist + `curate:`/`tier:` front-matter) — pure, unit-tested.
2. [x] `docs:` config block (`homes`, defaulted) + `audit-docs` `link-integrity` check (doc→doc + doc→code dangling-link detection; orphan advisory) + `doc-placement` check (eligible-set docs outside `homes`/root; advisory default) — all wired into CI; zero LLM.
3. [x] `curate-docs` consumes the resolver + tiers: rewrite `curate` tier (runtime allowlist), report `detect-only` tier, exclude `never-touch`. **(increment 3)**
3b. [x] `selectDriftCandidates` — deterministic candidate selection (audit-implication + git staleness vs referenced code) gates which curate-tier docs the LLM reviews and whether it runs at all; `--all` escape hatch. **(increment 3b, 2026-06-20)**
4. [ ] Persist dropped-edit detail (follow-up from the Phase 1 live run — `d2` drop reason was unrecoverable; the grounding-result dropped array should be written to disk for auditable calibration).
5. [ ] (Deferred / only if detection warrants) Opt-in link-aware auto-move for stray docs.
