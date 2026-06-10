# Contributing to Bollard

Thanks for your interest. Bollard verifies its own contributions — the bar is mechanical, not social: if the gates pass, the work is welcome.

## Development environment — Docker only

Everything runs through Docker Compose. **Never run bare `pnpm`, `node`, `tsc`, `vitest`, or `biome` on your host.** The only local prerequisite is Docker.

```bash
docker compose build dev                       # first time, or after dependency changes
docker compose run --rm dev run test           # tests
docker compose run --rm dev run typecheck      # types
docker compose run --rm dev run lint           # lint + format check
docker compose run --rm dev run format         # auto-format
```

Adding dependencies (think twice first — see below):

```bash
docker compose run --rm dev add --filter @bollard/<pkg> <dependency>
docker compose build dev                       # bake into the image
```

If you add a new workspace package: update the lockfile via the documented `node:24-slim` one-liner in `CLAUDE.md`, rebuild, then `docker compose down -v` to recreate stale volumes.

LLM-dependent commands need `ANTHROPIC_API_KEY` in a `.env` at the repo root. Unit tests never call real LLMs (`MockProvider`); the suite runs key-free.

## Before opening a PR — the gate

All of these must pass; CI (`bollard-verify.yml`) enforces the same set:

1. `docker compose run --rm dev run typecheck` — exit 0
2. `docker compose run --rm dev run lint` — exit 0
3. `docker compose run --rm dev run test` — no failures; if the test count changed, update the counts in `README.md` and `CLAUDE.md` (the `audit-docs` check fails CI when they drift)
4. `docker compose run --rm dev --filter @bollard/cli run start -- audit-docs` — exit 0
5. One logical change per commit; commit messages follow `Stage N: <what changed>` for roadmap work, or a plain imperative summary for fixes

## Code conventions (enforced by review and Biome)

- Named exports only; no default exports. No semicolons. Functions + interfaces over classes (exceptions: `BollardError`, `CostTracker`, `LLMClient`, providers).
- No `any` — use `unknown` and narrow. `exactOptionalPropertyTypes` is on: use conditional spread (`...(v !== undefined ? { k: v } : {})`), never assign `undefined` to optional props.
- Errors are always `BollardError` with a code from `packages/engine/src/errors.ts` and context attached. Never throw raw `Error`.
- Pipeline logging via `ctx.log.*`, never `console.log`.
- File names kebab-case; camelCase functions, PascalCase types, UPPER_SNAKE constants.
- Every source file gets a corresponding test file (Vitest). Tool tests use real temp dirs, cleaned per test.

## Dependencies — think twice

Minimal-dependency stack is a design principle. Before adding anything, ask: can this be ~50 lines of TypeScript instead? New runtime dependencies need a justification in the PR description. The explicitly-excluded list (Jest, ESLint/Prettier, Turborepo, agent frameworks) is in `CLAUDE.md` and is not up for re-litigation in a feature PR.

## Where to start

- `CLAUDE.md` — codebase map, conventions, current state (it is the source of truth and is itself drift-checked).
- `spec/01-architecture.md` and `spec/07-adversarial-scopes.md` — design and forward roadmap.
- `spec/adr/` — decisions with rationale; read ADR-0001 and ADR-0004 before proposing LLM-related changes.
- Check `spec/ROADMAP.md` for the **DO NOT build yet** list before starting anything large — sequencing is deliberate.

## Conduct

Be excellent to each other — see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Security issues go through [SECURITY.md](SECURITY.md), not public issues.
