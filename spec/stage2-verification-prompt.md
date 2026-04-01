# Stage 2 — Adversarial Verification + Bollard-on-Bollard Validation

> Paste this into Cursor's Composer. Read `CLAUDE.md` at the repo root for full context.

---

## Prompt

I've just completed Stage 2 (agent infrastructure) of **Bollard**. Read `CLAUDE.md` for full context. This prompt has two parts: (A) adversarially verify the implementation against the spec, and (B) run a bollard-on-bollard pipeline to validate the fixes work in practice.

Stage 2 added: `edit_file` agent tool (surgical string replacement), deeper type extraction (`ExtractedTypeDefinition`, `resolveReferencedTypes`, `SignatureExtractor` interface), `write-tests` fixes (test path derivation via `deriveAdversarialTestPath`, markdown fence stripping via `stripMarkdownFences`), coder max turns 60 (was 40) with `skipVerificationAfterTurn` at 80% budget, and `compactOlderTurns` handling for edit_file payloads.

Complete each step fully before moving to the next.

---

## Part A: Adversarial Verification

### Step 1: Run full verification suite

```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
docker compose run --rm dev --filter @bollard/cli run start -- verify
```

All must pass. Record: test file count, test count. Expected: 24 files, 269 tests.

### Step 2: Cross-reference edit_file tool

Read `packages/agents/src/tools/edit-file.ts` and verify:
- Path-traversal protection: resolved path must start with `ctx.workDir`
- Reads file, counts occurrences of `old_string`
- Returns error string (NOT throw) for 0 matches: "old_string not found in file"
- Returns error string (NOT throw) for >1 matches: "old_string appears N times"
- Exactly 1 match: replaces and writes, returns confirmation with affected line range
- `inputSchema` has `path`, `old_string`, `new_string` all required

Read `packages/agents/src/tools/index.ts` and verify:
- `editFileTool` is in `ALL_TOOLS`
- `editFileTool` is NOT in `READ_ONLY_TOOLS`

Read `packages/agents/tests/tools.test.ts` and verify tests cover:
- Successful single-match replacement
- Error when old_string not found
- Error when old_string appears multiple times
- Path traversal protection
- Empty new_string (deletion)
- Replacement that changes line count

If any of the above is missing or wrong, fix it.

### Step 3: Cross-reference type extraction

Read `packages/verify/src/type-extractor.ts` and verify:

**3a: New types exist:**
- `ExtractedTypeDefinition { name, kind, definition, filePath }` where kind is `"interface" | "type" | "enum" | "const"`
- `ExtractionResult { signatures: ExtractedSignature[], types: ExtractedTypeDefinition[] }`
- `SignatureExtractor` interface with `extract(files, profile?): Promise<ExtractionResult>`
- `TsCompilerExtractor` implementing `SignatureExtractor`
- `LlmFallbackExtractor` stub returning empty results
- `getExtractor(lang)` factory returning TS extractor for `"typescript"`, fallback for everything else

**3b: `extractTypeDefinitions(filePath, sourceText)` extracts:**
- Exported interfaces (full body)
- Exported type aliases (full definition)
- Exported enums (full body)
- Exported typed const declarations
- Does NOT extract non-exported types

**3c: `resolveReferencedTypes(signatures, allTypes)` does:**
- Scans signature text for PascalCase identifiers
- Looks them up in the type definitions pool
- Returns deduplicated matches
- One level of resolution (not recursive graph traversal)

**3d: `extractSignaturesFromFiles` returns `ExtractionResult`** (not bare `ExtractedSignature[]`)

**3e: Backward compatibility:**
- All callers that used to access the result as an array now access `.signatures`
- Check `packages/blueprints/src/implement-feature.ts` — the extract-signatures node stores both `result.signatures` and `result.types`
- Check `packages/cli/src/agent-handler.ts` — `buildTesterMessage` includes both signatures AND type definitions in the tester's user message

Read `packages/verify/tests/type-extractor.test.ts` and verify tests cover:
- Interface extraction
- Type alias extraction
- Const extraction
- Non-exported types excluded
- Reference resolution with dedup
- ExtractionResult shape from extractSignaturesFromFiles
- TsCompilerExtractor
- LlmFallbackExtractor returns empty
- getExtractor routing

If any of the above is missing or wrong, fix it.

### Step 4: Cross-reference write-tests helpers

Read `packages/blueprints/src/write-tests-helpers.ts` and verify:

**4a: `deriveAdversarialTestPath(sourceFile)`:**
- `packages/cli/src/index.ts` → `packages/cli/tests/index.adversarial.test.ts`
- `src/main.py` → `tests/main.adversarial.test.py`
- File not in `src/` → adjacent with `.adversarial.test` suffix
- Preserves file extension (`.ts`, `.py`, `.go`, etc.)

**4b: `stripMarkdownFences(output)`:**
- Strips opening fence (` ```typescript\n `, ` ```ts\n `, ` ```\n `, etc.)
- Strips closing fence (` \n``` `)
- Returns unchanged output when no fences present
- Handles partial fences (only opening, only closing)

Read `packages/blueprints/src/implement-feature.ts` — the `write-tests` node must:
- Call `deriveAdversarialTestPath(firstFile)` instead of hardcoded `.replace`
- Call `stripMarkdownFences(testerOutput)` before writing

Read `packages/blueprints/tests/write-tests-helpers.test.ts` and verify tests cover all the above cases.

If any of the above is missing or wrong, fix it.

### Step 5: Cross-reference coder turn budget

Read `packages/agents/src/coder.ts`:
- `maxTurns` must be 60

Read `packages/agents/src/types.ts`:
- `ExecutorOptions` (or equivalent) must have `skipVerificationAfterTurn?: number`

Read `packages/agents/src/executor.ts`:
- The verification hook (postCompletionHook) must check the turn count
- If the coder is past the `skipVerificationAfterTurn` threshold, skip the hook
- The compaction logic (`compactOlderTurns`) must handle `edit_file` payloads (truncate `old_string`/`new_string` in older turns)

Read `packages/agents/prompts/coder.md`:
- Must have a "File Editing Strategy" section telling the coder to prefer `edit_file`
- Must have a "Turn Budget" section telling the coder not to run verification commands itself

Read `packages/cli/src/agent-handler.ts`:
- Must wire `skipVerificationAfterTurn: 48` (80% of 60) into executor options

If any of the above is missing or wrong, fix it.

### Step 6: Adversarial edge case tests

Create `packages/agents/tests/edit-file.adversarial.test.ts`:

1. **Unicode content**: File contains Unicode characters. `old_string` and `new_string` both contain Unicode. Verify correct replacement.
2. **Regex-special characters**: `old_string` contains regex metacharacters (`$`, `(`, `)`, `.`, `*`, `+`, `?`, `{`, `}`, `[`, `]`, `^`, `|`, `\`). These must be treated as literal strings, not regex patterns.
3. **Newlines in old_string**: `old_string` spans multiple lines. Verify it matches across lines.
4. **Empty file**: `edit_file` on an empty file with any `old_string`. Should return "not found".
5. **old_string equals entire file content**: Verify it replaces the whole file (equivalent to write_file).
6. **new_string identical to old_string**: No-op edit. Should succeed (the match is still unique) but the file is unchanged.
7. **Concurrent-safety boundary**: Write a file, edit it, read it back. Verify the edit was persisted.

Create `packages/verify/tests/type-extractor.adversarial.test.ts` (extend existing if it exists):

1. **Generic types**: `interface Foo<T> { value: T }` — verify the full generic signature is captured.
2. **Union/intersection types**: `type Bar = A & B | C` — verify the full definition is captured.
3. **Re-exported types**: `export type { Foo } from './other'` — verify these are NOT extracted (they're re-exports, the definition lives elsewhere).
4. **Deeply nested types**: `interface A { b: { c: { d: string } } }` — verify the full nested structure is captured.
5. **Type referencing another type**: `function foo(x: Bar): Baz` where both `Bar` and `Baz` are exported types. Verify `resolveReferencedTypes` returns both.
6. **Self-referencing type**: `interface TreeNode { children: TreeNode[] }` — verify it doesn't infinite-loop.
7. **No types to resolve**: Function with only primitive params (`string`, `number`, `boolean`). Verify `resolveReferencedTypes` returns empty array.

Create `packages/blueprints/tests/write-tests-helpers.adversarial.test.ts`:

1. **Double src**: `packages/src/src/foo.ts` — only the first `/src/` is replaced.
2. **Path with no extension**: `src/Makefile` — verify it doesn't crash, produces a reasonable path.
3. **Nested fences**: ` ```typescript\n  const x = "`" + "`" + "`"\n ``` ` — inner backticks preserved, outer fences stripped.
4. **Multiple code blocks**: Tester output has two fenced blocks. Only the outermost fences are stripped.
5. **Windows-style paths** (`src\\foo.ts`): Should handle gracefully or at minimum not crash.

### Step 7: Retro-adversarial pass

Run the adversarial retro script:

```bash
docker compose run --rm --entrypoint sh dev -c "pnpm exec tsx scripts/retro-adversarial.ts"
```

The deeper type extraction should improve the adversarial pass rate. Compare to baseline:
- Post-Stage-1.5 verification: 477 pass / 146 fail (76.6% pass rate)

Record the new pass/fail counts. If the pass rate improved, the type definitions are helping. If it regressed, investigate — the `extractSignaturesFromFiles` return type change might have broken the retro script's expectations.

### Step 8: Update CLAUDE.md

Verify CLAUDE.md reflects the current state:
- Stage 2 (agent infrastructure) marked DONE
- edit_file tool in the agent tools table
- Coder: 6 tools, 60 turns, skipVerification at 80%
- Type extractor: `ExtractedTypeDefinition`, `ExtractionResult`, `resolveReferencedTypes`, `SignatureExtractor`
- write-tests: `deriveAdversarialTestPath`, `stripMarkdownFences`
- Test stats updated (should be 24+ files, 269+ tests after adding adversarial edge cases)
- Source/Test LOC updated
- Known limitations updated (Docker isolation is next, non-TS extraction is LLM fallback stub)

Fix any discrepancies.

---

## Part B: Bollard-on-Bollard Validation

### Step 9: Run `bollard run implement-feature`

This is the critical test. Run the pipeline against a task that exercises all the Stage 2 fixes:

```bash
docker compose run --rm dev --filter @bollard/cli run start -- run implement-feature \
  --task "Add a 'config diff' subcommand to the Bollard CLI that compares the resolved BollardConfig against the hardcoded defaults.

Implementation requirements:
1. Add a 'diff' handler in packages/cli/src/index.ts. You MUST use edit_file to add the new command — do NOT rewrite the entire file.
2. Create a helper function in a new file packages/cli/src/diff.ts that takes a BollardConfig and the defaults, returns a structured comparison object showing which values match defaults and which differ.
3. The CLI output should use color: green for unchanged values, yellow for values that differ from defaults, showing both the default and resolved value.
4. Add tests in packages/cli/tests/diff.test.ts for the helper function.

Follow all conventions in CLAUDE.md: named exports only, no semicolons, BollardError for errors, kebab-case files."
```

**What to verify at each human gate:**

**Plan gate (approve-plan):**
- Does the plan correctly identify that `index.ts` needs a new command handler?
- Does it plan to use `edit_file` for modifying `index.ts`?
- Does it plan a separate `diff.ts` for the testable logic?
- Are existing commands (run, plan, verify, config, init, eval, diff) acknowledged as preserved?

**PR gate (approve-pr):**
- Was `edit_file` used for `index.ts` (check the git diff — it should be a surgical addition, not a full rewrite)?
- Are existing commands still present in `index.ts`?
- Does `diff.ts` exist with a clean helper function?
- Do tests exist and do they test meaningful cases?
- Are adversarial tests in `tests/` (not `src/`)?
- Are adversarial tests free of markdown fences?
- Do adversarial tests use correct type shapes (checks as object, adversarial as object)?

Record the results:

| Metric | Value |
|--------|-------|
| Total cost ($) | |
| Duration (min) | |
| Planner turns | |
| Coder turns (out of 60) | |
| Tester turns | |
| Did coder use edit_file for index.ts? | |
| Did coder preserve existing commands? | |
| Static checks passed? | |
| Adversarial tests generated (count) | |
| Adversarial tests type-correct? | |
| Adversarial test file location | |
| Markdown fences in test file? | |
| Human gate interventions | |

### Step 10: Final verification

After the pipeline run (pass or fail), run the full suite:

```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

Print LOC:

```bash
docker compose run --rm --entrypoint sh dev -c "find packages/*/src -name '*.ts' | xargs wc -l | tail -1"
docker compose run --rm --entrypoint sh dev -c "find packages/*/tests -name '*.ts' | xargs wc -l | tail -1"
```

If the pipeline run failed, diagnose why. Compare the failure mode to the bollard-on-bollard findings:
- Did the coder still rewrite files? → edit_file prompt guidance needs strengthening
- Did the tester generate type-incorrect tests? → type definition handoff needs debugging
- Did the coder hit max turns? → 60 is still too low, or verification loop is still eating budget
- New failure mode? → Document it for Stage 2 Docker isolation or Stage 3

If the pipeline run succeeded and all the metrics in the table above look correct, this is the proof that the Stage 2 agent infrastructure fixes work. Commit with: `Stage 2-verify: bollard-on-bollard validation pass`.

---

### Important reminders

- **Part A is verification, Part B is validation.** Part A checks the code is correct. Part B checks it works in practice. Both matter.
- **You ARE the human in the loop for Part B.** Read every plan and diff. Don't rubber-stamp.
- **Tester Rules 8-15 must still be intact.** If anything in `tester.md` was modified during Stage 2 implementation, revert the rules to their pre-Stage-2 state.
- **The retro-adversarial script must still work.** If the `extractSignaturesFromFiles` return type change broke it, fix the script to handle the new `ExtractionResult` shape.
- **Commit after each step** with message format: `Stage 2-verify: <what>`.
- **Run everything through Docker Compose.**
