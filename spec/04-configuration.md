# Bollard: Configuration
## The Best Config Is the One That Doesn't Exist

*v0.1 — March 2026*

> *"The best configuration is the one you never write."*

---

## 1. The Principle: Auto-Detect, Derive, Then Ask

Most frameworks get this backwards. They ship a config file with 100 lines and say "just edit what you need." That's backwards — every line of config is a decision the user has to understand, and a maintenance burden that drifts over time.

Bollard's approach:

| Priority | Source | Examples |
|----------|--------|---------|
| **1. Auto-detect** | Bollard inspects your project and environment | tsconfig.json → TS checks on. biome.json → lint on. Docker → container isolation. `.github/` → GitHub Actions provider |
| **2. Derive** | Bollard computes the right value from what it already knows | Risk tier → probe frequency. Risk tier → remediation gating. |
| **3. Env vars** | User sets a single environment variable | `ANTHROPIC_API_KEY`, `BOLLARD_PROVIDER`, `BOLLARD_MODEL` |
| **4. `.bollard.yml`** | User explicitly overrides a default — last resort | Sensitive paths, environment URLs, per-agent model overrides |

Most projects need zero lines of `.bollard.yml`. The ones that do need it write 5-15 lines, not 100.

---

## 2. What Gets Auto-Detected

`bollard init` inspects the project once. After that, Bollard re-detects on every run (project state can change).

| What | How It's Detected | Fallback |
|------|-------------------|----------|
| **Language** | `tsconfig.json` → TypeScript. `pyproject.toml`/`setup.py` → Python. `go.mod` → Go. `Cargo.toml` → Rust. `package.json` (no tsconfig) → JS. See [06-toolchain-profiles.md](06-toolchain-profiles.md) Section 3.1 for the full matrix. | Interactive prompt during `bollard init` |
| **Test runner** | `vitest.config.*` → Vitest. `jest.config.*` → Jest. `conftest.py` → pytest. `_test.go` → go test. `Cargo.toml` → cargo test. See [06-toolchain-profiles.md](06-toolchain-profiles.md) Section 3.3. | Warns. Adversarial test agent (Layer 2) still generates tests, but Layer 1 is skipped. |
| **Linter** | `biome.json` → Biome. `.eslintrc.*` → ESLint. `ruff.toml` / `[tool.ruff]` → Ruff. `.golangci.yml` → golangci-lint. Clippy (default for Rust). | Warns. Suggests appropriate linter for detected language. |
| **Type checker** | `tsconfig.json` → tsc. `mypy.ini` / `[tool.mypy]` → mypy. Go/Rust compilers have built-in type checking. | Warns: "type checking is a free verification layer" |
| **Package manager** | `pnpm-lock.yaml` → pnpm. `yarn.lock` → yarn. `package-lock.json` → npm. `poetry.lock` → poetry. `uv.lock` → uv. `go.sum` → go modules. `Cargo.lock` → cargo. | Inferred from language |
| **Docker** | `docker --version` succeeds | In-process mode (less isolation, same verification) |
| **Provider** | `.github/workflows/` → `github-actions`. Docker only → `local`. | `local` |
| **Monorepo** | `pnpm-workspace.yaml`, `lerna.json`, Go workspace `go.work`, Cargo workspace `[workspace]` | Single-package mode |
| **LLM** | `$ANTHROPIC_API_KEY` → Anthropic. `$OPENAI_API_KEY` → OpenAI. | Error: no LLM configured |

Every detection result is printed during `bollard init` and at the start of every run (in debug mode). No magic — you can always see what Bollard detected and why.

### What `bollard init` Looks Like

```bash
$ cd my-typescript-project
$ npx bollard init

✓ Language:         TypeScript (strict mode ON)
✓ Test framework:   Vitest
✓ Linter:           Biome
✓ Package manager:  pnpm
✓ Docker:           yes (agent isolation: container)
✓ CI:               GitHub Actions detected → provider: github-actions
✓ LLM:              ANTHROPIC_API_KEY set

Ready. Run: npx bollard run --task "your task here"
```

```bash
$ cd my-python-api
$ npx bollard init

✓ Language:         Python 3.12
✓ Test framework:   pytest (conftest.py + pyproject.toml)
✓ Linter:           Ruff ([tool.ruff] in pyproject.toml)
✓ Type checker:     mypy ([tool.mypy] in pyproject.toml)
✓ Package manager:  poetry (poetry.lock found)
✓ Docker:           yes (Dockerfile found)
✓ CI:               GitHub Actions detected → provider: github-actions
✓ LLM:              ANTHROPIC_API_KEY set

Ready. Run: npx bollard run --task "your task here"
```

No config file generated. If auto-detection covers your project, there's nothing to write. See [06-toolchain-profiles.md](06-toolchain-profiles.md) for the full detection matrix and interactive init for undetected tools.

---

## 3. What Gets Derived (Not Configured)

These values exist in the codebase as hardcoded defaults, derived from the risk model or from other detected state. They're not exposed as config because they shouldn't need to change — and if they do, the right fix is usually to adjust the risk model, not to tune a knob.

### Verification Layers

Every layer is enabled by default if the tooling exists. There's no `verification.static.typescript: true` in a config file — if a type checker is detected, type checks run. Period. All verification commands are read from the `ToolchainProfile` (see [06-toolchain-profiles.md](06-toolchain-profiles.md)) — the engine never checks `if language === "python"`.

| Layer | Enabled when... | Disabled when... |
|-------|-----------------|-----------------|
| Type checking | Type checker detected (tsc, mypy, pyright, go vet, rustc) | No type checker — Bollard warns: "type checking is a free verification layer" |
| Linting | Linter detected (Biome, ESLint, Ruff, golangci-lint, Clippy, etc.) | No linter detected (Bollard warns) |
| Secret scanning | Always (gitleaks is zero-config) | Never — this is a safety net, not optional |
| Dependency audit | Always (pnpm audit, pip-audit, govulncheck, cargo-audit, etc.) | Never |
| Test execution (Layer 1) | Test runner detected | No test runner (Bollard warns, risk score elevated) |
| Adversarial tests — boundary scope | Stage 2+ | Pre-Stage 2 |
| Adversarial tests — contract scope | Stage 3+ | Pre-Stage 3 |
| Adversarial tests — behavioral scope | Stage 4+ | Pre-Stage 4 |
| Mutation testing (Layer 3) | Test runner detected + Stage 3 | No tests to run against |
| Contract testing | `pact.config.*` exists | No Pact setup |

Each adversarial scope probes four cross-cutting concerns (correctness, security, performance, resilience) with weighted attention per scope. See [07-adversarial-scopes.md](07-adversarial-scopes.md) for the full scope × concern matrix, agent definitions, integration modes, and lifecycle options.

### Risk Thresholds

Hardcoded defaults that work for most projects:

```typescript
const DEFAULT_RISK_THRESHOLDS = {
  lowMax: 5,       // scores 0-5: auto-merge, daily digest
  mediumMax: 14,   // scores 6-14: auto-merge, immediate notification
  highMax: 24,     // scores 15-24: human approval required
  // 25+: critical — requires multiple reviewers
} as const;
```

Override in `.bollard.yml` only if you have evidence from run history that these boundaries don't fit your project.

### Agent Guardrails

Hardcoded defaults:

```typescript
const DEFAULT_AGENT_GUARDRAILS = {
  maxCostUsd: 50,
  maxDurationMinutes: 30,
  retriesOnTestFailure: 1,
  retriesOnReviewBlock: 1,
  retriesOnLlmTimeout: 3,
} as const;
```

Override via env vars: `BOLLARD_MAX_COST=100`, `BOLLARD_MAX_DURATION=60`. Or in `.bollard.yml` if you want it committed to the repo.

### Probe Scheduling

Default: every 5 minutes for all risk tiers. Overridable per-probe in the probe definition file. Not a global config knob.

---

## 4. Environment Variables

For things that vary by environment or contain secrets, env vars are the right primitive — not config files.

| Variable | Purpose | Required? |
|----------|---------|-----------|
| `ANTHROPIC_API_KEY` | LLM provider auth (Anthropic) | Yes (one LLM key required) |
| `OPENAI_API_KEY` | LLM provider auth (OpenAI) | Alternative to Anthropic |
| `PRODUCTION_URL` | Base URL for production probes | For observability (Stage 3+) |
| `STAGING_URL` | Base URL for staging probes | For probe dry-runs |
| `BOLLARD_PROVIDER` | Override auto-detected provider | No — auto-detected |
| `BOLLARD_MODEL` | Override default LLM model | No — defaults to `claude-sonnet-4-20250514` |
| `BOLLARD_MAX_COST` | Override max cost per run (USD) | No — defaults to 50 |
| `BOLLARD_MAX_DURATION` | Override max duration (minutes) | No — defaults to 30 |

That's it. No `BOLLARD_MUTATION_THRESHOLD`, no `BOLLARD_SLO_LOW_AVAILABILITY`, no `BOLLARD_ROLLOUT_STEPS`. Those are derived, not configured.

---

## 5. The `.bollard.yml` — For What's Left

After auto-detection, derivation, and env vars, what's left? Only things that are project-specific, can't be detected, and need to be committed to the repo.

### Minimal `.bollard.yml` (Most Projects)

```yaml
# .bollard.yml — only what Bollard can't auto-detect or derive
# Most projects need nothing here. Add sections only when you need to override.

risk:
  sensitive_paths:
    critical: ["src/auth/**", "src/payments/**", "migrations/**"]
    high: ["src/api/public/**", "src/models/**"]
```

That's it. 5 lines. Everything else is auto-detected or derived.

### Extended `.bollard.yml` (Teams With Specific Needs)

```yaml
# .bollard.yml — extended example for teams with specific overrides

# Override risk thresholds (only if default 0-5-14-24 boundaries don't fit)
risk:
  thresholds:
    low_max: 8                   # your project has higher tolerance for low-risk changes
  sensitive_paths:
    critical: ["src/auth/**", "src/payments/**", "migrations/**"]
    high: ["src/api/public/**", "src/models/**"]

# Per-agent LLM overrides (only if you want to mix models for cost)
llm:
  agents:
    planner:
      provider: openai
      model: gpt-4o-mini          # cheaper for planning
    coder:
      provider: anthropic
      model: claude-sonnet-4-20250514

# Adversarial scope overrides (see 07-adversarial-scopes.md)
# Most projects use auto-detected defaults — add only what you need to override.
adversarial:
  concerns:                       # global concern weight overrides
    performance: low              # this is a CLI tool, perf is less critical
  boundary:
    lifecycle: persistent         # keep boundary tests across runs
  behavioral:
    concerns:
      security: off               # pure library, no attack surface
```

Still short. And most of this is optional — you only add sections when the defaults don't work.

### What Does NOT Belong in `.bollard.yml`

| Previously in config | Now | Why |
|---------------------|-----|-----|
| `provider.name: local` | Auto-detected from environment | Docker → local. `.github/` → github-actions. |
| `llm.default.provider/model` | Env var (`ANTHROPIC_API_KEY`) + hardcoded default model | The common case needs zero config. Power users set `BOLLARD_MODEL`. |
| `verification.static.*` | Auto-detected from project files | tsconfig → TS on. biome.json → lint on. No config needed. |
| `verification.dynamic.*` | Auto-detected from project files | vitest.config → tests on. No config needed. |
| `agent.max_cost_usd` | Hardcoded default, env var override | `BOLLARD_MAX_COST=100` is clearer than editing a YAML file. |
| `observability.probe_dir` | Convention: `.bollard/probes/` | Convention over configuration. |
| `observability.flag_dir` | Convention: `.bollard/flags/` | Convention over configuration. |

---

## 6. Convention Over Configuration — The `.bollard/` Directory

Instead of configuring paths in YAML, Bollard uses a fixed directory structure:

```
.bollard/
├── probes/                    # Probe definitions (committed, versioned)
│   ├── auth-login.probe.ts
│   └── health-check.probe.ts
├── flags/                     # Flag state (committed, versioned)
│   └── flags.json             # {flagId: {enabled, percent}} — written by flag manager
└── runs/                      # Run artifacts (gitignored)
    └── 20260326-feat-auth/
        ├── plan.json
        ├── results.json
        └── pr-body.md
```

No config for probe directory. No config for flag directory. No config for artifact storage path. Convention.

---

## 7. Provider Auto-Detection

| Detected | Provider | How |
|----------|----------|-----|
| `.github/workflows/` | `github-actions` | Directory exists |
| Docker only | `local` | No CI files + Docker available |
| Nothing | `local` (in-process) | No Docker, no CI files |

Override: `BOLLARD_PROVIDER=gcp` or add `provider: gcp` to `.bollard.yml`.

`local` ships at Stage 0, `github-actions` at Stage 1, `gcp` at Stage 2-3. Additional providers (gitlab-ci, aws, azure, openstack) ship at Stage 4+ as demand materializes. See [03-providers.md](03-providers.md) for provider implementations and [ROADMAP.md](ROADMAP.md) for deferred providers.

### Setup Commands

Non-local providers get a `bollard setup` command:

```bash
npx bollard setup github-actions                    # creates workflow, reminds to set API key secret
npx @bollard/provider-gcp setup --project my-project  # enables APIs, creates secret, bucket
```

Each takes 2-5 minutes. No manual YAML editing required.

---

## 8. The "Just Works" Matrix

For every combination of project type and provider, here's what should happen with **zero configuration** beyond the setup command:

| Project | Provider | What You Do | What Happens |
|---------|----------|-------------|-------------|
| TS + Vitest + Biome (ideal) | local | `bollard init` + set API key | Everything works |
| TS + Jest + ESLint (legacy) | local | `bollard init` | Works — detects Jest/ESLint |
| TS + no tests (greenfield) | local | `bollard init` | Works — agent generates all tests |
| JS (no TypeScript) | local | `bollard init` | Works — disables type check layer, warns |
| Python + pytest + ruff + mypy | local | `bollard init` | Detects all four. Verification profile auto-configured. |
| Python + no tests (new) | local | `bollard init` | Detects Python, warns no tests. Layer 1 skipped, Layer 2 still runs. |
| Go module | local | `bollard init` | Detects go test, go vet, govulncheck. |
| Rust + cargo | local | `bollard init` | Detects cargo test, clippy, cargo-audit. |
| Polyglot (TS + Python) | local | `bollard init` | Detects both. Per-package profiles. |
| Empty directory | local | `bollard init` | Interactive: asks language, suggests tools. |
| Any | github-actions | `bollard setup github-actions` | Label issue → PR |
| Any | gcp | `npx @bollard/provider-gcp setup --project X` | Cloud Run Jobs → PR |

See [06-toolchain-profiles.md](06-toolchain-profiles.md) for the full detection matrix and the three-layer verification model.

None of these require editing `.bollard.yml`.

---

## 9. How Config Is Read at Runtime

Bollard's config resolution follows a strict priority order (highest wins):

```
CLI flags  →  env vars  →  .bollard.yml  →  auto-detected  →  hardcoded defaults
```

At runtime, the resolved config is a `BollardConfig` object (see [01-architecture.md](01-architecture.md)). Every value in that object has a `source` annotation for debugging: `"auto-detected"`, `"env:BOLLARD_MODEL"`, `"file:.bollard.yml"`, or `"default"`.

```bash
# See the fully resolved config for your project
npx bollard config show

# See where each value came from
npx bollard config show --sources
```

This replaces the old approach of dumping a 100-line YAML file and hoping the user edits the right line. The config is computed, not declared.

---

*Bollard: zero config for the simple case. One env var for the common case. Five lines of YAML for the rest.*
