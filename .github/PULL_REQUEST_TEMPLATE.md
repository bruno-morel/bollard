## What

<!-- One paragraph: what this PR changes and why. One logical change per PR. -->

## Verification (all must pass — CI enforces the same set)

- [ ] `docker compose run --rm dev run typecheck` — exit 0
- [ ] `docker compose run --rm dev run lint` — exit 0
- [ ] `docker compose run --rm dev run test` — no failures
- [ ] `docker compose run --rm dev --filter @bollard/cli run start -- audit-docs` — exit 0
- [ ] Test counts in `README.md` / `CLAUDE.md` updated if the total changed
- [ ] New source files have corresponding test files

## Dependencies

- [ ] No new dependencies — **or** justification below for each (could it be ~50 lines of TypeScript instead?)

## Scope check

- [ ] Not on the `spec/ROADMAP.md` **DO NOT build yet** list
- [ ] Agent prompt files (`packages/agents/prompts/`) untouched — or the change is the explicit purpose of this PR
