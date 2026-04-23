# ADR-0003: Agent protocol compliance — advisory vs self-enforcing

**Status:** Accepted
**Date:** 2026-04-22
**Deciders:** Bruno (maintainer)
**Supersedes:** —
**Related:** [spec/stage4d-validation-results.md](../stage4d-validation-results.md), [ADR-0001](./0001-deterministic-filters-for-llm-output.md)

## Context

Bollard's verification protocol requires AI coding agents (Cursor, Claude Code, Codex) to use Bollard's MCP tools (`bollard_verify`, `bollard_contract`, `bollard_drift_check`) instead of running raw verification commands (`pnpm run typecheck`, `docker compose run --rm dev run lint`, etc.). The protocol is communicated through rules files: `.cursor/rules/bollard.mdc` for Cursor, CLAUDE.md augmentation for Claude Code.

During Stage 4d validation, we ran a Bollard-on-Bollard self-test: we asked the Cursor agent to implement a real feature (add `bollard_watch_status` MCP tool) while the Bollard MCP server was available, and observed whether it followed the verification protocol.

The first version of the protocol used imperative language:

```
## Verification Protocol
You MUST use Bollard MCP tools for ALL verification.
You MUST NOT run pnpm, tsc, biome, or vitest directly.
```

**Result:** The agent ignored the protocol and ran `pnpm run typecheck` directly. The "MUST" language had zero observable effect on behavior.

This is not a bug in a specific model — it is a structural property of how LLMs process instructions. A "MUST" rule competes with the model's training priors (which include millions of examples of running `pnpm run typecheck` directly). Without understanding *why* the rule exists, the model has no basis for overriding its default behavior. Without seeing *what not to do* concretely, the model doesn't recognize when it's about to violate the rule. Without a *self-check step*, the model never pauses to verify compliance before declaring completion.

The forces at play:

- Bollard's protocol is **agent-native** (communicated through rules files, not per-edit hooks). Cursor has no hooks mechanism; Claude Code has only a pre-commit gate. The protocol must work through prompt engineering alone for most platforms.
- Rules files compete for attention with the model's training data, the user's task description, and accumulated conversation context. Any single rule can be displaced.
- Imperative-only instructions ("you MUST") provide no reasoning anchor. The model follows them when convenient and ignores them when its priors suggest a different approach.
- Adding more "MUST" rules makes each individual rule less likely to be followed (prompt saturation).

## Decision

Replace imperative-only protocol instructions with a three-part structure:

### 1. WHY section (motivation-first)

Explain *why* the protocol exists in terms the model can reason about. This gives the model a basis for choosing Bollard tools over raw commands even when its priors suggest otherwise.

```markdown
## WHY USE BOLLARD MCP TOOLS

Bollard MCP tools run the SAME checks as raw commands but add:
- Profile-aware verification (correct checks for detected language)
- Structured output (allPassed, summary, per-check results)
- Workspace root resolution (correct paths in containers and monorepos)
- Cost tracking and run history

Running raw commands bypasses all of these. The checks may pass but
Bollard loses visibility — drift detection, probe extraction, and
mutation targeting all depend on verification going through Bollard.
```

### 2. DO NOT section (concrete negative examples)

List the specific commands the model must not run, with the exact strings it would type. Models are better at pattern-matching against concrete examples than against abstract rules.

```markdown
## CRITICAL: DO NOT RUN VERIFICATION COMMANDS DIRECTLY

These commands bypass Bollard's verification pipeline:
❌ pnpm run typecheck
❌ pnpm run lint
❌ pnpm run test
❌ docker compose run --rm dev run typecheck
❌ npx vitest run
❌ npx biome check

Instead, call the bollard_verify MCP tool.
```

### 3. BEFORE REPORTING COMPLETION self-check

Add a checklist the model runs through before declaring its work done. This creates a deliberate pause point where the model evaluates its own behavior against the protocol.

```markdown
## BEFORE REPORTING COMPLETION — SELF-CHECK

Before telling the user you're done, verify:
- [ ] Did I use bollard_verify (not raw pnpm/tsc/biome/vitest)?
- [ ] Did I use bollard_contract for contract context (not manual imports)?
- [ ] Did I use bollard_drift_check (not raw git diff)?
- [ ] Are there any raw verification commands in my tool call history?
- [ ] Did bollard_verify return allPassed: true?
```

## Consequences

### Positive

- **Stage 4d self-test: 5/5 protocol compliance** after the rewrite. The agent used `bollard_verify` for all verification, never ran raw commands, and checked the self-check list before reporting completion.
- **Transferable pattern.** The WHY + DO NOT + SELF-CHECK structure applies to any protocol communicated through prompts — not just Bollard's verification protocol. Future IDE generators, MCP tool descriptions, and agent system prompts should follow this shape.
- **Scales sublinearly.** Adding a new protocol rule means adding one line to DO NOT and one line to the self-check — not a new paragraph of imperative instructions that dilutes the rest.

### Negative

- **Prompt length increases.** The three-part structure is ~3x longer than a simple "you MUST" rule. For protocols with many rules, this could consume meaningful context window.
- **Not a guarantee.** The self-check is still advisory — a model under context pressure may skip it. The only true guarantee is a deterministic gate (like Claude Code's pre-commit hook), which not all platforms support.
- **Requires maintenance.** The DO NOT list must be kept in sync with the actual commands that exist. If Bollard adds a new verification command, the negative example list needs updating.

### Relationship to ADR-0001

ADR-0001 established the principle: when ground truth exists in deterministic form, add a post-filter rather than fixing the prompt. ADR-0003 addresses a different failure mode: protocol compliance is not about output correctness (is the generated code right?) but about process compliance (did the agent use the right tools?). There is no post-filter that can retroactively change which tools the agent called — the protocol must be enforced *during* the agent's execution, which means prompt engineering is the only lever for platforms without hooks.

The two ADRs are complementary:
- **ADR-0001:** "The LLM's output may be wrong → add a deterministic check after."
- **ADR-0003:** "The LLM's process may be wrong → structure the prompt so it self-corrects during."

## Validation

Three Bollard-on-Bollard self-test rounds validate the pattern:

| Round | Stage | Protocol version | Result |
|-------|-------|-----------------|--------|
| 1 | Stage 2 | No protocol (pre-MCP) | N/A — no MCP tools existed |
| 2 | Stage 4c | Imperative "you MUST" | Not tested (self-test focused on pipeline, not protocol) |
| 3 | Stage 4d | WHY + DO NOT + SELF-CHECK | **5/5 compliance** — agent used bollard_verify for all checks, no raw commands |

The self-test methodology itself is now a formal validation pattern for future stages: give the model a real task through real infrastructure, observe behavior, measure with a checklist. See [ROADMAP.md Stage 5a](../ROADMAP.md) for how this becomes automated CI.
