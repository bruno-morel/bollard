# Bollard

### The immovable post between your AI agents and production.

> *"AI was supposed to replace developers. Turns out you need a bollard to stop it from crashing into the dock."*

---

## What Is Bollard?

Bollard is an **artifact integrity framework** for AI-assisted software development. It ensures every artifact — code, tests, documentation, infrastructure config — is produced, adversarially verified, and mechanically proven sound before shipping.

The core insight: **separate the producer from the verifier, then prove the verification itself is meaningful** (via mutation testing). Code, tests, and docs all suffer from the same failure modes when AI agents produce them — hallucination, drift, internal consistency without correctness. The solution is the same for all of them.

Bollard is **open source** (Apache 2.0), **API-first** (library → CLI + MCP server), and **battery-included** (auto-detects your project, zero config for most setups). Use it from the terminal, from Claude Code, from Cursor, or from any MCP-compatible tool.

---

## Status

**Active development — Stages 0 through 5b complete.**

The full `implement-feature` pipeline (31 nodes) runs end-to-end on the Bollard codebase itself:
plan → implement → static checks → boundary adversarial → contract adversarial → behavioral adversarial → mutation testing → semantic review → Docker-isolated verify → human gate → PR.

**Languages supported:** TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin.
**LLM providers:** Anthropic (Claude), OpenAI, Google (Gemini). Local inference via llama.cpp (opt-in).
**IDE integrations:** Claude Code, Cursor, Codex, Antigravity (via `bollard init --ide`).
**MCP server:** 16 tools, 6 resource endpoints, 3 prompt templates.

**Test suite:** 1305 passed / 6 skipped · Adversarial suite: 337 passed.

---

## Getting Started

**Prerequisites:** Docker and Docker Compose. No local Node.js, pnpm, or other tooling needed.

```bash
# Clone and build
git clone <repo-url> && cd bollard
docker compose build dev

# Verify the repo (typecheck + lint + audit)
docker compose run --rm dev --filter @bollard/cli run start -- verify

# Run the full test suite
docker compose run --rm dev run test

# Generate a plan for a task (requires ANTHROPIC_API_KEY in .env)
docker compose run --rm -e BOLLARD_AUTO_APPROVE=1 dev sh -c \
  'pnpm --filter @bollard/cli run start -- plan --task "Add retry logic to HTTP client"'

# Run the full implement-feature pipeline
docker compose run --rm -e BOLLARD_AUTO_APPROVE=1 dev sh -c \
  'pnpm --filter @bollard/cli run start -- run implement-feature --task "Add health check endpoint"'

# Run history / cost baseline / doctor
docker compose run --rm dev --filter @bollard/cli run start -- history
docker compose run --rm dev --filter @bollard/cli run start -- cost-baseline show
docker compose run --rm dev --filter @bollard/cli run start -- doctor --history
```

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `verify [--quiet] [--ci-passed <list>]` | Static verification (typecheck, lint, audit, secretScan) |
| `run implement-feature --task "..."` | Full 31-node pipeline with human gates |
| `plan --task "..."` | Standalone planner agent |
| `contract` | Print contract graph JSON |
| `behavioral` | Print behavioral context JSON |
| `init --ide <platform>` | Generate IDE config (`cursor`, `claude-code`, `codex`, `all`) |
| `watch` | Continuous verification on file changes |
| `history [show\|compare\|summary\|rebuild]` | Run history with filters |
| `cost-baseline [tag\|show\|diff]` | Cost regression tracking |
| `eval [agent]` | Run prompt eval sets |
| `doctor [--history]` | Health check with run history diagnostics |
| `probe / deploy / flag / drift` | Production feedback loop commands |

---

## Architecture

Bollard has a layered architecture. Each layer only knows about the layer below it.

```
CLI / MCP server          ← equal clients of the engine library
     ↓
Blueprint engine          ← sequential node runner, cost tracker, history
     ↓
Agents + Tools            ← planner, coder, 3 adversarial testers, reviewer
     ↓
Verify + Detect           ← static checks, dynamic tests, extractors, mutation
     ↓
LLM providers             ← Anthropic, OpenAI, Google, local (llama.cpp)
```

**Three adversarial scopes** — each with its own agent, context, and concern weights:
- **Boundary** — type-level correctness, edge cases, security (injection, auth bypass)
- **Contract** — cross-module API contracts, interface compatibility, behavioral contracts
- **Behavioral** — endpoint behavior, config, dependencies, fault injection, failure modes

**Mutation testing** (Stryker / mutmut / cargo-mutants / PIT) proves the adversarial tests are meaningful — not just passing because they never assert anything sharp.

---

## Design Documents

All specs live in [`spec/`](spec/):

| Document | What It Covers |
|----------|----------------|
| [spec/01-architecture.md](spec/01-architecture.md) | Engine types, blueprint runner, pipeline layers, production feedback loop |
| [spec/02-bootstrap.md](spec/02-bootstrap.md) | Stage-by-stage build history (Stages 0 → 2) |
| [spec/04-configuration.md](spec/04-configuration.md) | Auto-detection, `.bollard.yml` reference, config priority |
| [spec/05-risk-model.md](spec/05-risk-model.md) | Risk dimensions, scoring, graduated gating |
| [spec/06-toolchain-profiles.md](spec/06-toolchain-profiles.md) | Language-agnostic verification, `ToolchainProfile`, Docker isolation |
| [spec/07-adversarial-scopes.md](spec/07-adversarial-scopes.md) | Boundary / contract / behavioral scopes, concern weights, forward roadmap |
| [spec/ROADMAP.md](spec/ROADMAP.md) | Forward roadmap (Stages 5c → 6+) |
| [spec/README.md](spec/README.md) | Spec index |

**ADRs** in [`spec/adr/`](spec/adr/):

| ADR | Decision |
|-----|----------|
| [0001](spec/adr/0001-deterministic-filters-for-llm-output.md) | Deterministic post-filters for LLM output (grounding, claim parsing) |
| [0002](spec/adr/0002-syn-helper-for-rust-extraction.md) | syn-based Rust extractor helper binary |
| [0003](spec/adr/0003-agent-protocol-compliance.md) | WHY + DO NOT + SELF-CHECK protocol structure for agent prompts |
| [0004](spec/adr/0004-determinism-local-frontier-tiers.md) | Determinism-first → local → frontier tier model for token economy |

---

## Tech Stack

**Required:** Docker (all tooling runs in containers — nothing installed locally except Docker).

**Inside the container:** Node.js 22+, pnpm workspaces, TypeScript 5.x strict, Vitest, fast-check, Biome, Zod, tsx.

**Mutation testing:** Stryker (TS/JS), mutmut (Python), cargo-mutants (Rust), PIT (Java/Kotlin).

**Explicitly excluded:** Turborepo, ESLint+Prettier, Jest, LangChain/CrewAI, any agent framework.

---

## Key Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Separate producer from verifier | Planner + coder agents produce; three adversarial agents independently verify | Same person writing and reviewing is the core failure mode of AI code |
| Mutation testing proves coverage | Stryker/mutmut/cargo-mutants after adversarial test generation | Adversarial tests that never kill a mutant aren't testing anything sharp |
| Determinism first | Anything that can be deterministic must be; LLM reserved for creative work | ADR-0004; operationalized in Stage 5d token economy |
| Blueprint engine (~500 LOC) | Custom TypeScript, not LangChain/CrewAI | Full control, minimal dependencies, no framework lock-in |
| API-first, CLI + MCP equal | Engine is a library; CLI and MCP server are equal clients | Use from terminal, Claude Code, Cursor, or any MCP client — same capabilities |
| Docker-isolated adversarial tests | Adversarial tests run in separate containers from production code | Tests in the same process share failure modes with the code they test |
| Open source (Apache 2.0) | Permissive license with patent grant | The verification logic must be auditable; a closed verifier defeats the purpose |

---

## Self-Hosting

Bollard verifies its own contributions. The Bollard-on-Bollard CI pipeline runs on every PR:

- **`.github/workflows/bollard-verify.yml`** — typecheck + lint + `bollard verify --quiet` on every push/PR (zero LLM cost)
- **`.github/workflows/cost-regression.yml`** — full `implement-feature` pipeline weekly; exits 1 if average cost regresses beyond threshold
- **`.github/workflows/eval-regression.yml`** — prompt eval suite weekly; exits 1 if any agent's pass rate drops > 10 pp

Run history, cost baselines, and prompt eval baselines are all stored in `.bollard/` and tracked by the CI.

---

*Bollard: because nothing ships until the bollard says so.*
