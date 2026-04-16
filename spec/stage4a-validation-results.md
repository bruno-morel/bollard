# Stage 4a — Behavioral-Scope Adversarial Testing — Validation Results

**Status:** GREEN (2026-04-16)

## Summary

Stage 4a adds the **behavioral** adversarial scope: deterministic `BehavioralContext` extraction (endpoints, config, dependencies, failure modes), `behavioral-tester` agent with the same JSON claims protocol as contract scope, grounding via `behavioralContextToCorpus`, five new `implement-feature` nodes (16–20), `createFaultInjector` (`service_stop` only), `generateBehavioralCompose`, CLI `bollard behavioral`, and MCP `bollard_behavioral`.

## Checks

| Check | Result |
|-------|--------|
| `docker compose run --rm dev run test` | 626 passed, 2 skipped |
| `docker compose run --rm dev run typecheck` | Clean |
| `docker compose run --rm dev run lint` | Clean |
| `bollard behavioral` (monorepo) | Prints JSON with endpoints, deps, config (e.g. `ANTHROPIC_API_KEY` from `packages/llm/src/client.ts`) |
| Blueprint node count | 27 nodes; behavioral block after `run-contract-tests`, before `run-mutation-testing` |

## Notes

- Behavioral scope remains **opt-in** via `adversarial.behavioral.enabled: true` in `.bollard.yml` (default `false` in `defaultAdversarialConfig`).
- Empty context (`endpoints.length === 0 && dependencies.length === 0`) skips downstream behavioral nodes with `BEHAVIORAL_CONTEXT_EMPTY` — not a pipeline failure.
- Fixture for extractor smoke tests: [tests/fixtures/behavioral-fixture/](../tests/fixtures/behavioral-fixture/) (minimal HTTP server + env keys).

## Deferred (Stage 4a+)

- Network-level fault injection (`tc` / `iptables`), library-mode stress harness, deployment archetype CLI — per [stage4a-behavioral-scope.md](./stage4a-behavioral-scope.md) if present, else spec/07-adversarial-scopes.md.
