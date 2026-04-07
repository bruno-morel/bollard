# Adversarial Acceptance Criteria — Closing the Category A Gap ✅ DONE

> **Status:** Completed 2026-03-30. All 8 steps done across Passes 3 and 4. Category A failures resolved. Pipeline declared tuned at 30.2% failure rate (no dominant pattern remaining). See `docs/retro-adversarial-results.md` for full results.

---

## Prompt

I'm building **Bollard**, an artifact integrity framework for AI-assisted software development. Read the `CLAUDE.md` at the repo root — it has all the context, types, and constraints.

We've run two passes of retroactive adversarial testing (see `docs/retro-adversarial-results.md`). Pass 1 generated blind tests from type signatures and found 3 real bugs in `CostTracker`. Pass 2 added 5 prompt rules (8–12) to the tester agent and cut the failure rate from ~50% to ~50% on the worst files (but eliminated entire classes of failures like wrong identifiers and missing arguments).

**57 failures remain, all Category A** — the tester agent wrote structurally correct tests against genuinely ambiguous signatures. The information needed to write correct tests is not in the type surface and can't be derived from it. These are specification gaps, not prompt problems.

Here's the failure breakdown:

| Root Cause | Count | Example |
|---|---|---|
| `workDir` must be a real temp directory | 35 | Tool `execute(input, ctx)` does filesystem I/O but `AgentContext.workDir` is typed as `string` |
| Command allowlist is invisible | 10 | `DEFAULT_ALLOWED_COMMANDS` is a non-exported const; tester tries `echo`, `pwd` etc. |
| Zod `.strict()` is stricter than TS types | 9 | Config schema rejects extra properties; API key requirement is runtime-only |
| `loadEvalCases("")` returns all cases | 2 | Empty string is falsy, so the filter falls through to "return all" |
| Compile error in generated code | 1 | `await` outside `async` in agent-handler test |

**The fix is context hints** — runtime constraints injected into the tester's user message that describe facts invisible in type signatures. This work has three layers: the retro script stopgap (immediate), the tester prompt rule (immediate), and the pipeline integration (architecture for Stage 2).

Here's the build order — complete each step fully before moving to the next.

> **Note:** Steps 1 and 2 are already implemented. They're documented here for completeness — start execution from Step 3.

### Step 1: Context hints function in the retro script ✅ DONE

Add a `getContextHints(relativePath: string): string[]` function to `scripts/retro-adversarial.ts`. This function returns per-module runtime constraints based on substring matching on the file path.

The hints are injected as a `# Runtime Constraints (not visible in type signatures)` section in the user message, placed between the Acceptance Criteria and the Public API Surface sections. Only include the section if hints are non-empty.

**Hint categories to implement:**

**All agent tools** (match: `agents/src/tools/`):
- All tool `execute(input, ctx)` functions perform real filesystem I/O against `ctx.workDir`
- Provide a complete fixture pattern: `mkdtempSync`, `rmSync` cleanup in `afterEach`, minimal `AgentContext` construction with `pipelineCtx: {} as AgentContext["pipelineCtx"]`
- Document the path-traversal guard: resolved path must start with `workDir`
- Suggest testing traversal with `{ path: "../../../etc/passwd" }`

**run-command** (match: `tools/run-command`):
- List the exact default allowlist: pnpm, npx, node, tsc, biome, git, cat, head, tail, wc, diff
- Document the error format: `Command "X" is not allowed.`
- Note that `ctx.allowedCommands` can override the default list
- Commands are split on whitespace; first token is checked

**search** (match: `tools/search`):
- Uses `grep` against real files — create test files first
- Returns `"No matches found."` when grep exits code 1
- Results capped at 100 lines

**list-dir** (match: `tools/list-dir`):
- Reads real directory contents — create files/subdirs before calling
- Directories get trailing `/`, files don't
- Output is newline-separated

**write-file** (match: `tools/write-file`):
- Auto-creates parent directories with `{ recursive: true }`
- Returns confirmation string with byte count
- Verify writes with `readFileSync`

**read-file** (match: `tools/read-file`):
- Create files with `writeFileSync` before testing
- Reads as UTF-8
- Throws on nonexistent files

**config** (match: `cli/src/config`):
- Zod `.strict()` validation — extra properties cause rejection
- Exact valid `.bollard.yml` schema: top-level keys `llm`, `agent`, `risk` only
- Full shape of each key (see `bollardYamlSchema` in `packages/cli/src/config.ts`)
- `resolveConfig()` throws `BollardError` code `CONFIG_INVALID` without `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`
- Set env vars in `beforeEach`, clean up in `afterEach`
- Filesystem-dependent detection: use temp dir with/without marker files (tsconfig.json etc.)

**eval-loader** (match: `eval-loader`):
- `loadEvalCases(agentFilter)` returns ALL cases when `agentFilter` is `undefined`, `""`, or non-matching
- Only filters on exact match: `"planner"`, `"coder"`, `"tester"`
- `availableAgents()` returns `["planner", "coder", "tester"]`

**agent-handler** (match: `cli/src/agent-handler`):
- Heavy external dependencies require mocking: `executeAgent`, `createPlannerAgent`, `createCoderAgent`, `LLMClient`
- Provide `vi.mock(...)` patterns with correct module paths

### Step 2: Tester prompt — Rule 13 ✅ DONE

Add Rule 13 to `packages/agents/prompts/tester.md`, in the `# Critical: Use ONLY What the Signatures Tell You` section after Rule 12:

```markdown
13. **Follow Runtime Constraints exactly.** When the task includes a "Runtime Constraints" section, treat it as authoritative specification. These describe behaviors not visible in types — filesystem requirements, validation strictness, environment dependencies, allowlists, edge-case semantics. Use the exact fixture setup patterns provided. If a constraint says a function requires a temp directory, create one. If it lists allowed values, test both allowed and disallowed. If it shows required environment variables, set them.
```

This rule has different character than Rules 8–12. Those rules tell the tester how to use information it already has (type signatures). Rule 13 tells the tester to treat a new information source (runtime constraints) as first-class specification.

### Step 3: Validate with Pass 3 on the 8 worst files

Run the retro-adversarial script against the 8 worst-performing files from Pass 2:

```bash
docker compose run --rm --entrypoint sh dev -c "pnpm exec tsx scripts/retro-adversarial.ts --files \
  agents/src/eval-loader.ts \
  agents/src/tools/search.ts \
  agents/src/tools/write-file.ts \
  agents/src/tools/list-dir.ts \
  agents/src/tools/read-file.ts \
  agents/src/tools/run-command.ts \
  cli/src/config.ts \
  cli/src/agent-handler.ts"
```

**Expected outcomes:**
- `workDir` failures (35): should drop to near-zero. The fixture pattern is explicit enough.
- Command allowlist failures (10): should drop to near-zero. The list is now provided.
- Config validation failures (9): should drop significantly. Schema and env requirements are documented.
- Eval-loader edge cases (2): should resolve. Behavior is now specified.
- Agent-handler compile error (1): may persist — ESM mocking is inherently tricky.

**Decision gate:**
- If failure rate drops below 30% → Category A is resolved. Document results and proceed.
- If failure rate is 30–50% → Analyze remaining failures. Are they a new category or inadequate hints? Iterate once.
- If failure rate stays above 50% → The hint approach is insufficient. Consider enriching the type extractor to surface non-exported constants and Zod schemas.

### Step 4: Update the results doc

Append a Pass 3 section to `docs/retro-adversarial-results.md`:
- Before/after table (same format as Pass 2)
- Total token cost
- Which hint categories had the most impact
- Any new failure patterns discovered
- Updated decision gate result

### Step 5: Planner schema — `runtimeConstraints` field (architectural)

The retro script's `getContextHints()` is a hardcoded stopgap. In the implement-feature pipeline, the planner agent should generate equivalent constraints from its codebase exploration. Update the plan output schema in `packages/agents/prompts/planner.md`:

**Current step schema:**
```json
{
  "description": "What to do in this step",
  "files": ["which files are touched"],
  "tests": "What tests to write for this step"
}
```

**New step schema:**
```json
{
  "description": "What to do in this step",
  "files": ["which files are touched"],
  "tests": "What tests to write for this step",
  "runtimeConstraints": [
    "execute() requires AgentContext with a real workDir temp directory",
    "Only these commands are allowed: pnpm, npx, node, ..."
  ]
}
```

Add guidance to the planner prompt's Rules section:

```markdown
N. Include `runtimeConstraints` on steps that involve testable code. These are facts the adversarial test agent needs but can't infer from type signatures alone: filesystem requirements, environment dependencies, validation strictness beyond what types express, allowlists, default values that affect behavior, edge-case semantics (e.g., "empty string returns all results, not empty array"). The tester agent has NO access to implementation — these constraints are its only window into runtime behavior.
```

### Step 6: Tester handoff — wire runtime constraints into the tester's user message

This is the pipeline-side equivalent of the retro script's hint injection. In the implement-feature blueprint, when the tester agent is invoked, its user message should include runtime constraints from the plan.

In `packages/cli/src/agent-handler.ts` (or wherever the tester agent's user message is constructed for the pipeline):

1. Read `ctx.plan.steps[i].runtimeConstraints` (if the step has them)
2. Inject them as a `# Runtime Constraints` section in the tester's user message, same format as the retro script
3. If no constraints exist for the step, omit the section entirely

This ensures the same Rule 13 path works for both retro testing and pipeline testing — the only difference is where the constraints come from (hardcoded hints vs. planner-generated).

### Step 7: Test the planner output for constraint quality

Add 1–2 eval cases to `packages/agents/src/evals/planner/cases.ts` that assess whether the planner generates useful `runtimeConstraints`:

**Eval case: "Add path-traversal validation to file upload handler"**
- Expected: the plan should include runtime constraints about filesystem boundaries, temp directories, or path resolution
- Check: `runtimeConstraints` array exists and contains at least one constraint mentioning filesystem or path behavior

**Eval case: "Add rate limiting to the /api/search endpoint"**
- Expected: the plan should include constraints about request limits, time windows, or error responses
- Check: `runtimeConstraints` array exists and contains at least one constraint about limits or error behavior

These eval cases don't need perfect constraint wording — they check that the planner understands when and where to generate constraints at all.

### Step 8: Document the full context hints architecture

Create `docs/context-hints.md` documenting:

1. **The problem:** Type signatures are necessary but insufficient for blind test generation. Runtime constraints (allowlists, Zod schemas, filesystem requirements, env dependencies) are invisible in types.

2. **The solution:** A "Runtime Constraints" section in the tester's user message, treated as first-class specification via Rule 13.

3. **Two sources of constraints:**
   - **Retro testing:** `getContextHints()` in the retro script — hardcoded per-module patterns. Used for retroactive passes on existing code. Maintainable because the module count grows slowly.
   - **Pipeline testing:** `runtimeConstraints` field in the planner's plan output. Generated from codebase exploration. Scales to any project because the planner derives them fresh each run.

4. **Constraint taxonomy** (reference for planner prompt):
   - **Filesystem:** Functions requiring real directories, path resolution guards
   - **Validation:** Zod/schema strictness beyond TypeScript types, required env vars
   - **Allowlists:** Command whitelists, permitted values, enum-like behavior in runtime code
   - **Edge cases:** Falsy-value behavior, empty-input semantics, default return values
   - **Dependencies:** Required mocks, external services, heavy constructors
   - **Output format:** String format of return values, delimiter conventions, truncation limits

5. **When NOT to write constraints:**
   - If the behavior is obvious from the type signature (`add(a: number, b: number): number`)
   - If the behavior is covered by acceptance criteria already
   - If the function is pure with no side effects

---

### Important reminders

- **Read `docs/retro-adversarial-results.md` before starting.** It has the full failure analysis and the Pass 1/Pass 2 results that motivate every hint.
- **The retro script hints are a stopgap.** They solve the immediate problem (retro testing against existing code). The real fix is planner-generated constraints (Steps 5–6). Build both.
- **Don't over-hint.** If a constraint is derivable from the type signature, it's redundant. Hints should cover ONLY what types can't express.
- **Pass 3 is the validation step.** If it doesn't bring the failure rate below 30%, the hint content needs iteration — not the architecture.
- **All existing tests must still pass.** The planner schema change adds an optional field. The tester prompt adds a new rule. Neither should break anything.
- **No new dependencies.** Everything here is pure TypeScript string manipulation and JSON schema changes.
- **Use the exact command to run the retro pass:** `docker compose run --rm --entrypoint sh dev -c "pnpm exec tsx scripts/retro-adversarial.ts --files ..."`.
- **Commit after each step** with message format: `Stage 1-adversarial: <what>`.
