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


| #                              | Document                 | What It Covers                                                                                                                                                         |
| ------------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [01](01-architecture.md)       | **Architecture**         | Universal artifact pattern, adversarial verification, blueprint engine, CLI + API-first + MCP interface, production feedback loop, resilience model, project structure |
| [02](02-bootstrap.md)          | **Bootstrap Roadmap**    | How Bollard builds itself: 5 stages from hand-written kernel to self-hosting, prompt evaluation framework, dependency graph, time estimates                            |
| [03](03-providers.md)          | **Providers**            | Cloud abstraction: the 4-method provider interface, 3 provider implementations (local, GitHub Actions, GCP), network isolation                                         |
| [04](04-configuration.md)      | **Configuration**        | Auto-detect everything, derive the rest: provider detection, env vars, convention over configuration, minimal `.bollard.yml` for overrides only                        |
| [05](05-risk-model.md)         | **Risk Model**           | Trust but verify: 5 risk dimensions, risk scoring, graduated gating (auto-merge → notify → approve), escape hatches, meta-verification, notification model             |
| [06](06-toolchain-profiles.md) | **Toolchain Profiles**   | Language-agnostic verification: three-layer model, toolchain detection, Docker isolation, adversarial test lifecycle                                                   |
| [07](07-adversarial-scopes.md) | **Adversarial Scopes**   | Multi-scope adversarial verification: boundary/contract/behavioral scopes, forward roadmap (Stages 3-5)                                                                |
| —                              | [ROADMAP.md](ROADMAP.md) | **Roadmap**                                                                                                                                                            |


### Reading Order

**First time?** Read 01 → 05 → 02.
**Deploying?** Read 04 → 03.
**Contributing?** Read 02 → 01.

---

## Key Architectural Decisions


| Decision                    | Choice                                                                                                                  | Rationale                                                                             | ADR |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --- |
| Universal artifact pattern  | Every artifact (code, tests, docs, IaC) goes through: produce → adversarial verify → mechanical proof → drift detection | Same failure modes, same solution                                                     | 001 |
| API-first, CLI + MCP        | Engine is a library; CLI and MCP server are equal clients                                                               | Use Bollard from terminal, Claude Code, Cursor, or any MCP client — same capabilities | —   |
| pnpm over Turborepo         | pnpm workspaces, no build orchestration service                                                                         | Minimal dependencies, no external infrastructure                                      | 002 |
| Risk-based gating           | Graduated autonomy based on blast radius, reversibility, security, cost, novelty                                        | Scales beyond binary human gates; humans focus where it matters                       | 003 |
| All artifacts are equal     | Docs, IaC, schemas verified through the same pattern as code                                                            | Prevents silent drift in any artifact type                                            | 004 |
| Cloud-agnostic providers    | 4-method interface, 3 providers (local, GitHub Actions, GCP), more via ROADMAP                                          | Run anywhere Docker runs; no vendor lock-in                                           | —   |
| Blueprint engine (~500 LOC) | Custom TypeScript, not LangChain/CrewAI                                                                                 | Full control, no framework lock-in, minimal dependencies                              | —   |
| Production Feedback Loop    | Canary rollout by risk tier → probe → fix forward + drift detection → system converges                                  | Defense in depth: pipeline verifies against spec, canary verifies against reality     | —   |
| Open source (Apache 2.0)    | Permissive license with patent grant                                                                                    | Encourages adoption without scaring enterprise; standard for developer tools          | —   |


---

## Tech Stack

**Required:** Docker, Node.js 22+, pnpm, TypeScript (strict), an LLM API key.
**Included:** Vitest, fast-check, Biome, Zod, Stryker, gitleaks.
**Optional:** Pact, Playwright, OpenTelemetry, Sentry.
**Explicitly excluded:** Turborepo, ESLint+Prettier, Jest, LangChain/CrewAI, remote caching services.

---

## Open Source

**License:** Apache 2.0 — permissive, includes patent grant, standard for developer infrastructure (Kubernetes, Terraform, Docker).

**Why Apache 2.0 over MIT?** The patent grant protects both contributors and users. MIT is simpler but leaves patent claims ambiguous. AGPL would limit enterprise adoption without clear benefit.

**Why open source at all?** Bollard verifies AI agents — the verification logic itself must be auditable. A closed-source verifier asks you to trust the trust layer. That defeats the purpose. Open source means the adversarial pipeline is itself adversarially verifiable by anyone.

**Contribution model:** Bollard verifies its own contributions. PRs go through the same adversarial pipeline as any other project using Bollard. At Stage 4 (self-hosting), Bollard's risk model gates community contributions: documentation fixes auto-merge, engine changes require maintainer review.

**Extension model:** MCP is the plugin system. Custom agents, custom probes, custom providers, external integrations — all work through MCP tools or the BollardProvider interface. No proprietary plugin format, no marketplace, no vendor lock-in.

---

## Archive

Historical prompts used to drive Cursor during each build stage are in `archive/`.
These document how each stage was built but are not current guidance.

---

## Status

**Phase:** Stage 3a validated **YELLOW** (2026-04-07) — contract-scope adversarial testing shipped on top of Stage 2's adversarial verification infrastructure. Full per-check results in [stage3a-validation-results.md](stage3a-validation-results.md).

**Pending to flip YELLOW → GREEN:** one full 16-node `implement-feature` self-test after commit `f14bd66` (Vitest contract-config fix). Earlier validation attempts each surfaced a distinct blocker that was fixed in its own commit, but no single run has exercised the end-to-end pipeline with all Stage 3a fixes in place.

**Next:**
- **Stage 3b:** contract graph beyond TypeScript (Python / Go / Rust workspaces); Go + Rust toolchains in the dev image so the two skipped extractor integration tests go unconditional; contract-tester prompt tuning.
- **Stage 3c:** per-language mutation testing (Stryker / mutmut / cargo-mutants); semantic review agent; streaming LLM responses.
- **Stage 4:** behavioral-scope adversarial testing + production feedback loop.
- **Stage 5:** self-hosting + self-improvement.

---

*Bollard: because nothing ships until the bollard says so.*