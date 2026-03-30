# Stage 1.5 — Language-Agnostic Toolchain Detection

> Paste this into Claude Code or Cursor's Composer. The CLAUDE.md file at the repo root has all the context. Read `spec/06-toolchain-profiles.md` for the full design spec, and `spec/02-bootstrap.md` Stage 1.5 section for the build plan.

---

## Prompt

I'm building **Bollard**, an artifact integrity framework for AI-assisted software development. Read the `CLAUDE.md` at the repo root — it has all the context, types, and constraints. Also read `spec/06-toolchain-profiles.md` for the language-agnostic verification design and `spec/02-bootstrap.md` Stage 1.5 section.

We're at Stage 1 (planner + coder agents, static verification, implement-feature blueprint). Everything works for TypeScript projects. Stage 1.5 makes the verification pipeline language-agnostic — Bollard should detect the project's language, test framework, linter, type checker, and package manager automatically, then use those detected tools for verification instead of the current hardcoded TypeScript commands.

**The critical constraint: all existing TypeScript behavior must be preserved exactly.** This is a refactor that introduces an abstraction layer, not a rewrite. The test suite must pass before and after with no changes to test expectations.

Here's the build order — complete each step fully before moving to the next:

### Step 1: Create `@bollard/detect` — types

Create `packages/detect/` with its own `package.json` (scoped as `@bollard/detect`), `tsconfig.json` extending root.

Implement `packages/detect/src/types.ts` with the core type definitions:

```typescript
type LanguageId =
  | "typescript" | "javascript" | "python" | "go" | "rust"
  | "java" | "kotlin" | "ruby" | "csharp" | "elixir" | "unknown"

type PackageManagerId =
  | "pnpm" | "npm" | "yarn" | "bun"
  | "poetry" | "pipenv" | "uv" | "pip"
  | "go" | "cargo" | "bundler" | "gradle" | "maven"

type MutationToolId = "stryker" | "mutmut" | "go-mutesting" | "cargo-mutants" | "mutant"

type ConfigSource = "default" | "auto-detected" | "env" | "file" | "cli"

interface VerificationCommand {
  label: string
  cmd: string
  args: string[]
  source: ConfigSource
}

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

  mutation?: {
    tool: MutationToolId
    command: string
    changedFilesPlaceholder: string
  }

  sourcePatterns: string[]
  testPatterns: string[]
  ignorePatterns: string[]
  allowedCommands: string[]

  adversarial: {
    mode: "blackbox" | "in-language" | "both"
    runtimeImage?: string
  }
}
```

Export all types as named exports. No implementation yet — just types.

After installing the new package, rebuild Docker: `docker compose down -v && docker compose build dev`.

### Step 2: `@bollard/detect` — per-language detection modules

Create `packages/detect/src/languages/` with one file per language. Each module exports a single function: `detect(cwd: string) → Partial<ToolchainProfile> | null`. Return `null` if the language markers aren't found.

**`typescript.ts`** — Detect by `tsconfig.json` existence. If found:
- `language: "typescript"`
- Package manager: check `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm, `bun.lockb` → bun
- Type checker: `tsc` (always, if tsconfig exists). Check `compilerOptions.strict` — if false, add a warning to output.
- Linter: `biome.json` → Biome, `.eslintrc.*` or `eslint.config.*` → ESLint
- Test framework: `vitest.config.*` → Vitest (`{pkg} run test`), `jest.config.*` → Jest (`{pkg} run test`)
- Audit: `{pkg} audit --audit-level=high`
- Source patterns: `["**/*.ts", "**/*.tsx", "!**/*.test.ts", "!**/*.spec.ts", "!**/node_modules/**", "!**/dist/**"]`
- Test patterns: `["**/*.test.ts", "**/*.spec.ts"]`
- Ignore patterns: `["node_modules", "dist", ".tsbuildinfo", "coverage"]`
- Allowed commands: `[pkg, "npx", "node", "tsc", detected_linter, "git", "cat", "head", "tail", "wc", "diff"]`
- Secret scan: gitleaks (same for all languages — check existence at runtime, not detection time)

**`python.ts`** — Detect by `pyproject.toml`, `setup.py`, `setup.cfg`, or `requirements.txt`. If found:
- `language: "python"`
- Package manager: `poetry.lock` → poetry, `Pipfile.lock` → pipenv, `uv.lock` → uv, else pip
- Type checker: `mypy.ini` or `[tool.mypy]` in pyproject.toml → mypy, `pyrightconfig.json` or `[tool.pyright]` → pyright
- Linter: `ruff.toml` or `[tool.ruff]` → Ruff, `.flake8` or `[flake8]` → flake8, `pylintrc` or `[tool.pylint]` → pylint
- Test framework: `conftest.py` or `[tool.pytest]` → pytest (`{pkg_run} pytest -v`), else check for `unittest` patterns
- Audit: `pip-audit` (always — may need install)
- Source patterns: `["**/*.py", "!**/test_*.py", "!**/*_test.py", "!**/__pycache__/**"]`
- Test patterns: `["**/test_*.py", "**/*_test.py"]`
- Ignore patterns: `["__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache", "*.egg-info"]`
- Allowed commands: `["python", "python3", pkg, "pytest", detected_typecheck, detected_linter, "pip-audit", "git", "cat", "head", "tail", "wc", "diff"]`

**`go.ts`** — Detect by `go.mod`. If found:
- `language: "go"`
- Package manager: `go` (always)
- Type checker: `go vet ./...` (built-in)
- Linter: `.golangci.yml` or `.golangci.yaml` → golangci-lint, else `go vet` is the minimum
- Test framework: `go test ./...` (built-in — presence of `_test.go` files confirms)
- Audit: `govulncheck ./...`
- Source patterns: `["**/*.go", "!**/*_test.go"]`
- Test patterns: `["**/*_test.go"]`
- Ignore patterns: `["vendor"]`
- Allowed commands: `["go", detected_linter, "govulncheck", "git", "cat", "head", "tail", "wc", "diff"]`

**`rust.ts`** — Detect by `Cargo.toml`. If found:
- `language: "rust"`
- Package manager: `cargo`
- Type checker: `cargo check` (built-in)
- Linter: `cargo clippy` (default — always available with rustup)
- Test framework: `cargo test` (built-in)
- Audit: `cargo audit`
- Source patterns: `["**/*.rs", "!**/target/**"]`
- Test patterns: `["**/*.rs"]` (Rust tests are inline — `#[test]` blocks)
- Ignore patterns: `["target"]`
- Allowed commands: `["cargo", "rustc", "git", "cat", "head", "tail", "wc", "diff"]`

**`fallback.ts`** — Returns `null` for detection (language unknown). But exports a `buildManualProfile(language, answers)` function that constructs a `ToolchainProfile` from interactive init answers. This is used by the CLI when no language is detected.

For detecting pyproject.toml sections (`[tool.mypy]`, `[tool.ruff]`, etc.), read the file and check for section headers. Use a simple regex — don't add a TOML parser dependency. If the check is ambiguous, prefer false-negative over false-positive (let the user override in `.bollard.yml`).

Write `packages/detect/tests/detect.test.ts` — test each language detector against fixture directories:

Create `packages/detect/tests/fixtures/`:
- `ts-project/` — tsconfig.json, biome.json, vitest.config.ts, pnpm-lock.yaml, package.json
- `py-project/` — pyproject.toml (with `[tool.pytest]`, `[tool.ruff]`, `[tool.mypy]` sections), conftest.py, poetry.lock
- `go-project/` — go.mod, go.sum, .golangci.yml, a dummy `main_test.go`
- `rust-project/` — Cargo.toml, Cargo.lock
- `empty-project/` — empty directory

Test that each detector returns the correct `ToolchainProfile` for its fixture. Test that detectors return `null` for the wrong language's fixture. Test the fallback returns `null` for all fixtures.

### Step 3: `@bollard/detect` — main detection orchestrator

Implement `packages/detect/src/detect.ts`:

```typescript
export async function detectToolchain(cwd: string): Promise<ToolchainProfile>
```

This function:
1. Runs all language detectors in order (TypeScript first — since it's the current default and most tested path)
2. Returns the first non-null result
3. Adds gitleaks as `checks.secretScan` if `gitleaks version` succeeds (try/catch, skip if not installed)
4. If no language detected, returns a minimal profile with `language: "unknown"` and empty checks
5. Applies `.bollard.yml` overrides if a `toolchain:` section exists (see Step 6)

Also implement `packages/detect/src/derive.ts` with helper functions:
- `deriveSourcePatterns(lang: LanguageId): string[]`
- `deriveTestPatterns(lang: LanguageId, framework?: string): string[]`
- `deriveIgnorePatterns(lang: LanguageId): string[]`
- `deriveAllowedCommands(lang: LanguageId, pkgMgr?: PackageManagerId, tools?: string[]): string[]`

These produce the sensible defaults for each language. The per-language detectors call them.

Test: `detectToolchain` on each fixture directory returns the correct full profile. Test that the TS fixture produces a profile equivalent to the current hardcoded behavior.

### Step 4: Refactor `@bollard/verify` — profile-driven static checks

This is the key refactor. `runStaticChecks` currently hardcodes three commands (`pnpm run typecheck`, `pnpm run lint`, `pnpm audit`). Change its signature to accept a `ToolchainProfile`:

```typescript
// Before
export async function runStaticChecks(workDir: string): Promise<StaticCheckResults>

// After
export async function runStaticChecks(
  workDir: string,
  profile: ToolchainProfile,
): Promise<StaticCheckResults>
```

The implementation becomes:
1. Collect all non-undefined checks from `profile.checks` (typecheck, lint, audit, secretScan)
2. Run them sequentially (same as before)
3. Same error handling, same output format

The function no longer hardcodes any commands. For the Bollard repo itself, the detected profile produces the exact same commands — so the test output is identical.

Update `createStaticCheckNode` to accept and pass through the profile.

**Critical: update the existing tests.** The integration test in `packages/verify/tests/static.test.ts` runs actual typecheck + lint against the Bollard repo. It must still pass. The test should call `detectToolchain(workDir)` to get the profile, then pass it to `runStaticChecks`. If the detection works correctly, the test output is unchanged.

### Step 5: Refactor `@bollard/agents` — profile-driven command whitelist

Change `run-command.ts` to accept the allowed commands from the agent context instead of a hardcoded default:

The `AgentContext` type (in `packages/agents/src/types.ts`) already has an `allowedCommands?: string[]` field. The `run_command` tool already reads from it:

```typescript
const allowed = ctx.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS
```

The change is: the caller (agent-handler) should populate `ctx.allowedCommands` from the `ToolchainProfile` instead of leaving it undefined. The `DEFAULT_ALLOWED_COMMANDS` constant stays as a fallback (for backward compatibility), but in normal operation the profile's list is used.

Update `createAgenticHandler` in `packages/cli/src/agent-handler.ts` to:
1. Accept a `ToolchainProfile` parameter
2. Pass `profile.allowedCommands` into the `AgentContext`
3. Use `profile.sourcePatterns` and `profile.ignorePatterns` in `buildProjectTree` instead of hardcoded `.ts`/`.md`/`node_modules`/`dist` filters

Update the existing tool tests — they should still pass since the default fallback is the same list.

### Step 6: Templatize agent prompts

The planner and coder prompts currently hardcode TypeScript-specific context. Make them templates.

**Approach: simple string replacement.** No template engine, no new dependency. The prompts gain `{{variable}}` placeholders. At agent creation time, a `fillPromptTemplate(template, profile)` function replaces them.

Create `packages/agents/src/prompt-template.ts`:

```typescript
export function fillPromptTemplate(
  template: string,
  profile: ToolchainProfile,
): string
```

Replaces these variables:
- `{{language}}` → profile.language (e.g., "TypeScript", "Python")
- `{{packageManager}}` → profile.packageManager (e.g., "pnpm", "poetry")
- `{{typecheck}}` → profile.checks.typecheck?.label ?? "none"
- `{{linter}}` → profile.checks.lint?.label ?? "none"
- `{{testFramework}}` → profile.checks.test?.label ?? "none"
- `{{auditTool}}` → profile.checks.audit?.label ?? "none"
- `{{allowedCommands}}` → profile.allowedCommands.join(", ")
- `{{sourcePatterns}}` → profile.sourcePatterns.join(", ")
- `{{testPatterns}}` → profile.testPatterns.join(", ")

Update `prompts/planner.md` — replace the hardcoded "Project Context" section:

**Before:**
```markdown
# Project Context

This is a TypeScript monorepo managed with pnpm workspaces. The workspace root is the current working directory. Key packages live under `packages/`:

- `engine/` — core runner, context, errors, cost tracking
- `llm/` — LLM provider abstraction (Anthropic)
- `agents/` — planner + coder agents, tools, executor
- `verify/` — static checks (tsc, biome, audit)
- `blueprints/` — pipeline definitions (implement-feature)
- `cli/` — CLI entry point, config, human gates

Conventions: TypeScript strict mode, named exports only, no semicolons, `BollardError` for all errors, Vitest for tests, Biome for lint/format.
```

**After:**
```markdown
# Project Context

This is a {{language}} project managed with {{packageManager}}. The workspace root is the current working directory.

Verification tools: type checking via {{typecheck}}, linting via {{linter}}, testing via {{testFramework}}, dependency audit via {{auditTool}}.

Source files match: {{sourcePatterns}}.
Test files match: {{testPatterns}}.
Allowed commands: {{allowedCommands}}.
```

Update `prompts/coder.md` similarly — replace the hardcoded references:

**Before (in Rules section):**
```markdown
3. Write tests for EVERY piece of new functionality. Use Vitest. Use fast-check for property-based tests where applicable.
```

**After:**
```markdown
3. Write tests for EVERY piece of new functionality. Use {{testFramework}}. Follow existing test patterns in the codebase.
```

**Before (in Verification section):**
```markdown
The system automatically runs `pnpm run test`, `pnpm run typecheck`, and `pnpm run lint` after you declare completion.
```

**After:**
```markdown
The system automatically runs verification checks ({{testFramework}}, {{typecheck}}, {{linter}}) after you declare completion. Do NOT run these commands yourself — it wastes tokens and time.
```

Update `createPlannerAgent` and `createCoderAgent` to accept a `ToolchainProfile`, read the template, fill it, and use the filled prompt as the system prompt.

Write tests for `fillPromptTemplate`: verify that all placeholders are replaced, verify that a TypeScript profile produces output containing "TypeScript", "pnpm", "Vitest", "Biome".

### Step 7: Refactor `@bollard/cli` — config.ts detection upgrade

Replace the current `autoDetect` function in `packages/cli/src/config.ts` with a call to `detectToolchain` from `@bollard/detect`. The `autoDetect` function currently checks 4 files (tsconfig, biome, vitest, pnpm-lock) and stores booleans. Replace it with the full profile detection.

Store the `ToolchainProfile` alongside the `BollardConfig` in the resolved config:

```typescript
export interface ResolvedConfig {
  config: BollardConfig
  profile: ToolchainProfile          // NEW
  sources: Record<string, AnnotatedValue<unknown>>
}
```

Update `resolveConfig` to call `detectToolchain(cwd)` and include the profile in the return value.

Add `.bollard.yml` schema support for the `toolchain:` override section:

```yaml
toolchain:
  language: python
  checks:
    typecheck:
      cmd: pyright
      args: ["--project", "."]
  extra_commands: ["make", "docker"]
  adversarial:
    persist: true
```

Validate with Zod. Apply overrides to the detected profile.

Update `config.test.ts`: the existing tests should still pass (TypeScript detection produces the same sources). Add new tests: verify that the profile is populated, verify that `.bollard.yml` toolchain overrides work.

### Step 8: Refactor `@bollard/cli` — `bollard init` interactive mode

Update the `init` command in `packages/cli/src/index.ts`. Currently it just runs detection and prints results. Add interactive fallback when detection has gaps:

1. Run `detectToolchain(cwd)`
2. Print detected values (same as before, but now multi-language aware)
3. If `language === "unknown"`, prompt for language selection via stdin
4. If any check is missing (no linter, no type checker, no test runner), print a warning and suggest the recommended tool for the detected language
5. For missing tools, ask if the user wants to add the recommendation to `.bollard.yml`

The interactive prompts use simple stdin readline — no inquirer or prompt library (too early for deps). For non-interactive environments (CI, piped stdin), skip the prompts and just warn.

Print the verification layers that will run:
```
Verification layers:
  Layer 1 (project tests):     poetry run pytest -v
  Layer 2 (adversarial tests): bollard/verify container (Stage 2+)
  Layer 3 (mutation testing):  mutmut (Stage 3+)
```

### Step 9: Refactor `@bollard/cli` — agent-handler.ts

Update `createAgenticHandler` to accept the `ToolchainProfile` and thread it through:

1. Accept `profile: ToolchainProfile` as a parameter
2. Pass `profile` to `createPlannerAgent(profile)` and `createCoderAgent(profile)` for prompt templating
3. Set `agentCtx.allowedCommands = profile.allowedCommands`
4. Update `buildProjectTree` to use `profile.sourcePatterns` and `profile.ignorePatterns` instead of hardcoded `.ts`/`.md`/`node_modules`/`dist` filters
5. Update `createVerificationHook` to read check commands from the profile instead of hardcoded `pnpm run typecheck/lint/test`

### Step 10: Refactor `@bollard/blueprints` — implement-feature.ts

Update the `implement-feature` blueprint to use profile-driven values:

1. The `create-branch` node stays the same (git is language-independent)
2. The `static-checks` node uses `createStaticCheckNode(workDir, profile)` instead of `createStaticCheckNode(workDir)`
3. The `run-tests` node reads the test command from `profile.checks.test` instead of hardcoding `pnpm run test`
4. The `generate-diff` node stays the same (git is language-independent)
5. Any file extension filters (`.ts`, `.test.ts`) are replaced by `profile.sourcePatterns` and `profile.testPatterns`

The blueprint needs access to the profile. Add it to `PipelineContext`:

```typescript
// In packages/engine/src/context.ts
interface PipelineContext {
  // ... existing fields
  toolchainProfile?: ToolchainProfile   // NEW — set by CLI before blueprint runs
}
```

Update `implement-feature.test.ts`: the existing structure tests should still pass. Verify that node configuration now reads from the profile when present.

### Step 11: Wire it all up and verify

This is the critical step. Everything must work end-to-end:

1. `docker compose build dev` — image builds with the new `@bollard/detect` package
2. `docker compose run --rm dev run typecheck` — zero errors
3. `docker compose run --rm dev run lint` — zero warnings
4. `docker compose run --rm dev run test` — all existing tests pass, plus new detection tests
5. `docker compose run --rm dev --filter @bollard/cli run start -- verify` — static checks pass (same as before, but now profile-driven)
6. `docker compose run --rm dev --filter @bollard/cli run start -- init` — shows TypeScript detection with the new format
7. `docker compose run --rm dev --filter @bollard/cli run start -- config show --sources` — shows the toolchain profile in output

Print the total source LOC and test LOC. Target:
- `@bollard/detect`: ~400 source, ~300 test
- Refactored packages: net ~+100 source (mostly removals + replacements), ~+120 test
- Total project after Stage 1.5: ~2800 source, ~2000 test, ~120 prompt

### Step 12: Verify non-TypeScript detection (manual test)

Create a temporary test directory with Python project markers:

```bash
mkdir /tmp/test-py-detect
cd /tmp/test-py-detect
cat > pyproject.toml << 'EOF'
[project]
name = "test-project"
version = "0.1.0"

[tool.pytest.ini_options]
testpaths = ["tests"]

[tool.ruff]
line-length = 88

[tool.mypy]
strict = true
EOF
touch conftest.py
echo 'poetry.lock placeholder' > poetry.lock
```

Then run `bollard init` against it (from inside the Docker container). It should detect Python, poetry, pytest, ruff, mypy — all without any `.bollard.yml`.

---

### Important reminders

- **Read CLAUDE.md and spec/06-toolchain-profiles.md before starting.** The spec has the full type definitions and design rationale.
- **All existing behavior must be preserved.** The refactor must be invisible to a TypeScript project. Same commands, same output, same test results.
- **Don't build anything from Stage 2+.** No Docker containers, no adversarial test agent, no mutation testing, no type extractors. Stage 1.5 is purely detection and configuration.
- **Keep deps minimal.** No TOML parser (use regex for pyproject.toml section detection). No template engine (use string replacement). No prompt library (use readline for interactive init).
- **Use named exports only.** No default exports. No semicolons.
- **All errors must be `BollardError` instances** with appropriate codes and context. Add `DETECTION_FAILED` and `PROFILE_INVALID` to `BollardErrorCode` if needed.
- **Test each detector against real fixture directories.** The fixtures are minimal (just marker files) but must be sufficient to exercise the detection logic.
- **Commit after each step** with message format: `Stage 1.5: <what>`.
- **Run everything through Docker Compose.** `docker compose run --rm dev run test`, not bare `pnpm run test`.
