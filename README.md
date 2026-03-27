# Bollard

### The immovable post between your AI agents and production.

> *"AI was supposed to replace developers. Turns out you need a bollard to stop it from crashing into the dock."*

---

## What Is Bollard?

Bollard is an **artifact integrity framework** for AI-assisted software development. It ensures that every artifact in your project — code, tests, documentation, infrastructure config, API schemas, production probes, feature flags — is produced, verified, and maintained through the same adversarial pipeline.

The core insight: code, tests, and docs all suffer from the same failure modes when AI agents produce them. They can be hallucinated, they can drift from reality, they can be internally consistent but wrong. The solution is the same for all of them: **separate the producer from the verifier, then mechanically prove the verification itself is sound.**

Bollard is **open source** (Apache 2.0), **API-first** (library → CLI + MCP server), and **battery-included** (auto-detects your project, zero config for most setups). Use it from the terminal, from Claude Code, from Cursor, or from any MCP-compatible tool.

---

## Design Documents

| # | Document | What It Covers |
|---|----------|---------------|
| [01](01-architecture.md) | **Architecture** | Universal artifact pattern, adversarial verification, blueprint engine, CLI + API-first + MCP interface, production feedback loop, resilience model, project structure |
| [02](02-bootstrap.md) | **Bootstrap Roadmap** | How Bollard builds itself: 5 stages from hand-written kernel to self-hosting, prompt evaluation framework, dependency graph, time estimates |
| [03](03-providers.md) | **Providers** | Cloud abstraction: the 4-method provider interface, 3 provider implementations (local, GitHub Actions, GCP), network isolation |
| [04](04-configuration.md) | **Configuration** | Auto-detect everything, derive the rest: provider detection, env vars, convention over configuration, minimal `.bollard.yml` for overrides only |
| [05](05-risk-model.md) | **Risk Model** | Trust but verify: 5 risk dimensions, risk scoring, graduated gating (auto-merge → notify → approve), escape hatches, meta-verification, notification model |
| — | [ROADMAP.md](ROADMAP.md) | **Roadmap** | Features deferred from v0.1: SLO tracking, error budgets, progressive rollout, additional cloud providers, full prompt eval framework |

### Reading Order

**First time?** Read 01 → 05 → 02.
**Deploying?** Read 04 → 03.
**Contributing?** Read 02 → 01.

---

## Key Architectural Decisions

| Decision | Choice | Rationale | ADR |
|----------|--------|-----------|-----|
| Universal artifact pattern | Every artifact (code, tests, docs, IaC) goes through: produce → adversarial verify → mechanical proof → drift detection | Same failure modes, same solution | 001 |
| API-first, CLI + MCP | Engine is a library; CLI and MCP server are equal clients | Use Bollard from terminal, Claude Code, Cursor, or any MCP client — same capabilities | — |
| pnpm over Turborepo | pnpm workspaces, no build orchestration service | Minimal dependencies, no external infrastructure | 002 |
| Risk-based gating | Graduated autonomy based on blast radius, reversibility, security, cost, novelty | Scales beyond binary human gates; humans focus where it matters | 003 |
| All artifacts are equal | Docs, IaC, schemas verified through the same pattern as code | Prevents silent drift in any artifact type | 004 |
| Cloud-agnostic providers | 4-method interface, 3 providers (local, GitHub Actions, GCP), more via ROADMAP | Run anywhere Docker runs; no vendor lock-in | — |
| Blueprint engine (~500 LOC) | Custom TypeScript, not LangChain/CrewAI | Full control, no framework lock-in, minimal dependencies | — |
| Production Feedback Loop | Canary rollout by risk tier → probe → fix forward + drift detection → system converges | Defense in depth: pipeline verifies against spec, canary verifies against reality | — |
| Open source (Apache 2.0) | Permissive license with patent grant | Encourages adoption without scaring enterprise; standard for developer tools | — |

---

## Getting Started

**Prerequisites:** Docker and Docker Compose. That's it — no local Node.js, pnpm, or other tooling needed.

```bash
# Clone the repo
git clone <repo-url> && cd bollard

# Build the dev image
docker compose build dev

# Run tests
docker compose run --rm dev run test

# Type-check
docker compose run --rm dev run typecheck

# Lint
docker compose run --rm dev run lint

# Run the demo blueprint (requires ANTHROPIC_API_KEY)
ANTHROPIC_API_KEY=sk-... docker compose run --rm dev --filter @bollard/cli run start -- run demo --task "Say hello"
```

---

## Tech Stack

**Required:** Docker (all tooling runs in containers).
**Inside the container:** Node.js 22+, pnpm, TypeScript (strict), Vitest, fast-check, Biome, Zod, tsx.
**Later stages:** Stryker, gitleaks, Pact, Playwright, OpenTelemetry, Sentry.
**Explicitly excluded:** Turborepo, ESLint+Prettier, Jest, LangChain/CrewAI, remote caching services.

---

## Open Source

**License:** Apache 2.0 — permissive, includes patent grant, standard for developer infrastructure (Kubernetes, Terraform, Docker).

**Why Apache 2.0 over MIT?** The patent grant protects both contributors and users. MIT is simpler but leaves patent claims ambiguous. AGPL would limit enterprise adoption without clear benefit.

**Why open source at all?** Bollard verifies AI agents — the verification logic itself must be auditable. A closed-source verifier asks you to trust the trust layer. That defeats the purpose. Open source means the adversarial pipeline is itself adversarially verifiable by anyone.

**Contribution model:** Bollard verifies its own contributions. PRs go through the same adversarial pipeline as any other project using Bollard. At Stage 4 (self-hosting), Bollard's risk model gates community contributions: documentation fixes auto-merge, engine changes require maintainer review.

**Extension model:** MCP is the plugin system. Custom agents, custom probes, custom providers, external integrations — all work through MCP tools or the BollardProvider interface. No proprietary plugin format, no marketplace, no vendor lock-in.

---

## Status

**Phase:** Stage 0 in progress (the kernel: engine types, runner, LLM client, CLI skeleton)
**Development:** All via Docker Compose — `docker compose run --rm dev run test`

---

*Bollard: because nothing ships until the bollard says so.*
