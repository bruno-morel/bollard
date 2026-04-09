# Stage 3a — Validation Prompt

> Runs the end-to-end checks deferred during the Stage 3a implementation pass. Fixes anything that's actually broken. Does NOT add new features.

All commands run inside Docker. Never bare `pnpm` / `node` / `tsc` / `vitest` / `biome` on the host.

## Ground rules

- If a check passes, capture the relevant output snippet and move on.
- If a check fails, STOP and fix the underlying cause — do not paper over with `try/catch`, `|| true`, or test skips.
- If a fix requires a design decision beyond the scope of "make it work end-to-end," stop and surface the question.
- Every fix gets its own commit with a clear message; do not bundle fixes with unrelated changes.
- If you need to read prior context: `CLAUDE.md`, `spec/07-adversarial-scopes.md`, and `spec/stage3a-contract-scope-prompt.md` are the sources of truth.

## Pre-flight

Make sure the dev image is current:

```
docker compose build dev
```

Confirm the Stage 3a baseline still holds (should be unchanged from the previous pass):

```
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

Expected: zero typecheck errors, zero lint errors, 377 passed / 2 skipped (or whatever the current baseline is — do not regress). Capture the actual counts.

---

## Check 1 — `bollard verify --profile`

```
docker compose run --rm dev --filter @bollard/cli run start -- verify --profile --work-dir /app
```

**Pass criteria:**
1. Exit code 0.
2. Output shows a `ToolchainProfile` JSON (or pretty-printed summary) containing the **new** per-scope adversarial shape: `adversarial.boundary`, `adversarial.contract`, `adversarial.behavioral`.
3. Each scope has `enabled`, `integration`, `lifecycle`, `concerns` (with all four weights), and `frameworkCapable` where applicable.
4. Default weights match spec §4:
   - boundary: correctness=high, security=high, performance=low, resilience=low
   - contract: correctness=high, security=medium, performance=medium, resilience=medium
   - behavioral: correctness=medium, security=high, performance=high, resilience=high
5. `behavioral.enabled` is `false` by default.
6. **No references** to the old flat `adversarial: { mode, persist }` shape anywhere in the output.

**If it fails:** the most likely culprits are `cli/src/index.ts` (output formatter still assumes old shape) or `cli/src/config.ts` (resolveConfig not merging new shape correctly). Fix the formatter, not the profile.

---

## Check 2 — `bollard config show` and `bollard diff`

```
docker compose run --rm dev --filter @bollard/cli run start -- config show --sources --work-dir /app
docker compose run --rm dev --filter @bollard/cli run start -- diff --work-dir /app
```

**Pass criteria:**
- `config show` renders the new adversarial shape with source annotations (`default` / `auto-detected` / `file:.bollard.yml` / etc.).
- `diff` does not crash and does not show spurious differences for a repo that uses only defaults. If it reports differences, they must be legitimate (e.g., the repo has a `.bollard.yml` that genuinely overrides something).
- Neither command references the old flat shape.

**If it fails:** update the formatter in `cli/src/diff.ts` and wherever `config show` renders adversarial. The source annotation ("sources") logic lives in `cli/src/config.ts`.

---

## Check 3 — `bollard contract` (standalone)

```
docker compose run --rm dev --filter @bollard/cli run start -- contract --work-dir /app
```

**Pass criteria:**
1. Exit code 0.
2. Output is a JSON `ContractContext` with non-empty `modules` and non-empty `edges`.
3. `modules` includes at least: `@bollard/engine`, `@bollard/agents`, `@bollard/verify`, `@bollard/blueprints`, `@bollard/cli`, `@bollard/detect`, `@bollard/llm`, `@bollard/mcp`.
4. `edges` includes at least one edge from `@bollard/blueprints` → `@bollard/verify` (because `implement-feature.ts` imports `runTests` from it) and one from `@bollard/cli` → `@bollard/agents`.
5. No edge `.importedSymbols` array is empty — an edge with no symbols is a bug in `workspacePackageIdFromImportSpec` resolution.
6. Spot-check one module: its `publicExports` should list at least a few recognizable exports (e.g., `@bollard/engine` should include `runBlueprint`, `BollardError`, `createContext`).
7. `affectedEdges` is empty for this invocation (no `--plan` supplied), which is correct.

Then test with an affected-files plan:

```
cat > /tmp/fake-plan.json <<'JSON'
{ "affected_files": ["packages/verify/src/dynamic.ts"] }
JSON
docker compose run --rm dev --filter @bollard/cli run start -- contract --work-dir /app --plan /tmp/fake-plan.json
```

`affectedEdges` should now be non-empty and should include the edge from `@bollard/blueprints` to `@bollard/verify`.

**If it fails:**
- Empty `modules`: `contract-extractor.ts` is not walking `pnpm-workspace.yaml` correctly. Log the root discovery, confirm it finds `packages/*/package.json`.
- Empty `edges`: imports are not resolving. Add a debug log showing each raw import specifier and what `workspacePackageIdFromImportSpec` returns for it. Likely a specifier format not handled (e.g. `@bollard/engine/src/types.js` or `.js` suffix on a workspace package).
- Empty `importedSymbols` in an edge: the AST walk is collecting the import but not its named bindings. Verify with a minimal fixture before touching production code.
- Information leak: re-run the existing `contract-extractor.test.ts` leak-check. If it still passes but a real run leaks, the fixture is not representative — add a new test case first.

---

## Check 4 — Information-barrier spot check

Run the contract extractor against the repo and grep for known-private identifiers. Pick two or three identifiers that should never appear in a `ContractContext` — function-local variables, file-local helpers, etc.:

```
docker compose run --rm dev --filter @bollard/cli run start -- contract --work-dir /app > /tmp/ctx.json
grep -E '(compactOlderTurns|skipVerificationAfterTurn|processConcernBlocks|extractClassSignature)' /tmp/ctx.json && echo LEAK || echo OK
```

Pass criterion: `OK`. If any of those identifiers appear in the context, the extractor is leaking implementation details — fix the extraction logic to only surface exported symbols.

---

## Check 5 — `bollard run implement-feature` self-test (the main milestone)

This is the real Stage 3a milestone. It exercises all 16 nodes on the bollard repo itself.

```
docker compose run --rm -e ANTHROPIC_API_KEY --filter @bollard/cli run start -- \
  run implement-feature \
    --task "Add a no-op debug log line at the start of CostTracker.add() that does ctx.log?.debug?.('cost:add')" \
    --work-dir /app
```

You'll hit two human gates. Approve both (type `yes` / `y`).

**Per-node pass criteria:**

| # | Node | Pass criterion |
|---|------|---------------|
| 1 | create-branch | Branch created, no git errors. |
| 2 | generate-plan | Plan JSON contains `affected_files` including `packages/engine/src/cost-tracker.ts`. |
| 3 | approve-plan | Human gate displays plan; approved. |
| 4 | implement | Coder modifies `cost-tracker.ts` using `edit_file` (not `write_file`). Does NOT exceed maxTurns. |
| 5 | static-checks | typecheck + lint + audit pass. |
| 6 | extract-signatures | Returns non-empty signatures for `cost-tracker.ts`. |
| 7 | generate-boundary-tests | Output is a valid test file (starts with imports). References `CostTracker` or `add`. Concern blocks rendered (look for "[HIGH]", "[MEDIUM]", "[LOW]" headers in the rendered prompt if you log it). |
| 8 | write-boundary-tests | Leak guard does NOT fire. File written to `tests/` or `.bollard/tests/boundary/`. |
| 9 | run-boundary-tests | Passes (a trivial debug log shouldn't break any existing behavior). |
| 10 | extract-contracts | ContractContext written to `ctx.results["extract-contracts"].data.contract`. Non-empty. Includes `@bollard/engine` as a module. |
| 11 | generate-contract-tests | Output references at least one symbol imported from `@bollard/engine` by another workspace package. Concern blocks rendered. |
| 12 | write-contract-tests | Leak guard does NOT fire. File written to `tests/contracts/` or `.bollard/tests/contract/<slug>/`. |
| 13 | run-contract-tests | Passes — the contract tests run against the actual `@bollard/engine` exports and succeed. |
| 14 | docker-verify | Passes OR gracefully skips with `reason: "docker not available"` (Docker-in-Docker may not be wired; that's acceptable here). |
| 15 | generate-diff | `git diff --stat main` output shown. |
| 16 | approve-pr | Human gate displays diff; approved. |

**Additional checks after the run:**

1. **Cost:** Total run cost should be well under $5. If it's significantly higher, inspect which agent overran — most likely candidate is the contract-tester exhausting turns because its user message is too big.
2. **Turn usage:** No agent hit its `maxTurns` limit. If the coder hit 60 or the contract-tester hit 10, that's a problem even if the node succeeded.
3. **Generated test quality spot check:** Read the generated boundary and contract test files. They should look like something a human would write — real assertions, not `expect(true).toBe(true)` stubs. If the contract test is just importing and calling without meaningful assertions, note it as a Stage 3b prompt-tuning task (do not fix in this validation pass).
4. **Information barrier:** Grep the generated test files for private identifiers (same list as Check 4). `grep` should return nothing.
5. **Git state:** After approving the PR gate, you should be on the bollard branch with all files staged for the new debug log + generated tests. Do NOT push or merge — this is a validation run, not a real change. Run `git checkout main` and `git branch -D bollard/<runId>` to clean up.

**If any node fails:** capture the node's error output, check `ctx.log`, and fix root-cause. Common failure modes and where to look:

- `extract-contracts` times out or produces empty graph → `contract-extractor.ts` async batching issue or workspace discovery failure
- `generate-contract-tests` produces empty output → user message construction in `buildContractTesterMessage` is missing fields, agent has no context
- `write-contract-tests` leak guard fires → one of two things:
  (a) the extractor is leaking private identifiers into `publicExports`, or
  (b) the agent is hallucinating identifiers that happen to match private ones. Dump both the context and the output and determine which.
- `run-contract-tests` fails → the generated test file has syntax errors or imports the wrong path. Check `resolveContractTestOutputRel` against the actual import path in the generated file.
- Coder hits maxTurns → `skipVerificationAfterTurn` may be misconfigured; budget guidance missing from prompt.

---

## Check 6 — Go and Rust extractors (non-TS fixtures)

Today the dev image only has `python3`. The Go and Rust extractors exist but their tests likely skip. Verify the skips are legitimate (toolchain missing) and not hiding a real bug.

```
docker compose run --rm dev run test --filter @bollard/verify -- --reporter verbose 2>&1 | grep -E "(go|rust|python)" | head -50
```

Expected: Python extractor tests run and pass; Go and Rust extractor tests are clearly marked as skipped with a message mentioning the missing toolchain.

**If Go/Rust tests run and fail:** fix them. They should not run without their toolchains.

**If Go/Rust tests appear to pass without running:** that's false confidence. Add an explicit `it.skip` with a `TODO(stage-3b): requires go/rust toolchain in dev image` comment so the situation is visible.

Do **not** add Go or Rust toolchains to the dev image in this pass — that's a Stage 3b decision. Just make sure the current skip behavior is honest.

---

## Check 7 — MCP `bollard_contract` tool

```
docker compose run --rm dev --filter @bollard/mcp run test
```

Expected: MCP tool tests pass, including `bollard_contract` and the updated `bollard_profile`.

Manual smoke test (optional, if the MCP server has a test harness): issue a `bollard_contract` call with `workDir` pointing at `/app` and confirm the response shape matches the CLI's output.

---

## Reporting

After all checks run, write a `spec/stage3a-validation-results.md` file with:

1. **Baseline:** typecheck/lint/test counts (pre-validation)
2. **Per-check results:** pass/fail for checks 1–7, with a one-line note on what was captured
3. **Self-test summary (Check 5):** total cost, total duration, per-node turn counts for the two agents (coder, contract-tester), whether any node failed and why
4. **Fixes applied:** list of commits made during this pass with one-line descriptions
5. **Known gaps:** anything intentionally deferred (e.g., Go/Rust toolchain in dev image, prompt-tuning for test quality)
6. **Stage 3a status:** GREEN / YELLOW / RED
   - GREEN = all checks pass, self-test complete, no fixes needed
   - YELLOW = all checks pass after fixes, self-test complete, fixes are listed
   - RED = self-test failed and cannot be fixed without design decisions; escalate

Do not start Stage 3b until this file exists and the status is GREEN or YELLOW.

---

## Explicit non-goals

- Do NOT add Go or Rust toolchains to the dev image.
- Do NOT start mutation testing, semantic review, or behavioral scope work.
- Do NOT tune the contract-tester prompt for test quality (flag it as Stage 3b task only).
- Do NOT bump any Stage 3a feature scope. This is a validation pass.
- Do NOT push or merge the self-test branch. Clean it up after the run.
