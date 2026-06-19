---
name: dependency-refresh-2026-06
overview: "Full dependency refresh to latest stable across every ecosystem (npm workspace, Go/Rust/Java helper manifests, Docker base images, GitHub Actions), Dependabot criticals first, one commit per major so breakage stays bisectable. Known-trap list included — read before touching anything."
todos:
  - id: step-0-inventory
    content: "Baseline + inventory: test floor, pnpm outdated -r, Dependabot advisory list, helper manifest versions"
    status: pending
  - id: step-1-dependabot
    content: "Fix the 5 Dependabot findings (1 critical, 4 moderate) — own commit(s), whatever ecosystem they're in"
    status: pending
  - id: step-2-minor-sweep
    content: "npm patch/minor sweep across the workspace — single commit, full gate"
    status: pending
  - id: step-3-tooling-majors
    content: "Tooling majors one commit each: typescript, tsx, @types/node, vitest+stryker pair if applicable"
    status: pending
  - id: step-4-biome2
    content: "Biome 1.9 → 2.x alone: biome migrate, reformat, expect a large mechanical diff"
    status: pending
  - id: step-5-runtime-libs
    content: "Library majors one commit each: zod 4 (MCP SDK peer check first), @anthropic-ai/sdk, openai, @google/genai migration, fast-check 4, MCP SDK, better-sqlite3"
    status: pending
  - id: step-6-runtimes
    content: "Node base images, go.mod + Go toolchain, Cargo/syn, pom.xml/GraalVM, GitHub Actions versions, pnpm pin attempt"
    status: pending
  - id: step-7-final-gate
    content: "Full gate: tests + adversarial + audit-docs + Stryker live smoke + eval diff + one self-test; docs updates; DEFERRED list"
    status: pending
isProject: false
---

# Dependency Refresh — everything to latest stable (2026-06)

## Goal

Bring every dependency to its latest **stable** version: the pnpm workspace, the three helper-binary manifests (`scripts/extract_go/go.mod`, `scripts/extract_rs/Cargo.toml`, `scripts/extract_java/pom.xml`), Docker base images, and GitHub Actions. Kill the 5 Dependabot findings (1 critical, 4 moderate) first. **One commit per major version bump** — when something breaks three weeks from now, `git bisect` must be able to name the exact upgrade.

**Deferral rule (this keeps "everything to latest" honest):** if a major cannot pass its gate after bounded effort (~30 min of fixing), `git revert` that single commit, add it to the **DEFERRED** table at the bottom of this file with the blocking reason, and continue. A documented deferral is success; a broken main is not.

**Per-step gate** (after every commit): `docker compose build dev && docker compose run --rm dev run typecheck && docker compose run --rm dev run lint && docker compose run --rm dev run test` — all clean, ≥ baseline test count.

## Known traps — read first, these are paid-for lessons

1. **pnpm 11 rejects this repo's lockfile overrides** — that's why `packageManager` is pinned to `pnpm@10.33.0` (in root `package.json` AND the Dockerfiles). Attempt the latest pnpm in Step 6; if `pnpm install --frozen-lockfile` fails on overrides, stay on latest 10.x and note it in DEFERRED.
2. **`pnpm.overrides` is a mixed bag** — 8 GHSA security floors (`vite`, `hono`, `@hono/node-server`, `fast-uri`, `postcss`, `ip-address`, `brace-expansion`, `qs`) plus a `vitest@<4.1.0 → >=4.1.0` self-bump for stale vitest 3.x transitives. After the sweep and majors land, audit **every** entry in Step 6.5: remove only if the naturally-resolved graph already satisfies the constraint **and** `pnpm audit --audit-level=high` stays clean without it. The vitest override is dead weight once manifests say `^4.1.x`. Keep any override still doing real work; commit message must note why each survivor stays.
3. **Vitest ↔ Stryker coupling:** `@stryker-mutator/core` + `@stryker-mutator/vitest-runner` move together, and `StrykerProvider` invokes `node node_modules/@stryker-mutator/core/bin/stryker.js run` with `plugins: ["@stryker-mutator/vitest-runner"]` in the generated config (pnpm hoisting workaround). Any Stryker major must be validated with the **live Docker smoke** (Step 7), not just unit tests.
4. **zod 3 → 4:** check `@modelcontextprotocol/sdk`'s zod peer range FIRST (`pnpm why zod`; the MCP SDK historically requires zod 3). If the latest MCP SDK still wants zod 3, defer zod 4 — do not run two zod majors in the same tree.
5. **`@google/generative-ai` is deprecated upstream** in favor of `@google/genai`. This is a provider rewrite of `packages/llm/src/providers/google.ts` (chat + chatStream + function declarations), not a version bump. Do it as its own commit; validate with the live smoke test in `google.test.ts` (skips without `GOOGLE_API_KEY` — run it with the key if available, otherwise note partial validation in DEFERRED).
6. **`@anthropic-ai/sdk` 0.39 → latest:** the streaming path (`anthropic.ts` `chatStream`, `content_block_start`/`input_json_delta` event mapping, `finalMessage()`) and tool_use pairing are the risk surface. `anthropic-stream.test.ts` covers the mapping; also run the live smoke in `client.test.ts`.
7. **better-sqlite3 is a native addon** — listed in `pnpm.onlyBuiltDependencies`; any bump requires `docker compose build dev` before tests, and keep the dynamic-import JSONL fallback path tested (`run-history-db.test.ts`).
8. **Biome 1 → 2 reformats the world.** Run `biome migrate` for the config, then `run format`, and keep the entire mechanical diff in ONE commit with nothing else in it. Check `biome.json` rule renames (`noControlCharactersInRegex` etc. must still be active — `history-show.test.ts` relies on the `String.fromCharCode(27)` workaround staying valid).
9. **Node base images:** `node:22-slim` appears in the Dockerfile (dev, llamacpp-builder) and the lockfile-regen one-liner in CLAUDE.md. Tech stack says "Node 22+" — moving to the current LTS (24) is allowed; keep `procps` (Stryker workers need it). Update CLAUDE.md's one-liner too.
10. **Helper manifests are why Dependabot sees what pnpm audit can't.** `go.mod` (go 1.22), `Cargo.toml` (syn, edition), `pom.xml` (JavaParser, ASM, GraalVM native plugin) — bump each, rebuild helpers via `docker compose build dev`, and run `packages/verify/tests/extractor-helpers.test.ts`. The critical Dependabot finding is most likely here or in GitHub Actions.
11. **GitHub Actions:** bump `actions/*` versions in all four workflows. Do not change workflow logic — versions only.
12. **Don't touch:** agent prompt files, `MODEL_REGISTRY` data, eval baselines, cost baselines, `.bollard.yml`. A dependency refresh that "also improves" something else is two changes in one commit.

## Step 0 — Inventory (no changes)

1. Clean tree on `main`; record test floor: expect **1531 passed / 6 skipped** (post audit-docs).
2. `docker compose run --rm dev exec pnpm outdated -r` — save full table into the Inventory section below.
3. Get the Dependabot list: `gh api repos/bruno-morel/bollard/dependabot/alerts --jq '.[] | {severity: .security_advisory.severity, package: .dependency.package.name, ecosystem: .dependency.package.ecosystem, summary: .security_advisory.summary}'` (or the maintainer pastes the page). Record all 5.
4. Record helper versions: `go.mod` go directive, `Cargo.toml` deps, `pom.xml` deps, Dockerfile `FROM` lines, Actions versions.

## Steps 1–6 — execute in order, gate after each commit

- **Step 1 — Dependabot first.** Fix all 5 findings in whatever ecosystem they live (likely helper manifests / Actions per trap 10). One commit per ecosystem touched. The critical one ships before anything else.
- **Step 2 — npm patch/minor sweep.** Everything that doesn't cross a major, workspace-wide, lockfile updated via the Docker flow, one commit.
- **Step 3 — tooling majors**, one commit each, in this order: `typescript` → `tsx` → `@types/node` → vitest/stryker pair (only if a major exists).
- **Step 4 — Biome 2**, alone (trap 8).
- **Step 5 — library majors**, one commit each: `fast-check` → `@modelcontextprotocol/sdk` → `zod` (trap 4 gate) → `@anthropic-ai/sdk` (trap 6) → `openai` → `@google/genai` migration (trap 5) → `better-sqlite3` (trap 7) → `yaml`/`proper-lockfile` if majors exist.
- **Step 6 — runtimes & meta:** Node base images + CLAUDE.md one-liner (trap 9) → go/Cargo/pom toolchains + helper rebuild (trap 10) → GitHub Actions (trap 11) → pnpm pin attempt (trap 1) → **Step 6.5: `pnpm.overrides` prune audit** — try removing each of the 9 overrides individually; gate each on lock resolving cleanly + `pnpm audit --audit-level=high` (trap 2). `docker compose down -v` if volumes go stale.

## Step 7 — Final full gate

1. `docker compose build dev` from scratch (`--no-cache` if layer weirdness) and the standard typecheck/lint/test — record final count.
2. Adversarial suite: `docker compose run --rm dev exec vitest run --config vitest.adversarial.config.ts` — 338+ passing.
3. `audit-docs` — exit 0 (update README/CLAUDE.md counts if totals changed).
4. **Stryker live smoke** (trap 3): run mutation on `cost-tracker.ts` per the documented Docker smoke; expect mutants > 0 and score in the historical 85–90% band.
5. `eval diff` — exit 0 (deps must not move agent behavior; if this fails something deep changed — investigate, don't retag).
6. One self-test (~$1–1.5) on a fresh CostTracker method; 17/17 steps; cost within ±25% of $1.1451 baseline.
7. `pnpm audit --audit-level=high` clean AND Dependabot page shows 0 open findings after push.
8. Docs: CLAUDE.md tech-stack mentions (Biome/Node/versions), README if counts changed, fill the DEFERRED table, archive this prompt to `spec/archive/`.

## Inventory (final — landed on main 2026-06-09)

| Source | Before | Landed | Notes |
|--------|--------|--------|-------|
| Baseline tests | 1531 pass / 6 skip | 1531 pass / 6 skip | Unchanged after refresh |
| Adversarial tests | 338 pass | 347 pass | +9 from refresh-era test additions |
| Dependabot | 5 open (1 critical, 4 moderate) | 2 open moderate | Critical + 3 moderate cleared; `qs` #21, `ip-address` #12 remain |
| pnpm | 10.33.0 | **11.5.2** | Overrides removed; pnpm 11 migration succeeded (`5b17c4e`) |
| Node image | node:22-slim | **node:24-slim** | `8f06245` |
| TypeScript | 5.9.3 | **6.0.3** | `994009a` |
| Vitest | 4.1.8 | **4.1.8** | Manifest aligned `^4.1.8` |
| Biome | 1.9.4 | **2.4.16** | `74236a8` |
| Stryker | 9.6.0 | **9.6.1** | `b4be96a` patch |
| @anthropic-ai/sdk | 0.39.0 | **0.102.0** | `aebcb87` |
| openai | 4.104.0 | **6.42.0** | `f94e629` + stream fix `1707f7a` |
| @google/generative-ai | 0.24.0 | **@google/genai 2.8.0** | `761ad44` rewrite |
| MCP SDK | 1.29.0 | **1.29.0** | zod 4 peer satisfied |
| zod | 3.25.76 | **4.4.3** | `9a91c79` |
| fast-check | 3.23.2 | **4.8.0** | `6e2ad0b` |
| better-sqlite3 | 12.9.0 | **12.10.0** | patch in sweep |
| Go helper | go 1.22 | **go 1.24** | `0de5aa7` |
| pnpm.overrides | 9 entries | **0 entries** | All removed `3a22fc9`; high audit clean |

## Step 7 verification results (2026-06-12)

Run against `main` after merge (`3698512` + post-merge fix). No dependency changes; no reverts.

| Gate | Result | Evidence |
|------|--------|----------|
| 1 Security | **PASS** (high audit clean) | `pnpm audit --audit-level=high`: 0 high/critical (2 moderate: `qs`, `ip-address`). Dependabot: 2 open moderate (#21, #12) — down from 5; no revert triggered |
| 2 Eval | **PASS** | `eval diff` exit 0; all 5 agents 100% vs `stage5b-sonnet-4-6` |
| 3 Self-test | **PASS** | Run `20260612-0238-run-766a96`: 17/17 steps, $0.55, coder 7t on `claude-sonnet-4-6`, testers Haiku |
| 4 Stryker | **PASS** | 387 mutants, **86.56%** score (`stryker run` on `cost-tracker.ts`) |
| 5 Suites | **PASS** | Adversarial 347 pass; `audit-docs` exit 0; extractor-helpers 5/5 |
| 6 Google | **PARTIAL** | `google.test.ts`: 12 pass / 2 skipped (no `GOOGLE_API_KEY`); mocked + mapping tests green |

## DEFERRED

| Dependency | Blocked at | Reason | Revisit when |
|------------|-----------|--------|--------------|
| @google/genai live smoke | Gate 6 (2026-06-12) | Migrated to `@google/genai`; mocked tests pass; 2 live smoke tests skipped — no `GOOGLE_API_KEY` in `.env` | Key available; run `vitest run packages/llm/tests/google.test.ts` with key |
| ~~qs (transitive)~~ | **RESOLVED (2026-06-18, commit `e24ef3f`)** | Override `qs: ">=6.15.2"` restored in `pnpm-workspace.yaml`; `pnpm audit` = 0 | — |
| ~~ip-address (transitive)~~ | **RESOLVED (2026-06-18, commit `e24ef3f`)** | Override `ip-address: ">=10.1.1"` restored; `pnpm audit` = 0 | — |

**Post-refresh CI finding (2026-06-18):** `bollard-verify` on `main` failed at Bollard's own static `audit` step — `pnpm audit --audit-level=high` caught NEW HIGH advisories published after the refresh merged: `vite 8.0.7` (GHSA-fx2h-pf6j-xcff), `esbuild 0.28.0` (GHSA-gv7w-rqvm-qjhr), `hono <4.12.25` (GHSA-88fw-hqm2-52qc). Commit `e24ef3f` restored seven transitive floors (`vite "8.0.16"` exact, `esbuild >=0.28.1`, `hono >=4.12.25`, `qs >=6.15.2`, `ip-address >=10.1.1`, `protobufjs >=7.6.3`, `@babel/core >=7.29.1`) → `pnpm audit` = 0, Dependabot 6 → 0. This is Bollard's CI catching a real post-merge vuln on `main` — the audit step working as designed.
