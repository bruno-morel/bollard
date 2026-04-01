# Stage 2 — Adversarial Verification Infrastructure

> Paste this into Cursor's Composer. Read `CLAUDE.md` at the repo root for full context. Read `spec/06-toolchain-profiles.md` for the verification layer design and `spec/02-bootstrap.md` Stage 2 section for the build plan.

---

## Prompt

I'm building **Bollard**, an artifact integrity framework for AI-assisted software development. Read `CLAUDE.md` for full context.

We're at Stage 1.5 (language-agnostic toolchain detection, profile-driven verification, templatized agent prompts). We've run three bollard-on-bollard pipeline runs and discovered critical issues in the agent infrastructure. This prompt builds Stage 2 **and** fixes the infrastructure problems revealed by real pipeline usage.

Here's what exists today:

- **7 packages:** engine, llm, agents, verify, blueprints, detect, cli
- **23 test files, 240 tests**, all passing
- **~4970 source LOC, ~3415 test LOC, ~220 prompt LOC**
- **11-node implement-feature blueprint:** create-branch → generate-plan → approve-plan → implement → static-checks → extract-signatures → generate-tests → write-tests → run-tests → generate-diff → approve-pr
- **3 agents:** planner (read-only tools, 25 turns), coder (5 tools, 40 turns), tester (no tools, 5 turns)
- **5 agent tools:** read_file, write_file, list_dir, search, run_command
- **Profile-driven verification:** `ToolchainProfile` threaded through all agents, static checks, dynamic tests

### Bollard-on-Bollard Findings (Must Be Addressed)

Three real pipeline runs ($2.11 total, ~50 minutes) revealed these critical issues:

**P0 — Coder rewrites entire files instead of surgical edits (Finding #3, #12):**
The coder has only `write_file` (full overwrite). Every run, it rewrote `index.ts` from memory, dropping existing commands (`config show`, `init`, `eval`). This is the single most damaging failure mode. **Fix: add an `edit_file` tool.**

**P0 — Type signature extraction too shallow (Finding #4, #13):**
The tester sees `diffToolchainProfile(profile: ToolchainProfile): DiffResult` but not what `ToolchainProfile` actually contains. It guessed `checks` was an array and `adversarial` was a boolean. **Fix: extract referenced type definitions alongside function signatures.**

**P1 — Adversarial test file placed wrong (Finding #5):**
`write-tests` node derives path from the first affected source file: `firstFile.replace(/\.ts$/, ".adversarial.test.ts")`. This puts tests in `src/` instead of `tests/`. **Fix: derive test path from `profile.testPatterns`.**

**P1 — Markdown fences in test output (Finding #6):**
The tester wraps its output in ` ```typescript ` fences. The `write-tests` node writes this verbatim to `.ts` files. **Fix: strip markdown fences in `write-tests` before writing.**

**P1 — Coder max turns insufficient (Finding #1, #7):**
40 turns is too low. The coder spends ~8-12 turns on verification loops (typecheck → fix → re-run). **Fix: increase to 60 turns AND add turn budget guidance in the coder prompt.**

Here's the build order — complete each step fully before moving to the next:

---

### Step 1: Add `edit_file` agent tool

Create `packages/agents/src/tools/edit-file.ts`:

```typescript
export const editFileTool: AgentTool = {
  name: "edit_file",
  description: "Replace a specific string in a file with new content. The old_string must appear exactly once in the file. Use this for surgical edits instead of rewriting entire files.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path to the file from the project root",
      },
      old_string: {
        type: "string",
        description: "The exact string to find and replace. Must match exactly once in the file. Include enough surrounding context to make the match unique.",
      },
      new_string: {
        type: "string",
        description: "The replacement string. Can be empty to delete the matched content.",
      },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute(input, ctx) { ... },
}
```

The implementation:
1. Resolve path with path-traversal guard (same as write-file and read-file)
2. Read the file contents
3. Count occurrences of `old_string` in the file
4. If 0 matches: return error "old_string not found in file"
5. If >1 matches: return error "old_string appears N times — include more context to make it unique"
6. If exactly 1 match: replace and write the file
7. Return a confirmation with the line range that was modified

Register it in `packages/agents/src/tools/index.ts` — add to `ALL_TOOLS` (not `READ_ONLY_TOOLS`).

Update `coder.md` prompt — add guidance:

```markdown
## File Editing Strategy

**Prefer `edit_file` over `write_file` for modifying existing files.** The `edit_file` tool replaces a specific string in a file, preserving all surrounding content. Use `write_file` only for creating new files.

When using `edit_file`:
- Include enough surrounding lines in `old_string` to make the match unique
- If the match fails (0 or >1 occurrences), read the file first to find the exact string
- For multiple edits to the same file, make them one at a time — each edit changes the file content
```

Write tests in `packages/agents/tests/tools.test.ts` (extend the existing file):
- Successful single-match replacement
- Error when old_string not found
- Error when old_string appears multiple times
- Path traversal protection
- Empty new_string (deletion)
- Replacement that changes line count

**This is the highest-priority item. Get it right.**

---

### Step 2: Deepen type signature extraction

The current `packages/verify/src/type-extractor.ts` extracts function signatures but not the types they reference. The adversarial tester needs the full type graph to write structurally correct tests.

**2a: Add type definition extraction.** Extend `extractSignaturesFromFiles` to also extract:
- Exported `interface` definitions (full body, not just names)
- Exported `type` aliases (full definition)
- Exported `enum` definitions
- Exported `const` type annotations (for constant objects used as configuration)

The current `ExtractedSignature` type needs a new sibling:

```typescript
export interface ExtractedTypeDefinition {
  name: string
  kind: "interface" | "type" | "enum" | "const"
  definition: string  // Full source text of the type definition
  filePath: string
}

// Update the return type of extractSignaturesFromFiles
export interface ExtractionResult {
  signatures: ExtractedSignature[]
  types: ExtractedTypeDefinition[]
}
```

Keep backward compatibility: `extractSignaturesFromFiles` can return the new shape while the old callers still work (they access `.signatures`).

**2b: Resolve referenced types.** When a function signature references `ToolchainProfile`, find that type's definition and include it. This doesn't need full graph traversal — one level of reference resolution handles 90% of cases:

1. For each extracted signature, collect type names referenced in parameters and return type
2. Look up those names in the extracted type definitions
3. Include any resolved types in the output

The tester agent's user message (built in `agent-handler.ts` `buildTesterMessage`) already includes the signatures. Update it to also include the resolved type definitions, clearly labeled:

```
## Referenced Type Definitions

```typescript
interface ToolchainProfile {
  language: LanguageId
  packageManager?: PackageManagerId
  checks: { typecheck?: VerificationCommand; ... }
  ...
}
```
```

**2c: Add the `SignatureExtractor` interface** (from spec/02-bootstrap.md):

```typescript
export interface SignatureExtractor {
  extract(files: string[], profile?: ToolchainProfile): Promise<ExtractionResult>
}
```

Implement `TsCompilerExtractor` wrapping the existing logic. For non-TypeScript languages, create `LlmFallbackExtractor` as a stub with a `// TODO: Stage 2 — implement LLM-based signature extraction` comment. The `getExtractor(lang)` function returns the TS extractor for TypeScript and the fallback for everything else.

Write tests:
- Type definitions are extracted alongside function signatures
- Referenced types are resolved (e.g., a function using `ToolchainProfile` param gets the interface definition included)
- Types from different files are cross-referenced
- Non-exported types are NOT included (they're private)

---

### Step 3: Fix write-tests node — test placement and fence stripping

In `packages/blueprints/src/implement-feature.ts`, the `write-tests` node has two bugs:

**3a: Wrong test path.** Currently:
```typescript
const testPath = firstFile.replace(/\.ts$/, ".adversarial.test.ts")
```

This derives from the source file path, placing tests alongside source in `src/`. Fix:
```typescript
// Derive test directory from profile.testPatterns or fall back to tests/
function deriveAdversarialTestPath(
  sourceFile: string,
  profile?: ToolchainProfile,
): string {
  // Extract the test directory from testPatterns (e.g., "**/*.test.ts" -> tests/)
  // If patterns don't indicate a directory, use "tests/" as default
  // Name: {module}.adversarial.test.{ext}
  const basename = path.basename(sourceFile, path.extname(sourceFile))
  const ext = path.extname(sourceFile)  // .ts, .py, etc.

  // For TypeScript: place in tests/ matching the source structure
  // e.g., packages/cli/src/index.ts -> packages/cli/tests/index.adversarial.test.ts
  return sourceFile
    .replace(/\/src\//, "/tests/")
    .replace(new RegExp(`\\${ext}$`), `.adversarial.test${ext}`)
}
```

Handle the common convention: if source is in `src/`, test goes in `tests/` (same parent). If source is not in a `src/` directory, place test adjacent with `.adversarial.test` suffix.

**3b: Strip markdown fences.** The tester output often starts with ` ```typescript\n ` and ends with ` \n``` `. Strip these before writing:

```typescript
function stripMarkdownFences(output: string): string {
  let result = output.trim()
  // Strip opening fence: ```typescript, ```ts, ```python, etc.
  result = result.replace(/^```\w*\n/, "")
  // Strip closing fence
  result = result.replace(/\n```\s*$/, "")
  return result
}
```

Apply this in the `write-tests` node before `writeFile`.

Write tests:
- Test path derivation: `packages/cli/src/index.ts` → `packages/cli/tests/index.adversarial.test.ts`
- Test path derivation: `src/main.py` → `tests/main.adversarial.test.py`
- Test path derivation: file not in `src/` → adjacent `.adversarial.test.ext`
- Fence stripping: ` ```typescript\n...\n``` ` → clean TypeScript
- Fence stripping: no fences → output unchanged
- Fence stripping: partial fences (only opening, only closing)

---

### Step 4: Increase coder turns and add budget guidance

**4a: Increase `maxTurns` for the coder agent.** In `packages/agents/src/coder.ts`:

```typescript
// Before
maxTurns: 40

// After
maxTurns: 60
```

**4b: Add turn budget guidance to `coder.md` prompt.** Add a new section:

```markdown
## Turn Budget

You have a limited number of turns. Use them wisely:
- **Read and plan before writing** (2-4 turns). Understand the existing code before modifying it.
- **Write code** (main budget). Use `edit_file` for existing files, `write_file` for new files.
- **Do NOT run verification commands yourself** — the system runs them automatically after you declare completion. Running `pnpm run typecheck` or `pnpm run test` yourself wastes turns.
- If you're running low on turns, prioritize completing the implementation over running checks.
```

**4c: Update the verification hook behavior** in `packages/cli/src/agent-handler.ts`. The current `createVerificationHook` runs after every coder message that looks like completion. When it fails, the error message consumes 2+ turns in a fix-retry loop. Add a turn count check:

In `createAgenticHandler`, track the coder's turn count. If the coder is above 80% of max turns (48/60), skip the verification hook and let the coder finish — the static-checks node will catch issues anyway. This prevents the "verification loop eats remaining turns" failure mode.

Write tests:
- Coder agent now has 60 max turns
- Coder agent has both `edit_file` and `write_file` in its tools

---

### Step 5: Update the implement-feature blueprint for deeper extraction

The `extract-signatures` node currently only returns function signatures. Update it to use the new `ExtractionResult` (signatures + types).

In the `generate-tests` node handler (in `agent-handler.ts` `buildTesterMessage`), include both signatures AND referenced type definitions in the tester's user message. The tester should see:

```
## Function Signatures

export function diffToolchainProfile(profile: ToolchainProfile): DiffResult
export function detectToolchain(cwd: string): Promise<ToolchainProfile>

## Referenced Type Definitions

interface ToolchainProfile {
  language: LanguageId
  packageManager?: PackageManagerId
  checks: {
    typecheck?: VerificationCommand
    lint?: VerificationCommand
    test?: VerificationCommand
    audit?: VerificationCommand
    secretScan?: VerificationCommand
  }
  // ... full definition
}

type LanguageId = "typescript" | "javascript" | "python" | ...
```

This gives the tester the structural information it needs to write type-correct tests.

Update the `extract-signatures` node in `implement-feature.ts` to store the full `ExtractionResult` in `ctx.results`, and update `buildTesterMessage` to format both sections.

---

### Step 6: Wire it all up and verify

Run the full suite:

```bash
docker compose build dev
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
docker compose run --rm dev --filter @bollard/cli run start -- verify
```

All existing 240 tests must pass, plus the new tests from Steps 1–5.

Then run the retro-adversarial script:

```bash
docker compose run --rm --entrypoint sh dev -c "pnpm exec tsx scripts/retro-adversarial.ts"
```

The adversarial pass rate should improve (the type definitions feed through the retro script's signature extraction too). Record:
- Test count before and after
- Adversarial pass rate before and after
- Any new failure patterns

---

### Step 7: Update CLAUDE.md

Update to reflect Stage 2 work:

- **Agent tools:** 6 tools (add edit_file to the table)
- **Coder agent:** 60 turns (was 40)
- **Type extractor:** now extracts type definitions alongside signatures
- **write-tests node:** profile-aware test placement, markdown fence stripping
- **Scope control:** Mark Stage 2 items that are now done. Update "DO NOT build yet" section.
- **Test stats:** Update counts
- **Size section:** Update LOC counts
- **Known limitations:** Update to reflect what's still missing from Stage 2 (Docker isolation, non-TS extractors, LLM fallback extractor)

---

### Step 8: Bollard-on-Bollard validation

Run `bollard run implement-feature` against a focused task to validate the improvements:

```bash
docker compose run --rm dev --filter @bollard/cli run start -- run implement-feature \
  --task "Add a 'config diff' subcommand to the CLI that shows the difference between the resolved BollardConfig and the defaults. Print changed values in yellow, unchanged in green. Add the subcommand handler in packages/cli/src/index.ts (do NOT rewrite the entire file — use edit_file to add only the new command handler)."
```

**What we're validating:**
1. The coder uses `edit_file` instead of `write_file` for modifying `index.ts`
2. The coder doesn't drop existing commands
3. The tester generates structurally correct adversarial tests (because it can see type definitions)
4. Adversarial tests are placed in `tests/` not `src/`
5. No markdown fences in the test file
6. The coder completes within 60 turns

Record the results in the same format as the bollard-on-bollard summary. If the coder still uses `write_file` for existing files, the prompt guidance needs strengthening — but the fact that `edit_file` exists and is described in the prompt should be sufficient.

---

### Deferred Issues (Post-Stage 2)

These findings from the bollard-on-bollard runs are NOT addressed by this prompt. Track them for future work:

**Finding #2 — Wrong profile detected (JavaScript instead of TypeScript):**
During Run 1, the workspace was detected as JavaScript despite having `tsconfig.json`. The detection code looks correct (TypeScript detector runs first, JS detector has a tsconfig.json guard). This may have been a transient issue caused by the JS detector being added mid-run. **Action:** Monitor in future pipeline runs. If it recurs, add a regression test that detects the Bollard workspace after all detectors are registered and asserts TypeScript.

**Finding #7 — Verification hook feedback loop wastes turns:**
The Step 4 turn-budget fix (skip verification above 80% turns) partially addresses this, but the root cause is deeper: the coder retries typecheck failures even when the fix is trivial. **Action:** Stage 3 could introduce a "verification summary" approach where all check results are batched into a single feedback message instead of per-check retries.

**Finding #11 — Coder rewrote eval command with wrong API:**
The coder fabricated an eval implementation using a completely different API (`evalCase.agent`, `evalCase.input`). This is an LLM hallucination problem, not a tooling problem. **Action:** The edit_file tool eliminates the rewrite-from-memory failure mode. If the coder still fabricates APIs when writing new code, the coder prompt may need explicit "read before writing" rules.

**Finding #14 — No rollback on coder max-turns failure:**
When the coder exceeds max turns, partially-written files remain on disk. **Action:** Stage 3 should add `git stash` or branch reset in the runner's error handler. For now, the human gate at approve-pr catches this (the diff will show the partial state).

---

### Important reminders

- **Read CLAUDE.md before starting.** It has the current state, all types, all conventions.
- **The edit_file tool is the highest-priority item.** Get it right before moving to other steps. The coder rewriting entire files is the #1 pipeline reliability issue.
- **Preserve ALL existing behavior.** Every existing test must pass unchanged. Functions that work without profiles must continue to work.
- **Don't build Docker isolation yet.** That's the second half of Stage 2 (a separate prompt). This prompt focuses on the agent infrastructure fixes and deeper type extraction.
- **The tester Rules 8–15 are sacrosanct.** Don't modify them. They were tuned over 4 adversarial passes.
- **Test each step individually before moving to the next.** Run `docker compose run --rm dev run test` after each step.
- **Commit after each step** with message format: `Stage 2: <what>`.
- **Run everything through Docker Compose.** Never bare `pnpm` on the host.
