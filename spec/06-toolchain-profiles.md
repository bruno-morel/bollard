# Bollard: Language-Agnostic Toolchain Profiles
## Battery-Included Verification for Any Language

*v0.1 — March 2026*

> *"The strongest verification comes from independence — not just who writes the tests, but where they run."*

---

## 1. The Problem

Bollard's verification pipeline — produce, adversarially verify, mechanically prove — is a language-independent idea. But the current implementation hardcodes TypeScript assumptions at every layer: `tsc` for type checking, `biome` for linting, `vitest` for testing, `pnpm` for package management. A Python project, a Go service, or a Rust library can't use Bollard today without rewriting the verification plumbing.

The fix isn't to abstractify every tool call behind an interface. The fix is to recognize that Bollard already has the right abstraction boundary — Docker containers — and that the language-specific parts are just *configuration* hiding behind hardcoded values.

---

## 2. The Three-Layer Verification Model

Before discussing detection, we need to settle what we're detecting *for*. Bollard verification has three layers, each answering a different question:

### Layer 1: Project Tests (Intent Check)

> "Does this change break what the developer already tested?"

Run the project's own test suite, as-is, in the project's own environment. This validates developer intent — regression safety. Bollard just executes whatever the project already has (`pytest`, `go test`, `cargo test`, `vitest`, etc.). If the project has no tests, this layer is skipped and that fact gets flagged in the risk model.

This layer is language-coupled by definition, but that's fine — it's the project's own tooling. Bollard doesn't write or own these tests.

### Layer 2: Adversarial Tests (Independence Check)

> "Does this code do what it *should*, including things the developer didn't think about?"

Separate agents, with different information than the coder, generate tests across three **adversarial scopes** — boundary (function edge cases), contract (cross-module assumptions), and behavioral (system-wide failure modes). Each scope probes four **cross-cutting concerns** (correctness, security, performance, resilience) with weights tuned to the scope's relevance. See [07-adversarial-scopes.md](07-adversarial-scopes.md) for the full scope × concern matrix, agent definitions, and lifecycle.

Each scope can run in one of two integration modes:

**Integrated.** Adversarial tests are written for the project's own test framework and run alongside the developer's tests. This is the default for boundary and contract scopes when the project has a capable test framework.

**Independent.** Tests run in Bollard-controlled containers, separate from the project's test infrastructure. This is the default for behavioral scope (which requires Docker-level fault injection) and the fallback for any scope when the project has no test framework.

The key guarantee: **Bollard runs all enabled scopes regardless of the project's test infrastructure.** A project with zero tests still gets boundary + contract + behavioral adversarial verification — all running in Bollard's own containers.

### Layer 3: Mutation Testing (Meta-Verification)

> "Are both Layer 1 and Layer 2 actually catching bugs, or are they just passing by coincidence?"

Mutate the source, run both test suites, check that mutations get caught. This is the mechanical proof that the tests are meaningful. Language-specific mutators exist for every major language (Stryker for JS/TS/C#, mutmut for Python, cargo-mutants for Rust). *Note: go-mutesting (Go) was originally planned but is deferred — the project is unmaintained. The `MutationToolId` type reserves the slot.*

### Why Three Layers?

| Layer | Catches | Misses |
|-------|---------|--------|
| Project tests alone | Regressions | Blind spots shared with the code author |
| Adversarial tests alone | Independent verification gaps | Developer intent, internal contracts |
| Mutation testing alone | Weak test suites | Nothing — but only if Layers 1+2 exist to test against |

All three together close the loop: intent (L1) + independence (L2) + proof-of-coverage (L3).

---

## 3. Auto-Detection: Battery-Included

Bollard's config philosophy (see [04-configuration.md](04-configuration.md)) is: auto-detect → derive → env var → .bollard.yml. Language and toolchain detection extends this principle. Every detection is a file-existence check or a config-file parse — deterministic, fast, no network calls.

### 3.1 Language Detection

Detected by marker files in the project root (or workspace root for monorepos):

| Marker File(s) | Language | Confidence |
|---------------|----------|------------|
| `tsconfig.json` | TypeScript | High |
| `package.json` (no tsconfig) | JavaScript | High |
| `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt` | Python | High |
| `go.mod` | Go | High |
| `Cargo.toml` | Rust | High |
| `pom.xml`, `build.gradle`, `build.gradle.kts` | Java/Kotlin | High |
| `Gemfile`, `*.gemspec` | Ruby | High |
| `*.csproj`, `*.sln` | C# | High |
| `mix.exs` | Elixir | High |
| `deno.json`, `deno.jsonc` | Deno/TypeScript | High |

Multiple markers can coexist (e.g., a Python project with a TypeScript frontend). Bollard detects all and reports them. For monorepos, detection runs per-package.

### 3.2 Package Manager Detection

| Marker | Package Manager | Run Command |
|--------|----------------|-------------|
| `pnpm-lock.yaml` | pnpm | `pnpm` |
| `yarn.lock` | yarn | `yarn` |
| `package-lock.json` | npm | `npm` |
| `bun.lockb` | bun | `bun` |
| `poetry.lock` | poetry | `poetry run` |
| `Pipfile.lock` | pipenv | `pipenv run` |
| `uv.lock` | uv | `uv run` |
| `requirements.txt` (no lock) | pip | `python -m` |
| `go.sum` | go modules | `go` |
| `Cargo.lock` | cargo | `cargo` |
| `Gemfile.lock` | bundler | `bundle exec` |
| `gradle.lockfile` | gradle | `./gradlew` |

### 3.3 Test Framework Detection

| Marker | Framework | Run Command |
|--------|-----------|-------------|
| `vitest.config.*` | Vitest | `{pkg} run test` or `vitest run` |
| `jest.config.*`, `"jest"` in package.json | Jest | `{pkg} run test` or `jest` |
| `pytest.ini`, `conftest.py`, `[tool.pytest]` in pyproject.toml | pytest | `{pkg_run} pytest -v` |
| `_test.go` files | go test | `go test ./...` |
| `#[test]` in `*.rs` or `[dev-dependencies]` with test crates | cargo test | `cargo test` |
| `*_test.rb`, `spec/` dir, `.rspec` | RSpec | `bundle exec rspec` |
| `*Test.java`, `*Spec.java`, `src/test/` | JUnit/TestNG | `./gradlew test` or `mvn test` |
| `*_test.exs`, `test/` dir | ExUnit | `mix test` |

### 3.4 Linter / Formatter Detection

| Marker | Tool | Check Command | Fix Command |
|--------|------|---------------|-------------|
| `biome.json`, `biome.jsonc` | Biome | `biome check .` | `biome check --fix .` |
| `.eslintrc.*`, `eslint.config.*` | ESLint | `eslint .` | `eslint --fix .` |
| `ruff.toml`, `[tool.ruff]` in pyproject.toml | Ruff | `ruff check .` | `ruff check --fix .` |
| `.golangci.yml` | golangci-lint | `golangci-lint run` | — |
| `clippy` in Cargo (default) | Clippy | `cargo clippy` | `cargo clippy --fix` |
| `.rubocop.yml` | RuboCop | `rubocop` | `rubocop -a` |
| `.credo.exs` | Credo | `mix credo` | — |
| `checkstyle.xml`, `spotless` in gradle | Checkstyle/Spotless | `./gradlew check` | `./gradlew spotlessApply` |

### 3.5 Type Checker / Static Analysis Detection

| Marker | Tool | Command |
|--------|------|---------|
| `tsconfig.json` | tsc | `tsc --noEmit` (or `tsc --build` for project refs) |
| `mypy.ini`, `[tool.mypy]` in pyproject.toml, `.mypy.ini` | mypy | `mypy .` |
| `pyrightconfig.json`, `[tool.pyright]` in pyproject.toml | pyright | `pyright` |
| Go compiler | go vet | `go vet ./...` |
| Rust compiler | rustc | (built into `cargo check`) |
| `ktlint` config | ktlint | `ktlint` |

### 3.6 Dependency Audit Detection

| Ecosystem | Tool | Command |
|-----------|------|---------|
| npm/pnpm/yarn | npm audit | `{pkg} audit --audit-level=high` |
| pip/poetry/uv | pip-audit | `pip-audit` (or `safety check`) |
| go | govulncheck | `govulncheck ./...` |
| cargo | cargo-audit | `cargo audit` |
| bundler | bundler-audit | `bundle audit check` |
| gradle/maven | dependency-check | OWASP plugin |

### 3.7 Mutation Testing Detection

| Ecosystem | Tool | Command |
|-----------|------|---------|
| JS/TS | Stryker | `stryker run --mutate '{changed_files}'` |
| Python | mutmut | `mutmut run --paths-to-mutate={changed_files}` |
| Go | go-mutesting *(deferred — unmaintained)* | `go-mutesting ./...` |
| Rust | cargo-mutants | `cargo mutants --file {changed_files}` |
| Ruby | mutant | `bundle exec mutant run` |

### 3.8 What `bollard init` Looks Like — Multi-Language

```bash
$ cd my-python-project
$ bollard init

Detected:
  Language:         Python 3.12
  Package manager:  poetry (poetry.lock found)
  Test framework:   pytest (conftest.py + pyproject.toml)
  Linter:           Ruff ([tool.ruff] in pyproject.toml)
  Type checker:     mypy ([tool.mypy] in pyproject.toml)
  Dep audit:        pip-audit (will install if missing)
  Secret scan:      gitleaks
  Docker:           yes (Dockerfile found)
  CI:               GitHub Actions (.github/workflows/)
  Mutation testing:  mutmut (not installed — will use at Stage 3)

Verification layers:
  Layer 1 (project tests):     poetry run pytest -v
  Layer 2 (adversarial tests): bollard/verify container (black-box mode)
  Layer 3 (mutation testing):  mutmut (when enabled)

Ready. Run: bollard run --task "your task here"
```

No `.bollard.yml` generated. If all tools are detected, there's nothing to write.

---

## 4. Interactive Init for New / Underspecified Repos

When auto-detection leaves gaps — new repos with no test framework, repos missing a linter, greenfield projects — `bollard init` switches to interactive mode for the missing pieces.

```bash
$ cd empty-project
$ bollard init

Detected:
  Language:         (none — no marker files found)
  Package manager:  (none)
  ...

? What language is this project? (auto-detect found nothing)
  > Python
    TypeScript
    Go
    Rust
    Java
    Other (specify)

? Python test framework?
  > pytest (recommended)
    unittest
    none (Bollard will generate standalone tests)

? Python linter?
  > ruff (recommended)
    flake8
    pylint
    none

? Type checker?
  > mypy (recommended)
    pyright
    none (Bollard will warn: "type checking is a free verification layer")
```

For each gap, Bollard suggests the most popular/reliable option. The user can accept the recommendation, pick an alternative, or skip. Skipped layers get flagged in the risk model — no verification layer is silently omitted.

The choices are stored in `.bollard.yml` only when they can't be inferred from project files. Once the user actually installs the tool and creates its config file, the `.bollard.yml` entry becomes redundant and can be removed.

---

## 5. The Toolchain Profile — Internal Representation

Auto-detection produces a `ToolchainProfile` — the internal representation of everything Bollard knows about the project's tooling. This is not a config file the user writes; it's computed on every run.

```typescript
interface ToolchainProfile {
  language: LanguageId
  packageManager?: PackageManagerId

  // Verification capabilities — each maps to a concrete command
  checks: {
    typecheck?: VerificationCommand
    lint?: VerificationCommand
    test?: VerificationCommand
    audit?: VerificationCommand
    secretScan?: VerificationCommand     // always gitleaks, language-independent
  }

  // Mutation testing (Layer 3)
  mutation?: {
    tool: MutationToolId
    command: string
    changedFilesPlaceholder: string        // e.g., "{changed_files}"
  }

  // File patterns for agent context
  sourcePatterns: string[]                  // e.g., ["**/*.py", "!**/__pycache__/**"]
  testPatterns: string[]                    // e.g., ["**/test_*.py", "**/*_test.py"]
  ignorePatterns: string[]                  // e.g., ["node_modules", "__pycache__", ".venv"]

  // Commands the coder agent is allowed to run
  allowedCommands: string[]                 // e.g., ["python", "pip", "pytest", "mypy", "ruff", "git"]

  // Adversarial test configuration (Layer 2)
  // Per-scope configuration — see 07-adversarial-scopes.md for the full model.
  // Each scope has its own integration mode, lifecycle, and concern weights.
  adversarial: AdversarialConfig            // see 07-adversarial-scopes.md Section 9
}

interface VerificationCommand {
  label: string                             // human-readable: "typecheck", "lint"
  cmd: string                               // executable: "mypy", "ruff"
  args: string[]                            // arguments: ["check", "."]
  source: ConfigSource                      // "auto-detected", "file:.bollard.yml", etc.
}

// Supported language identifiers
type LanguageId =
  | "typescript" | "javascript" | "python" | "go" | "rust"
  | "java" | "kotlin" | "ruby" | "csharp" | "elixir" | "unknown"

type PackageManagerId =
  | "pnpm" | "npm" | "yarn" | "bun"
  | "poetry" | "pipenv" | "uv" | "pip"
  | "go" | "cargo" | "bundler" | "gradle" | "maven"

type MutationToolId = "stryker" | "mutmut" | "go-mutesting" | "cargo-mutants" | "mutant"
```

### How It's Built

```
1. detectLanguage(cwd)         → LanguageId (or prompt if ambiguous)
2. detectPackageManager(cwd)   → PackageManagerId
3. detectTestFramework(cwd)    → VerificationCommand | null
4. detectLinter(cwd)           → VerificationCommand | null
5. detectTypeChecker(cwd)      → VerificationCommand | null
6. detectAuditTool(cwd)        → VerificationCommand | null
7. detectMutationTool(cwd)     → MutationTool | null
8. deriveSourcePatterns(lang)  → string[]
9. deriveTestPatterns(lang, testFramework) → string[]
10. deriveAllowedCommands(lang, pkgMgr, tools) → string[]
11. apply .bollard.yml overrides
12. apply CLI flag overrides
```

Each step is a pure function: file checks in, values out. No side effects, no network. The full detection runs in <100ms on any project.

---

## 6. Docker Architecture — Where Each Layer Runs

The key architectural insight: Bollard's engine is always TypeScript in a Node.js container. That's an implementation detail, not a user-facing constraint. The user's project runs in whatever container it needs.

### Local Development (Docker Compose)

```yaml
services:
  # Bollard engine — always Node.js, always present
  bollard:
    build: .
    volumes:
      - ./:/workspace:ro        # read-only view of project
      - bollard-data:/data      # run artifacts, plans, diffs
    environment:
      - ANTHROPIC_API_KEY

  # Layer 1: Project tests — uses the project's own environment
  project-verify:
    image: ${TOOLCHAIN_IMAGE}   # e.g., python:3.12, golang:1.22, rust:1.77
    volumes:
      - ./:/workspace
    # Command injected from ToolchainProfile
    # e.g., command: ["poetry", "run", "pytest", "-v"]

  # Layer 2: Adversarial tests — Bollard's own container
  adversarial-verify:
    image: bollard/verify:latest   # Node.js + fast-check + HTTP clients
    volumes:
      - ./:/workspace:ro
      - bollard-data:/data
    depends_on: [project-verify]   # project must be running for black-box tests

  # Layer 3: Mutation testing — language-specific
  mutation-verify:
    image: ${TOOLCHAIN_IMAGE}
    volumes:
      - ./:/workspace
    # Command from ToolchainProfile.mutation
```

### CI/CD (Single Dockerfile, Multi-Stage)

For CI pipelines, a single image is simpler than Compose. Bollard provides multi-stage Dockerfiles per language:

```dockerfile
# Base: Bollard engine (shared across all languages)
FROM node:22-slim AS bollard-base
WORKDIR /bollard
COPY packages/ packages/
RUN corepack enable && pnpm install --frozen-lockfile

# Python target
FROM bollard-base AS verify-python
RUN apt-get update && apt-get install -y python3 python3-pip python3-venv
# Install project-specific tools based on detected profile
ARG PIP_PACKAGES="pytest mypy ruff pip-audit mutmut"
RUN pip install --break-system-packages ${PIP_PACKAGES}

# Go target
FROM bollard-base AS verify-go
COPY --from=golang:1.22 /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}"
RUN go install golang.org/x/vuln/cmd/govulncheck@latest

# Rust target
FROM bollard-base AS verify-rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"
RUN cargo install cargo-audit cargo-mutants
```

CI picks the right target:

```yaml
# GitHub Actions example
- run: docker build --target verify-python -t bollard-verify .
- run: docker run bollard-verify bollard run implement-feature --task "$TASK"
```

### The `bollard/verify` Image (Layer 2)

This is Bollard's own adversarial test environment. It ships with:

- Node.js 22 + TypeScript (Bollard's native runtime)
- fast-check (property-based testing)
- Standard HTTP clients (for testing APIs)
- CLI test harness (for testing command-line tools)
- gRPC/protobuf clients (for testing RPC services)
- Database clients (postgres, mysql, redis) for integration testing

It does NOT ship with Python, Go, Rust, etc. It tests from the outside, through public interfaces. This is what makes it language-independent — it doesn't need the project's language to verify the project's behavior.

---

## 7. Agent Prompt Injection

Agent prompts today hardcode references to TypeScript, Vitest, Biome. With toolchain profiles, these become template variables injected at agent creation time.

### Before (Hardcoded)

```markdown
# Planner System Prompt
You are working in a TypeScript monorepo managed with pnpm workspaces.
Verification: tsc, biome, pnpm audit.
Tests: Vitest.
```

### After (Templated)

```markdown
# Planner System Prompt
You are working in a {{language}} project managed with {{packageManager}}.
Verification: {{typecheck.label}}, {{lint.label}}, {{audit.label}}.
Tests: {{testFramework.label}}.

Available commands: {{allowedCommands | join(", ")}}.
Source files match: {{sourcePatterns | join(", ")}}.
Test files match: {{testPatterns | join(", ")}}.
```

The template is filled from the `ToolchainProfile` at agent creation time. The agents don't know they're templated — they just see a concrete prompt describing the project's actual tooling.

This also means the prompts auto-adapt to whatever the detection finds. A project using ESLint instead of Biome gets a prompt that says "ESLint" — no config needed, no prompt editing.

---

## 8. `.bollard.yml` Extensions

The existing `.bollard.yml` schema gains an optional `toolchain` section for overrides. Most projects won't need it — auto-detection covers the common case.

```yaml
# .bollard.yml — toolchain overrides (only what auto-detection gets wrong)

toolchain:
  # Override detected language (rare — useful for polyglot repos)
  language: python

  # Override specific verification commands
  checks:
    typecheck:
      cmd: pyright          # detected mypy, but we use pyright
      args: ["--project", "."]
    lint:
      cmd: ruff
      args: ["check", ".", "--config", "ruff-strict.toml"]
    test:
      cmd: poetry
      args: ["run", "pytest", "-v", "--tb=short"]

  # Override adversarial test mode
  adversarial:
    mode: both              # run black-box AND in-language adversarial tests
    runtime_image: python:3.12-slim

  # Extra allowed commands for the coder agent
  extra_commands: ["make", "docker"]

  # Custom source/test patterns (overrides derived defaults)
  source_patterns: ["src/**/*.py"]
  test_patterns: ["tests/**/test_*.py"]
```

The schema validates with Zod, like the rest of `.bollard.yml`. Unknown keys are rejected (`strict()`).

---

## 9. Changes to Existing Packages

### `@bollard/cli` — config.ts

The `autoDetect` function expands from 4 checks to the full detection matrix (Section 3). Returns a `ToolchainProfile` instead of a flat `Record<string, boolean>`.

The `bollard init` command gains interactive mode (Section 4) for filling detection gaps.

### `@bollard/verify` — static.ts

`runStaticChecks` currently hardcodes three commands. It becomes:

```typescript
function runStaticChecks(
  workDir: string,
  profile: ToolchainProfile
): Promise<StaticCheckResults> {
  const checks: VerificationCommand[] = [
    profile.checks.typecheck,
    profile.checks.lint,
    profile.checks.audit,
    profile.checks.secretScan,  // always gitleaks
  ].filter(Boolean)

  // Run sequentially, same as before — just from profile instead of hardcoded
}
```

### `@bollard/verify` — dynamic.ts

Test execution reads from `profile.checks.test` instead of hardcoding `pnpm exec vitest run`. Output parsing becomes generic: exit code 0 = pass, non-zero = fail. Framework-specific output parsing (test count, names) is optional and per-framework.

### `@bollard/agents` — tools/run-command.ts

`DEFAULT_ALLOWED_COMMANDS` is replaced by `profile.allowedCommands`. The whitelist is still enforced — it's just derived from detection instead of hardcoded.

### `@bollard/agents` — prompts/

Planner and coder prompts become Mustache-style templates (or simple string interpolation — no new dependency needed). Variables are filled from `ToolchainProfile`.

### `@bollard/blueprints` — implement-feature.ts

File extension filters (`.ts`, `.test.ts`) are replaced by `profile.sourcePatterns` and `profile.testPatterns`. The blueprint nodes read these from context.

### `@bollard/verify` — type-extractor.ts

This is the hardest piece. The TypeScript AST dependency is genuinely language-specific. Options:

1. **Make it a pluggable interface.** `TypeExtractor` becomes a function `(files: string[]) => SignatureMap`. The TS implementation stays, others are added per-language. Go has `go doc`, Python has `ast` module + `inspect`, Rust has `cargo doc --document-private-items`.

2. **Defer non-TS extractors.** Ship the interface, ship the TS implementation, document how to add others. The adversarial test agent in black-box mode doesn't need type extraction at all — it tests through public interfaces.

Option 2 is the pragmatic choice for now. The interface exists, TS works, others come as needed.

---

## 10. Staging

This work spans multiple stages to avoid a big-bang rewrite:

See [02-bootstrap.md](02-bootstrap.md) for the full stage-by-stage breakdown. Summary of language-agnosticism work per stage:

### Stage 1.5: Toolchain Detection + Profile

- New `@bollard/detect` package: `detectToolchain(cwd) → ToolchainProfile`
- Per-language detection modules: TypeScript, Python, Go, Rust (+ fallback for unknown)
- Refactor `@bollard/verify` to read commands from profile instead of hardcoded values
- Refactor `@bollard/agents` run-command whitelist to use `profile.allowedCommands`
- Templatize agent prompts (planner, coder) with profile variables
- Interactive `bollard init` for filling detection gaps
- All existing TS behavior preserved — just routed through the profile abstraction
- Test fixtures for each supported language to validate detection

### Stage 2: Adversarial Test Isolation (Language-Agnostic)

- `bollard/verify` Docker image for black-box adversarial tests (Bollard's own TypeScript runtime)
- Per-language Docker images for in-language adversarial test execution
- `SignatureExtractor` interface + TS implementation + LLM fallback for other languages
- Layer 2a (black-box) works for any project with HTTP/CLI/gRPC interfaces
- Layer 2b (in-language) generates tests in the project's own framework (pytest, go test, cargo test, etc.)
- Persistent-native mode: adversarial tests integrated with the project's test runner
- Docker Compose orchestration for local dev; multi-stage Dockerfiles for CI

### Stage 3: Full Three-Layer Pipeline

- Per-language mutation testing: Stryker (JS/TS), mutmut (Python), cargo-mutants (Rust). *Go mutation deferred (go-mutesting unmaintained).*
- Mutation testing runs against both Layer 1 and Layer 2 test suites
- Deterministic type extractors for Python (`ast`), Go (`go doc`), Rust (`cargo doc`)
- Mutation tool detection added to `@bollard/detect` language modules

---

## 11. The "Just Works" Matrix — Extended

| Project | What You Run | What Happens |
|---------|-------------|-------------|
| TS + Vitest + Biome | `bollard init` | Detects everything. Same behavior as today. |
| Python + pytest + ruff + mypy | `bollard init` | Detects all four. Layer 1: `pytest`. Adversarial: black-box. |
| Go module | `bollard init` | Detects go, go test, go vet, govulncheck. |
| Rust + cargo | `bollard init` | Detects cargo test, clippy, cargo-audit. |
| Empty directory | `bollard init` | Interactive: asks language, suggests tools. |
| Python with no tests | `bollard init` | Detects Python, warns no tests. Layer 1 skipped, Layer 2 still runs. Risk score elevated. |
| Polyglot (TS frontend + Python backend) | `bollard init` | Detects both. Per-package profiles in monorepo. |
| Unknown language | `bollard init` | Asks. User specifies. Commands go in `.bollard.yml`. |

None of these require editing `.bollard.yml` unless auto-detection gets something wrong.

---

## 12. Design Principles (Extending the Existing Set)

7. **The engine doesn't know about languages.** Language-specific logic lives in `ToolchainProfile` and the detection functions. The runner, agents, and blueprints consume the profile — they never check `if language === "python"`.

8. **Independence requires isolation.** Adversarial tests running in the same process as the code they test share failure modes. Docker is the isolation boundary. Layer 2 always runs in a separate container.

9. **Detection is deterministic.** No network calls, no LLM calls, no heuristics. File exists → tool detected. Config key present → feature enabled. Always reproducible.

10. **Missing layers are visible, not silent.** If a project has no linter, Bollard warns and records it in the risk model. It doesn't quietly skip the check. The user always knows what verification is running and what isn't.

---

## 13. Generated Test Location and Lifecycle

Bollard produces tests at multiple layers and scopes. Each has a different lifecycle, a different home, and a different relationship to the project's own test infrastructure. With the multi-scope adversarial model (see [07-adversarial-scopes.md](07-adversarial-scopes.md)), test artifacts are organized by scope (boundary, contract, behavioral), each with its own integration mode and lifecycle (ephemeral, persistent, or promoted).

### Layer 1: Project Tests — Not Bollard's Business

These are the developer's tests. They live wherever the project puts them (`tests/`, `src/__tests__/`, `*_test.go`, etc.). Bollard runs them, never writes them, never moves them.

### Layer 2a: Black-Box Adversarial Tests — Always Ephemeral

Black-box tests live only inside the `bollard/verify` container. They're generated fresh each run, executed against the project's public interfaces (HTTP, CLI, gRPC), and discarded after results are collected. They're never written to the project directory.

The test source is captured in the run artifacts for auditability:

```
.bollard/runs/{run-id}/
  adversarial-blackbox/
    tests/                    # generated test source (for audit trail)
    results.json              # pass/fail/count/duration
```

There's no persist option for black-box tests — they run in Bollard's own TypeScript runtime and have no relationship to the project's test toolchain.

### Layer 2b: In-Language Adversarial Tests — Ephemeral or Persistent

In-language adversarial tests are written in the project's own language and test framework. The developer chooses one of two strategies during `bollard init`:

#### Ephemeral Mode (Default)

Tests are generated fresh each run, executed in an isolated container, and discarded. Results are captured in run artifacts. The test source is preserved for audit but not integrated with the project.

```
.bollard/runs/{run-id}/
  adversarial-native/
    test_auth_edge_cases.py   # generated, executed, kept for audit
    results.json
```

This is the simplest model. No files accumulate, no maintenance burden. Each run produces adversarial tests against the current state of the code. The developer sees pass/fail results but doesn't manage test files.

#### Persistent-Native Mode (Opt-In)

Tests are generated in the project's language and framework, and **reintegrated with the project's test toolchain**. They live in `.bollard/tests/` but are written so the project's own test runner can execute them. Each feature/blueprint run replaces the previous tests for that feature — you always have the latest set, never accumulate stale tests.

```
.bollard/
  tests/
    {feature-slug}/
      test_auth_edge_cases.py       # pytest-compatible, runnable by project's pytest
      test_payment_invariants.py
      _bollard.json                 # metadata: blueprint ID, run ID, timestamp, feature
```

Reintegration means the project's test runner can discover and execute these tests alongside the project's own tests. Bollard configures this automatically:

| Framework | How Bollard Integrates |
|-----------|----------------------|
| pytest | Adds `testpaths = [".bollard/tests"]` to pyproject.toml (or passes `--rootdir`) |
| vitest | Adds `.bollard/tests/**/*.test.ts` to vitest include config |
| go test | Tests are placed as `*_test.go` files in a `bollard_test` package importable from the project |
| cargo test | Adds integration test files under `.bollard/tests/` (Rust convention for integration tests) |
| jest | Adds `.bollard/tests` to Jest's `roots` config |
| RSpec | Adds `.bollard/tests` to `.rspec` paths |

The developer's own tests and Bollard's adversarial tests run in the same `pytest -v` / `go test ./...` / `cargo test` invocation. One test runner, one report, one CI step. No second runtime to maintain.

**Why reintegrate instead of running in a separate container?** Because persistent tests that the developer commits and sees in PRs should be first-class citizens of the project's test infrastructure. If they require a separate container and runtime to execute, they become a maintenance burden that eventually gets ignored. Reintegration means `pytest -v` runs everything — the developer's tests AND the adversarial tests — with no extra ceremony.

**Fallback: persistent-isolated.** For languages where the adversarial agent can't reliably produce idiomatic, framework-compatible tests, Bollard falls back to persistent-isolated mode: tests are kept in `.bollard/tests/` but written in Bollard's native TypeScript and run in Bollard's container. This is strictly worse than persistent-native (two runtimes, extra complexity) but still better than ephemeral (you get regression coverage across runs). Bollard reports when it falls back and why.

**How Bollard picks the mode:** In persistent mode, Bollard always attempts persistent-native first. It generates tests in the project's language/framework, validates that they parse and run under the project's test runner, and commits them. If they fail to parse or run (syntax errors, framework incompatibilities), Bollard falls back to persistent-isolated and logs a warning. The developer doesn't configure this — Bollard tries the best option and reports what it achieved.

### The `bollard init` Choice

```
? Adversarial test lifecycle:
  > Ephemeral (recommended — generated fresh each run, results kept, tests discarded)
    Persistent (tests kept per feature, integrated with your test runner, visible in PRs)
```

One choice. One boolean in `.bollard.yml`: `adversarial.persist: true | false`. Everything else — language selection, framework integration, fallback behavior — is derived from the `ToolchainProfile`.

### Test Promotion: From Adversarial to Project-Owned

In either mode, if an adversarial test catches a real bug, the developer may want to adopt it permanently. Bollard supports this with a `promote` command:

```bash
$ bollard promote-test .bollard/runs/abc123/adversarial-native/test_auth_edge_cases.py

Promoting: test_auth_edge_cases.py
  → Copying to: tests/test_auth_edge_cases.py
  → Stripping Bollard metadata comments
  → Verifying it runs under project test runner

Promoted. This test is now yours — Bollard will run it as a Layer 1 test.
```

In ephemeral mode, `promote-test` pulls from run artifacts. In persistent mode, it pulls from `.bollard/tests/`. Either way, the promoted test moves into the project's test directory, becomes a Layer 1 test, and the adversarial agent is informed (via plan context) that this coverage exists — so it focuses on finding new gaps.

### Feature/Blueprint Attachment

Every adversarial test set is attached to the blueprint run that produced it. In persistent mode, this is the directory name (`.bollard/tests/{feature-slug}/`). In ephemeral mode, it's the run artifact path. The metadata file (`_bollard.json`) records:

```json
{
  "blueprintId": "implement-feature",
  "runId": "20260329-feat-auth-retry",
  "task": "Add retry logic to auth service",
  "featureSlug": "auth-retry",
  "generatedAt": "2026-03-29T14:30:00Z",
  "agentModel": "claude-sonnet-4-20250514",
  "testFramework": "pytest",
  "testCount": 7,
  "replaces": "20260328-feat-auth-retry"
}
```

The `replaces` field creates a chain: you can see the history of adversarial tests for a feature across runs, even though only the latest set is kept on disk.

### `.gitignore` Recommendations

```gitignore
# .bollard/ — Bollard artifacts
.bollard/runs/          # always gitignore — ephemeral run artifacts

# Persistent adversarial tests: commit for audit trail, or gitignore for fresh-each-run
# .bollard/tests/       # uncomment to gitignore (not recommended in persistent mode)
```

---

## 14. Changes Required in Existing Specs

This spec introduces new concepts that require updates to the existing spec documents:

### 01-architecture.md

- Section on verification layers needs the three-layer model (currently assumes single-layer static + dynamic).
- The `@bollard/verify` package description needs the `ToolchainProfile` dependency.
- The file tree needs `.bollard/tests/adversarial/` added to the convention directory structure.
- Tool stack table needs a "per-language" column showing this isn't TypeScript-only.

### 02-bootstrap.md

- Stage 2 description (adversarial test agent) needs the two sub-modes (black-box vs. in-language) and container isolation.
- Stage 3 description (mutation testing) needs per-language mutator tools instead of "Stryker" only.
- The "What Could Go Wrong" section's note about trivial adversarial tests should mention that black-box mode partially mitigates this (tests against real interfaces are harder to make trivial).
- Stage 1.5 should be mentioned between Stage 1 and Stage 2 for toolchain detection.

### 04-configuration.md

- Section 2 (What Gets Auto-Detected) needs the full detection matrix from this spec (currently TypeScript-only).
- Section 3 (What Gets Derived) verification layers table needs language-agnostic descriptions instead of "TypeScript strict", "Biome", etc.
- The "Just Works" matrix (Section 8) needs non-TypeScript rows.
- The `bollard init` example output needs a multi-language variant.

### 05-risk-model.md

- Missing verification layers (no linter, no type checker, no tests) should be explicit risk dimensions.
- The risk scoring should account for Layer 2 mode (black-box only vs. black-box + in-language).

---

*Bollard: detect the toolchain, verify in isolation, prove the verification works. Language is configuration, not architecture.*
