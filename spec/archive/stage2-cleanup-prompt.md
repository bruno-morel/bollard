# Stage 2 — Post-Validation Cleanup & Hardening

> Paste this into Cursor's Composer. Read `CLAUDE.md` at the repo root for full context.

---

## Prompt

I'm building **Bollard**, an artifact integrity framework for AI-assisted software development. Read `CLAUDE.md` for full context.

Stage 2 is validated and committed. Before moving to Stage 3, we need to clean up the codebase: fix real bugs, remove stale content, harden edge cases, and update documentation. This is a hygiene pass — no new features.

All commands run via Docker Compose. Run tests after each step: `docker compose run --rm dev run test`

### What exists today

- **8 packages:** engine, llm, agents, verify, blueprints, detect, cli, mcp
- **29 test files, 340 tests**, all passing
- **12-node `implement-feature` blueprint**
- Stage 2 validation found: coder can't run python/pytest (missing allowedCommands), tester constructs invalid ToolchainProfile stubs, skipVerificationAfterTurn naming is unclear, several silent failure paths

### Cleanup order

Complete each step fully before moving to the next. Run tests after each step.

---

### Step 1: Fix allowedCommands — add missing tools to the whitelist

**File:** `packages/detect/src/derive.ts` (function `deriveAllowedCommands`)

**Problem:** When the Python detector finds tools in `checks` (typecheck, linter, test, audit), only `typecheck.cmd` and `linter.cmd` get added to `extraTools`. The `audit.cmd` (`pip-audit`) and `test.cmd` (could be `poetry run pytest`) are missing. Same pattern applies to other languages.

**Fix in `packages/detect/src/languages/python.ts`**, function `detect`, around line 103:

Change the `extraTools` construction from:

```typescript
const extraTools: string[] = []
if (typecheck) extraTools.push(typecheck.cmd)
if (linter) extraTools.push(linter.cmd)
```

To:

```typescript
const extraTools: string[] = []
if (typecheck) extraTools.push(typecheck.cmd)
if (linter) extraTools.push(linter.cmd)
if (test) extraTools.push(test.cmd)
extraTools.push("pip-audit")
```

Apply the same pattern in `go.ts` and `rust.ts` — make sure every command referenced in `checks` also appears in `allowedCommands`. Check each detector's `detect()` function for gaps.

Also add `"biome"` to the TypeScript detector's extraTools in `typescript.ts` — currently it only adds `"tsc"` via the typecheck command, but `biome` is the linter and should be whitelisted. Check if this is already handled via the `linter.cmd` path.

**Tests:** Add a test in `packages/detect/tests/detect.test.ts` (or a new file `detect-allowed-commands.test.ts`) that verifies: for each language detector, every command referenced in the returned `checks` object also appears in the returned `allowedCommands` array.

```typescript
it("all Python check commands appear in allowedCommands", async () => {
  // Create a fixture with pyproject.toml + [tool.ruff] + [tool.mypy] + [tool.pytest]
  // Call detect()
  // Assert: profile.checks.typecheck.cmd is in profile.allowedCommands
  // Assert: profile.checks.lint.cmd is in profile.allowedCommands
  // Assert: profile.checks.test.cmd is in profile.allowedCommands
  // Assert: profile.checks.audit.cmd is in profile.allowedCommands
})
```

---

### Step 2: Add logging to LlmFallbackExtractor

**File:** `packages/verify/src/type-extractor.ts`

**Problem:** When the LLM returns unparseable JSON or an empty response, the extractor silently returns `{ signatures: [], types: [] }`. Impossible to debug.

**Fix:** The extractor receives an `AgentContext` or `PipelineContext` indirectly — but actually it doesn't. It's called from the blueprint node which has access to `ctx.log`. However, `SignatureExtractor.extract()` doesn't accept a logger.

Add a `warn` callback to the `LlmFallbackExtractor` constructor (not to the interface — keep the interface clean):

```typescript
export class LlmFallbackExtractor implements SignatureExtractor {
  constructor(
    private provider: LLMProvider,
    private model: string,
    private warn?: (msg: string) => void,
  ) {}

  async extract(files: string[], profile?: ToolchainProfile): Promise<ExtractionResult> {
    // ... existing code ...

    const parsed = parseLlmResponse(text)
    if (!parsed) {
      this.warn?.(`LlmFallbackExtractor: failed to parse LLM response (${text.length} chars)`)
      return { signatures: [], types: [] }
    }

    // After filtering signatures:
    const droppedSigs = (parsed.signatures ?? []).length - signatures.length
    if (droppedSigs > 0) {
      this.warn?.(`LlmFallbackExtractor: dropped ${droppedSigs} signatures with missing filePath`)
    }

    // After filtering types:
    const droppedTypes = (parsed.types ?? []).length - types.length
    if (droppedTypes > 0) {
      this.warn?.(`LlmFallbackExtractor: dropped ${droppedTypes} types with invalid kind`)
    }

    // ...
  }
}
```

Update `getExtractor()` to accept an optional `warn` callback and pass it through:

```typescript
export function getExtractor(
  lang: LanguageId,
  provider?: LLMProvider,
  model?: string,
  warn?: (msg: string) => void,
): SignatureExtractor {
  if (lang === "typescript") return new TsCompilerExtractor()
  if (provider && model) return new LlmFallbackExtractor(provider, model, warn)
  return new TsCompilerExtractor() // fallback
}
```

Update the caller in `packages/blueprints/src/implement-feature.ts`, the `extract-signatures` node, to pass `ctx.log.warn`:

```typescript
const extractor = getExtractor(lang, llmConfig?.provider, llmConfig?.model, ctx.log.warn)
```

**Tests:** Add a test that the `warn` callback is called when `parseLlmResponse` returns null:

```typescript
it("calls warn on unparseable LLM response", async () => {
  const warnings: string[] = []
  const extractor = new LlmFallbackExtractor(mockProvider, "test", (msg) => warnings.push(msg))
  // Mock provider returns "not json"
  await extractor.extract(["/tmp/test.py"], pythonProfile)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain("failed to parse")
})
```

---

### Step 3: Rename integrateWithTestRunner and fix its return semantics

**File:** `packages/verify/src/test-lifecycle.ts`

**Problem:** `integrateWithTestRunner` sounds like it modifies config files, but it only checks what should be done and returns a suggestion. The return value `{ integrated: true, method: "add X to pyproject.toml" }` is confusing — it says "integrated" but the integration hasn't happened.

**Fix:**

1. Rename `integrateWithTestRunner` → `checkTestRunnerIntegration`
2. Change the return type to be clearer:

```typescript
export interface IntegrationCheck {
  alreadyIntegrated: boolean
  suggestion: string
}

export async function checkTestRunnerIntegration(
  workDir: string,
  profile: ToolchainProfile,
): Promise<IntegrationCheck> {
  // ...
}
```

3. Fix the return values:
   - `{ alreadyIntegrated: true, suggestion: "pyproject.toml already includes .bollard/tests" }` — already done
   - `{ alreadyIntegrated: false, suggestion: "add .bollard/tests to testpaths in pyproject.toml" }` — needs manual action
   - `{ alreadyIntegrated: false, suggestion: "use --rootdir flag to include .bollard/tests" }` — needs manual action

4. Update all callers. Grep for `integrateWithTestRunner` — it's used in the blueprint and possibly the CLI.

**Tests:** Update `packages/verify/tests/test-lifecycle.test.ts` — rename references, verify new return structure.

---

### Step 4: Harden promote-test command

**File:** `packages/cli/src/index.ts`, function `runPromoteTestCommand` (around line 435)

**Problems:**
- No check that source file exists before copying
- Hard-coded `tests/` destination — ignores language conventions
- No duplication warning
- Strange dynamic `import("node:fs")` pattern

**Fix:**

```typescript
async function runPromoteTestCommand(args: string[]): Promise<void> {
  const testPath = args[0]
  if (!testPath) {
    log("Usage: bollard promote-test <path-to-adversarial-test>")
    process.exit(1)
  }

  const workDir = findWorkspaceRoot(process.cwd())
  const { copyFile, readFile: rf, writeFile: wf, access } = await import("node:fs/promises")
  const { mkdir } = await import("node:fs/promises")
  const { basename, resolve, join } = await import("node:path")

  const fullSource = resolve(workDir, testPath)

  // 1. Check source exists
  try {
    await access(fullSource)
  } catch {
    log(`${RED}✗${RESET} Source file not found: ${testPath}`)
    process.exit(1)
  }

  // 2. Use profile to determine test directory
  const config = await resolveConfig()
  const testsDir = join(workDir, "tests") // default
  // Could be enhanced to use profile.testPatterns to derive the right directory

  await mkdir(testsDir, { recursive: true })

  const fileName = basename(testPath)
  const destPath = join(testsDir, fileName)

  // 3. Check for existing file
  try {
    await access(destPath)
    log(`${YELLOW}!${RESET} File already exists: tests/${fileName} — overwriting`)
  } catch {
    // File doesn't exist — good
  }

  // 4. Copy and strip markers
  await copyFile(fullSource, destPath)
  let content = await rf(destPath, "utf-8")
  content = content.replace(/\/\/\s*@bollard-generated.*\n?/g, "")
  content = content.replace(/#\s*@bollard-generated.*\n?/g, "")
  await wf(destPath, content, "utf-8")

  log(`${GREEN}✓${RESET} Promoted: ${testPath} → tests/${fileName}`)
}
```

No new test file needed — this is a CLI command that's tested via integration.

---

### Step 5: Fix the stale TODO in dynamic.ts

**File:** `packages/verify/src/dynamic.ts`, line 23

**Change:**

```typescript
// TODO: Stage 2 -- add parsers for pytest, go test, cargo test
```

To:

```typescript
// Stage 3: add deterministic parsers for pytest, go test, cargo test output.
// Currently parseSummary only handles Vitest output format.
// Non-Vitest test runners still work (profile-driven cmd execution) — only the
// parsed summary (passed/failed counts) falls back to zero/error detection.
```

---

### Step 6: Fix MCP tsconfig to match workspace conventions

**File:** `packages/mcp/tsconfig.json`

Change from:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "dist"
  },
  "include": ["src", "tests"],
  "references": [
    { "path": "../engine" },
    { "path": "../llm" },
    { "path": "../agents" },
    { "path": "../detect" },
    { "path": "../verify" },
    { "path": "../cli" }
  ]
}
```

To:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "dist",
    "composite": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"],
  "references": [
    { "path": "../engine" },
    { "path": "../llm" },
    { "path": "../agents" },
    { "path": "../detect" },
    { "path": "../verify" },
    { "path": "../cli" }
  ]
}
```

This aligns with all other workspace packages.

---

### Step 7: Organize spec/ directory — move historical prompts to archive

The `spec/` directory has 20 files: 7 living reference docs + README + ROADMAP + 11 historical prompt files. The prompts served their purpose (driving Cursor to build each stage) but are not current guidance.

**Move these to `spec/archive/`:**

```bash
mkdir -p spec/archive
git mv spec/stage0-cursor-prompt.md spec/archive/
git mv spec/stage1.5-prompt.md spec/archive/
git mv spec/stage1.5-verification-prompt.md spec/archive/
git mv spec/stage2-prompt.md spec/archive/
git mv spec/stage2-docker-prompt.md spec/archive/
git mv spec/stage2-verification-prompt.md spec/archive/
git mv spec/stage2-validation-prompt.md spec/archive/
git mv spec/stage2-cleanup-prompt.md spec/archive/
git mv spec/adversarial-acceptance-criteria-prompt.md spec/archive/
git mv spec/bollard-CLAUDE.md spec/archive/
git mv spec/bollard-on-bollard-prompt.md spec/archive/
git mv spec/pass4-return-type-fix-prompt.md spec/archive/
```

What stays in `spec/`:
- `01-architecture.md` — living architecture reference
- `02-bootstrap.md` — historical but referenced by CLAUDE.md as the stage plan
- `03-providers.md` — cloud provider abstraction (Stage 4 reference)
- `04-configuration.md` — config philosophy and auto-detection
- `05-risk-model.md` — risk scoring design
- `06-toolchain-profiles.md` — verification layer design
- `07-adversarial-scopes.md` — forward roadmap (Stage 3+)
- `README.md` — reading order guide
- `ROADMAP.md` — deferred features

Update `spec/README.md` to note the archive:

```markdown
## Archive

Historical prompts used to drive Cursor during each build stage are in `archive/`.
These document how each stage was built but are not current guidance.
```

---

### Step 8: Update CLAUDE.md statistics and Stage 2 validation section

**File:** `CLAUDE.md`

**8a: Update the "Current Test Stats" section** (around line 510):

Replace:

```markdown
## Current Test Stats

- **29 test files, 340 tests passing** (2 skipped for live API tests, 0 failing)
- **30 adversarial test files** (separate Vitest config: `vitest.adversarial.config.ts`; 327 passing, 171 failing — failures are mostly boundary tests against invalid inputs outside type contracts)
- **Source:** ~5950 LOC across 8 packages
- **Tests:** ~4650 LOC (+ ~7670 LOC adversarial tests)
- **Prompts:** ~201 LOC (planner.md + coder.md + tester.md)
```

With current counts. Run:

```bash
# Count source LOC
find packages -path '*/src/*.ts' -not -path '*/node_modules/*' | xargs wc -l | tail -1
# Count test LOC
find packages -path '*/tests/*.test.ts' -not -name '*.adversarial.test.ts' -not -path '*/node_modules/*' | xargs wc -l | tail -1
# Count adversarial test LOC
find packages -path '*/tests/*.adversarial.test.ts' -not -path '*/node_modules/*' | xargs wc -l | tail -1
# Count prompt LOC
wc -l packages/agents/prompts/*.md | tail -1
# Count test files
find packages -name '*.test.ts' -not -name '*.adversarial.test.ts' -not -path '*/node_modules/*' | wc -l
# Count adversarial test files
find packages -name '*.adversarial.test.ts' -not -path '*/node_modules/*' | wc -l
```

Update the numbers accordingly.

**8b: Add/update the "Stage 2 Validation" section** (around line 515):

```markdown
## Stage 2 Validation (2026-04-02)

- **Test suite:** 340/340 pass, typecheck clean, lint clean
- **Milestone (TS):** Pipeline ran nodes 1–5 (create-branch → generate-plan → approve-plan → implement → static-checks). Coder correctly used `edit_file` for existing files. Failed at static-checks (Biome lint formatting) due to `skipVerificationAfterTurn` skipping lint after turn 48/60.
- **Milestone (Python):** `--work-dir` flag validated. `detectToolchain` correctly identified Python/pytest/ruff. Planner produced Python-specific plan. Coder exhausted 60 turns because `python`/`pytest` are not in `allowedCommands`.
- **Retro-adversarial:** Tester generated tests for 5 packages ($0.34 total). Information barrier held (no private identifiers leaked). All outputs include property-based tests. Key issue: tester constructs invalid ToolchainProfile stubs (uses wrong field names). See `.bollard/retro-adversarial/SUMMARY.md`.
- **Bug fixed:** `eval-runner.ts` regex validation — invalid regex in `matches_regex` assertion now returns `passed: false` instead of crashing.
```

**8c: Update the "Known limitations" section** — verify each item is still accurate after the cleanup steps above. Remove any that were fixed.

**8d: In the project structure section**, update the spec/ tree to show the `archive/` subdirectory.

---

### Step 9: Update .gitignore

**File:** `.gitignore`

Add IDE-specific directories:

```
.cursor/
.vscode/
.idea/
```

These are user-specific and shouldn't be committed.

---

### Step 10: Final verification

Run the full suite to make sure nothing was broken:

```bash
docker compose run --rm dev run test
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
```

All must pass.

---

### Done criteria

- [ ] All `checks` commands appear in `allowedCommands` for every language detector
- [ ] `LlmFallbackExtractor` logs warnings on parse failures
- [ ] `integrateWithTestRunner` renamed to `checkTestRunnerIntegration` with clear return type
- [ ] `promote-test` validates source file exists and warns on overwrite
- [ ] Stale TODO in `dynamic.ts` updated
- [ ] MCP tsconfig aligned with workspace conventions
- [ ] Historical prompts moved to `spec/archive/`
- [ ] CLAUDE.md stats updated with real counts
- [ ] `.gitignore` includes IDE directories
- [ ] All tests pass, typecheck clean, lint clean

### Commit

```bash
git add -A
git commit -m "Stage 2: post-validation cleanup and hardening

- Fix allowedCommands: all check commands now whitelisted per language
- Add logging to LlmFallbackExtractor for parse failures
- Rename integrateWithTestRunner → checkTestRunnerIntegration (clearer API)
- Harden promote-test: source validation, overwrite warning
- Update stale TODO in dynamic.ts
- Align MCP tsconfig with workspace conventions
- Move 12 historical prompts to spec/archive/
- Update CLAUDE.md with accurate LOC counts and validation results
- Add IDE directories to .gitignore
"
```
