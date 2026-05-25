# Stage 5d Phase 15b — Stryker Docker Validation Results

**Date:** 2026-05-25  
**Validation type:** Deterministic Docker smoke + `runMutationTesting` integration (no LLM pipeline run)  
**Commits:** `5bd8290` (node+stryker.js), plugins follow-up (same session)

## Summary

Phase 15b fixes Stryker invocation inside Docker. Two layered issues were identified and resolved:

| Phase | Problem | Fix |
|-------|---------|-----|
| **15a** | `pnpm exec stryker run` — subprocess lacks pnpm resolution | Switch to `node_modules/.bin/stryker` |
| **15b** | `.bin/stryker` shell wrapper bakes host `NODE_PATH` at install time (paths invalid in `/app/`) | Invoke `node` on `@stryker-mutator/core/bin/stryker.js` directly |
| **15c** | pnpm hoists `@stryker-mutator/vitest-runner` to workspace root; Stryker's default plugin loader only scans core's nested `node_modules` | Add `plugins: ["@stryker-mutator/vitest-runner"]` to generated `stryker.config.json` |

## Phase 15b Validation — Stryker Mutation Signal

| Metric | Result |
|--------|--------|
| Invocation | `node node_modules/@stryker-mutator/core/bin/stryker.js run` |
| Environment | `docker compose run --rm dev` |
| Target file | `packages/engine/src/cost-tracker.ts` |
| `totalMutants` | **202** |
| Mutation score | **90.10%** (182 killed / 202 total) |
| `stryker_no_mutants` warning | **absent** |
| Duration | ~43s (`runMutationTesting` path) |

**Verdict:** ✓ fixed — real mutation signal in Docker

## Validation Commands

```bash
# End-to-end via Bollard mutation provider (writes generated stryker.config.json)
docker compose run --rm dev sh -c 'pnpm exec tsx -e "
(async () => {
  const { runMutationTesting } = await import(\"./packages/verify/src/mutation.ts\");
  const profile = { /* TS profile with mutation.enabled */ };
  const r = await runMutationTesting(\"/app\", profile, [\"packages/engine/src/cost-tracker.ts\"]);
  console.log(JSON.stringify({ totalMutants: r.totalMutants, score: r.score }));
})();"'
```

Expected output: `{"totalMutants":202,"score":~90}`.

## Root Cause Notes

1. **Shell wrapper NODE_PATH:** On host-installed `node_modules`, `node_modules/.bin/stryker` exports absolute paths like `/Users/.../node_modules/.pnpm/...`. Inside Docker (`/app/`), those paths do not exist. Stryker starts without the vitest-runner plugin and may exit 0 with `files: {}`.

2. **pnpm plugin discovery:** Even with correct `node` invocation, Stryker 9's `PluginLoader` scans `@stryker-mutator/*` under core's nested `node_modules` only. `@stryker-mutator/vitest-runner` lives at workspace root — explicit `plugins` array required.

## Files Changed

- [packages/verify/src/mutation.ts](../packages/verify/src/mutation.ts) — `node` + `stryker.js` invocation; `plugins` in generated config
- [packages/verify/tests/mutation.test.ts](../packages/verify/tests/mutation.test.ts) — +2 tests (node invocation, plugins array)

## Follow-Up

- **Full pipeline self-test:** Re-run `implement-feature` to confirm node 22 (`run-mutation-testing`) logs `totalMutants > 0` in a live run (requires `ANTHROPIC_API_KEY`).
- **Root `stryker.config.json`:** Consider adding `plugins` for manual `stryker run` outside the pipeline (optional DX).

## Prior Run Context

Run `20260525-2109-run-b8c50b` (limitUsd() self-test) predates Phase 15b and logged `stryker_no_mutants` with `totalMutants: 0`. See [self-test-limit-accessor-results.md](./self-test-limit-accessor-results.md).
