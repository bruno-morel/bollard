# Stage 3c Workstream 4: Self-host validation

> **Goal:** Run Stryker against Bollard itself, measure the baseline mutation score, identify surviving mutants, calibrate the threshold, and document everything. This is the integration proof — if Stryker works on Bollard's own codebase via the exact config-generation path built in WS1, the pipeline is validated.

## Context

Read these files before writing any code:

- `CLAUDE.md` (root) — project conventions, Docker rules
- `packages/verify/src/mutation.ts` — `StrykerProvider`, config generation, result parsing
- `packages/detect/src/types.ts` — `MutationConfig`, `ToolchainProfile`
- `packages/blueprints/src/implement-feature.ts` — `run-mutation-testing` node
- `spec/stage3c-plan.md` — WS4 scope
- `spec/stage3a-validation-results.md` and `spec/stage3b-validation-results.md` — format reference for validation docs

## Approach: two-phase validation

Running Stryker against the full Bollard repo (~8 packages, 546 tests) will be slow. Use a two-phase approach:

### Phase 1: Single-package smoke test (`@bollard/engine`)

Pick `@bollard/engine` as the first target. It's small (~824 LOC source, ~3040 LOC tests), pure logic (no I/O, no Docker, no LLM calls), and self-contained. This validates the Stryker + Vitest + pnpm workspace integration.

**Step 1:** Create `stryker.config.json` at the repo root:

```json
{
  "$schema": "https://raw.githubusercontent.com/stryker-mutator/stryker/master/packages/core/schema/stryker-schema.json",
  "testRunner": "vitest",
  "vitest": {
    "configFile": "vitest.config.ts"
  },
  "mutate": [
    "packages/engine/src/**/*.ts",
    "!packages/engine/src/**/*.test.ts"
  ],
  "reporters": ["json", "clear-text", "progress"],
  "jsonReporter": {
    "fileName": "reports/mutation/mutation.json"
  },
  "thresholds": {
    "high": 80,
    "low": 60,
    "break": null
  },
  "concurrency": 2,
  "timeoutMS": 60000,
  "tempDirName": ".stryker-tmp"
}
```

**Step 2:** Run Stryker inside Docker:

```bash
docker compose run --rm dev exec stryker run
```

**Step 3:** Examine the output:
- Note the total number of mutants, killed, survived, no-coverage, timeout
- Compute the mutation score
- Identify any surviving mutants (these are test gaps)
- Note execution time

If Stryker fails or has configuration issues (e.g., workspace alias resolution, Vitest config discovery), fix the config and re-run. Common issues:
- Stryker may need `--vitest-config` if the default Vitest config path isn't found
- pnpm workspace aliases (`@bollard/*`) may need Stryker's `--buildCommand` or a custom `vitest.config.ts` that handles workspace resolution
- If Stryker can't find test files, check `vitest.config.ts` for includes/excludes

### Phase 2: Multi-package scope

Once Phase 1 works, expand the `mutate` array to cover more packages:

```json
"mutate": [
  "packages/engine/src/**/*.ts",
  "packages/detect/src/**/*.ts",
  "packages/verify/src/**/*.ts",
  "packages/blueprints/src/**/*.ts",
  "!packages/*/src/**/*.test.ts"
]
```

Skip `@bollard/agents` (agent tools do I/O), `@bollard/cli` (CLI entry point, hard to unit-test mutations), and `@bollard/mcp` (MCP server, hard to unit-test mutations) for now — their mutation scores would be misleadingly low because many of their code paths require integration setup.

Run again and record the broader score. If the multi-package run exceeds 10 minutes, document the timing and note that WS5 (scope-aware targeting) will be needed.

## Phase 3: Document results

Create `spec/stage3c-validation-results.md` with the same structure as the Stage 3a/3b validation docs:

```markdown
# Stage 3c Validation Results

## Status: [GREEN/YELLOW/RED]

## Check 1: Stryker installation
- Version: 9.6.0
- vitest-runner: installed
- `pnpm exec stryker run --help`: works

## Check 2: Single-package mutation score (engine)
- Total mutants: [N]
- Killed: [N]
- Survived: [N]
- No coverage: [N]
- Timeout: [N]
- **Score: [N]%**
- Execution time: [N]s

## Check 3: Multi-package mutation score
- Packages: engine, detect, verify, blueprints
- Total mutants: [N]
- **Score: [N]%**
- Execution time: [N]s

## Check 4: Surviving mutants analysis
[For each surviving mutant, note the file, line, mutator, and why it survived.
Categorize: genuine test gap vs. equivalent mutant vs. acceptable survival.]

## Check 5: Threshold calibration
- Recommended threshold: [N]% (based on observed scores)
- Reasoning: [...]

## Check 6: Pipeline integration test
- `run-mutation-testing` node executes with real Stryker
- `ctx.mutationScore` is set
- Threshold gating works

## Known gaps
[...]

## Commit log
[...]
```

## Phase 4: Update CLAUDE.md

Add a "Mutation Testing" subsection under "Current Test Stats" or similar:

```markdown
### Mutation Testing (Stage 3c)

- **Tool:** Stryker 9.6.0 + `@stryker-mutator/vitest-runner`
- **Baseline score (engine):** [N]%
- **Baseline score (engine + detect + verify + blueprints):** [N]%
- **Default threshold:** [N]% (configurable via `.bollard.yml` `mutation:` section)
- **Run command:** `docker compose run --rm dev exec stryker run`
- **Pipeline node:** `run-mutation-testing` (node 16 of 19), opt-in via `mutation.enabled: true` in `.bollard.yml`
```

## Phase 5: Update `.bollard.yml` example

If there's an example `.bollard.yml` in the repo (check `examples/bollard.yml` or root `.bollard.yml`), add a `mutation:` section:

```yaml
mutation:
  enabled: true
  tool: stryker
  threshold: 80
  timeoutMs: 300000
  concurrency: 2
```

## Phase 6: Add `reports/` to `.gitignore`

Stryker writes to `reports/mutation/mutation.json`. Add `reports/` to `.gitignore` if not already there. Also add `.stryker-tmp/` (Stryker's temp directory).

## Constraints

- **All commands run via Docker** — no bare `pnpm` or `npx` on the host
- **Do NOT commit the `reports/` directory** — it's a build artifact
- **Do NOT commit `.stryker-tmp/`** — Stryker temp files
- **Run the full test suite after any changes** to confirm no regressions: `docker compose run --rm dev run test`
- **Commit `stryker.config.json`** — it's the project's Stryker config, like `vitest.config.ts` or `biome.json`

## Expected output

| Metric | Expected |
|--------|----------|
| New files | 2–3 (`stryker.config.json`, `spec/stage3c-validation-results.md`, optional `.bollard.yml` update) |
| Changed files | 2 (`CLAUDE.md`, `.gitignore`) |
| Test count | 546 passed / 2 skipped (unchanged) |
| Typecheck | Clean |
| Lint | Clean |

## Commit

```
Stage 3c: self-host Stryker validation + baseline mutation scores + docs
```

Single commit with `stryker.config.json`, validation results, CLAUDE.md update, `.gitignore` update, and any config fixes discovered during the run.
