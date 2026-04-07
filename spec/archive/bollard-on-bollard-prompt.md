# Bollard-on-Bollard: Three Pipeline Runs

> Paste this into Cursor's Composer. Read `CLAUDE.md` at the repo root for full context. This prompt runs `bollard run implement-feature` three times — each task exercises a different part of the newly profile-driven pipeline.

---

## Prompt

I'm building **Bollard**, an artifact integrity framework for AI-assisted software development. Read `CLAUDE.md` for the full context.

We just completed Stage 1.5 (language-agnostic toolchain detection) and its adversarial verification pass. The pipeline is at 222 tests, 21 files, all green. Now we're going to **use Bollard to extend Bollard** — running the actual `implement-feature` pipeline against three real tasks, in sequence.

Each run exercises the full 11-node pipeline: create-branch → generate-plan → approve-plan → implement → static-checks → extract-signatures → generate-tests → write-tests → run-tests → generate-diff → approve-pr. The planner reads code, the coder writes code, static checks run profile-driven, the tester generates blind adversarial tests from type signatures, and human gates present diffs for approval.

**IMPORTANT: You are the human in the loop.** When the pipeline hits a `human_gate` node (approve-plan, approve-pr), it will print the plan or diff and wait for approval via stdin. Read what the agent produced, evaluate it, and approve or reject. Approve if the output is correct and complete. Reject if it's wrong, incomplete, or if it violates the conventions in CLAUDE.md.

### Prerequisites

Make sure ANTHROPIC_API_KEY is set in the `.env` file at the project root. Build the dev image if needed:

```bash
docker compose build dev
```

### Run 1: Add JavaScript language detector

This is the most contained task — one new file following four existing examples. It tests that the planner can read existing detectors and produce a coherent plan, that the coder follows the established pattern, and that the adversarial tester can generate blind tests from the new detector's signatures.

```bash
docker compose run --rm dev --filter @bollard/cli run start -- run implement-feature \
  --task "Add a JavaScript language detector to @bollard/detect.

Detect by the presence of package.json WITHOUT tsconfig.json (if tsconfig.json exists, the TypeScript detector should win instead).

Detection rules:
- Package manager: same as TypeScript (pnpm-lock.yaml -> pnpm, yarn.lock -> yarn, package-lock.json -> npm, bun.lockb -> bun, default npm)
- Linter: biome.json -> Biome, .eslintrc.* or eslint.config.* -> ESLint (same markers as TS)
- Test framework: vitest.config.* -> Vitest, jest.config.* -> Jest, .mocharc.* or mocha in package.json -> Mocha
- No type checker (JavaScript has no built-in type check unless jsdoc/tsc --checkJs, skip for now)
- Audit: {pkg} audit --audit-level=high
- Source patterns: **/*.js, **/*.mjs, **/*.cjs, excluding test files and node_modules
- Test patterns: **/*.test.js, **/*.spec.js, **/*.test.mjs, **/*.spec.mjs
- Ignore patterns: node_modules, dist, coverage, .cache
- Allowed commands: derive from language + detected tools
- Adversarial mode: blackbox (no in-language yet)

Create packages/detect/src/languages/javascript.ts following the exact pattern of typescript.ts.
Register it in packages/detect/src/detect.ts — it must run AFTER the TypeScript detector (TS takes priority when both markers exist).
Add a js-project fixture directory with package.json (no tsconfig), .eslintrc.json, jest.config.js, and package-lock.json.
Add tests in detect.test.ts covering: positive detection, negative (TS project should not match JS), correct package manager, correct linter, correct test framework, correct source/test patterns.

Follow all conventions in CLAUDE.md: named exports only, no semicolons, no classes, BollardError for errors, kebab-case files."
```

**What to watch for at the human gates:**
- **Plan gate:** Does the plan correctly identify that JS detection must run after TS? Does it mention the tsconfig.json exclusion logic? Does it list the right files to create/modify?
- **PR gate:** Does the diff show a clean new detector file? Are the tests comprehensive? Is detect.ts updated with the new detector in the right position?

After the run completes (or fails), record:
- Total cost ($)
- Total duration
- Number of turns per agent (planner, coder, tester)
- Static check results (typecheck, lint, audit)
- Adversarial test results (generated count, pass/fail)
- Whether the human gates caught any issues

Then verify the result:

```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

If there are failures from the bollard run, fix them manually before proceeding to Run 2.

---

### Run 2: Add --profile flag to bollard verify

This touches the CLI and exercises the profile threading that Stage 1.5 wired up. The planner has to understand both the CLI argument parsing and the detect package. The tester will generate tests against the new CLI behavior.

```bash
docker compose run --rm dev --filter @bollard/cli run start -- run implement-feature \
  --task "Add a --profile flag to the 'bollard verify' command in packages/cli/src/index.ts.

When --profile is passed, instead of running static checks, print the detected ToolchainProfile as formatted JSON to stdout and exit 0.

Implementation:
1. In the verify command handler, check if rest includes '--profile'
2. If yes: call detectToolchain(workDir), print JSON.stringify(profile, null, 2) to stdout, exit 0
3. If no: run static checks as before (existing behavior unchanged)

The output should include all ToolchainProfile fields: language, packageManager, checks (with each command's label/cmd/args/source), sourcePatterns, testPatterns, ignorePatterns, allowedCommands, adversarial.

Add a test in packages/cli/tests/ that verifies the --profile flag produces valid JSON with the expected structure when run against the Bollard workspace. The test should import and call the profile detection directly (don't shell out to the CLI in unit tests).

Follow all conventions in CLAUDE.md."
```

**What to watch for at the human gates:**
- **Plan gate:** Does it correctly identify the verify command handler in index.ts? Does it plan to add the flag parsing before the existing static checks call?
- **PR gate:** Is the existing verify behavior completely unchanged when --profile is not passed? Does the JSON output include all profile fields?

Record the same metrics as Run 1. Fix any failures before Run 3.

---

### Run 3: Add diff command showing profile vs hardcoded defaults

This is the hardest task — it forces the coder to understand the equivalence relationship between profile-driven and hardcoded verification. The tester will generate particularly interesting adversarial tests here because the type surface involves comparison logic.

```bash
docker compose run --rm dev --filter @bollard/cli run start -- run implement-feature \
  --task "Add a 'diff' command to the Bollard CLI that compares the detected ToolchainProfile against the hardcoded Stage 1 defaults, showing what changed.

Implementation:
1. Add a new 'diff' command in packages/cli/src/index.ts (alongside existing run, plan, verify, config, init, eval commands)
2. The command should:
   a. Run detectToolchain(workDir) to get the current profile
   b. Build the hardcoded Stage 1 defaults (the commands that runStaticChecks and runTests used before Stage 1.5 — pnpm run typecheck, pnpm run lint, pnpm audit, pnpm exec vitest run)
   c. Compare each check: if the detected command matches the hardcoded default, show it as 'unchanged'; if different, show both old and new
   d. Compare allowedCommands, sourcePatterns, testPatterns — show additions and removals
   e. Print a summary: 'N checks unchanged, M checks differ, K new checks, L removed checks'

Create a helper function (not in index.ts — put it in a new file packages/cli/src/diff.ts) that takes a ToolchainProfile and returns a structured diff object. This keeps the logic testable.

The output format should be human-readable with color coding:
- Green for unchanged/matching items
- Yellow for items that differ
- Cyan for new items (in profile but not in hardcoded)
- Red for removed items (in hardcoded but not in profile)

Add tests in packages/cli/tests/diff.test.ts for the diff helper function:
- Test with the Bollard workspace profile (everything should be 'unchanged' since the equivalence was proven in Stage 1.5)
- Test with a mock Python profile (everything should show as 'differ' since Python uses completely different tools)
- Test with an empty/unknown profile (all hardcoded items should show as 'removed')

Follow all conventions in CLAUDE.md: named exports, no semicolons, BollardError for errors."
```

**What to watch for at the human gates:**
- **Plan gate:** Does it correctly identify the hardcoded defaults? Does it plan a clean separation between the diff logic (testable helper) and the CLI output (formatting)?
- **PR gate:** Is the diff logic correct? Does the Bollard workspace actually produce all-unchanged output? Are the tests meaningful?

Record the same metrics as Runs 1 and 2.

---

### After all three runs

Run the full verification suite one final time:

```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

Then run the adversarial retro pass to check for regressions:

```bash
docker compose run --rm --entrypoint sh dev -c "pnpm exec tsx scripts/retro-adversarial.ts"
```

Print the final LOC counts:

```bash
docker compose run --rm --entrypoint sh dev -c "find packages/*/src -name '*.ts' | xargs wc -l | tail -1"
docker compose run --rm --entrypoint sh dev -c "find packages/*/tests -name '*.ts' | xargs wc -l | tail -1"
```

Create a summary report with:

| Metric | Run 1 (JS Detector) | Run 2 (--profile flag) | Run 3 (diff command) |
|--------|---------------------|------------------------|----------------------|
| Total cost ($) | | | |
| Duration (min) | | | |
| Planner turns | | | |
| Coder turns | | | |
| Tester turns | | | |
| Static checks | | | |
| Adversarial tests generated | | | |
| Adversarial tests passing | | | |
| Human gate interventions | | | |
| Final test count (project-wide) | | | |

Update CLAUDE.md test stats and LOC counts if they changed.

---

### Important reminders

- **You ARE the human in the loop.** Read every plan and diff the pipeline presents. This is not rubber-stamping — you're verifying that the AI agents produced correct output.
- **Don't skip human gates.** The whole point is exercising the full pipeline including human review.
- **If a run fails, diagnose why before retrying.** The failure might reveal a real bug in the pipeline (which is valuable signal) or an issue with the task description (which we can fix).
- **Fix issues between runs.** Each run should start from a clean, passing state.
- **Commit after each successful run** with message format: `Bollard-on-Bollard: <task summary>`.
- **Run everything through Docker Compose.** Never bare `pnpm` on the host.
- **The three tasks are ordered by difficulty.** If Run 1 fails badly, it's worth diagnosing before attempting Run 2/3 — the pipeline might have a fundamental issue.
