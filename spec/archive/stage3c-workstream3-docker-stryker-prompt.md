# Stage 3c Workstream 3: Docker image + Stryker dependencies

> **Goal:** Install `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` as workspace devDependencies so the `run-mutation-testing` node can actually execute inside the Docker dev image. Verify that `pnpm exec stryker run --help` works inside the container.

## Context

Read these files before writing any code:

- `CLAUDE.md` (root) — project conventions, Docker-only dev rules, dep install procedure
- `package.json` (root) — current workspace devDependencies
- `Dockerfile` — multi-stage build (go-helper-builder → rust-helper-builder → dev → dev-full)
- `compose.yaml` — Docker Compose config for the `dev` and `dev-full` services
- `pnpm-lock.yaml` — lockfile (will be regenerated)

## What needs to happen

This is a dependency installation workstream, not a code workstream. The steps are mechanical and follow the procedure documented in CLAUDE.md.

### Step 1: Add Stryker packages to root devDependencies

Add these two packages as workspace-level devDependencies in the root `package.json`:

```
@stryker-mutator/core
@stryker-mutator/vitest-runner
```

Use the procedure from CLAUDE.md for adding dependencies. Since these are workspace-root devDependencies:

```bash
# Update the lockfile first (required because frozen-lockfile will fail otherwise)
docker run --rm -e CI=true -v "$(pwd):/app" -w /app node:22-slim \
  sh -c "corepack enable && corepack prepare pnpm@latest --activate && pnpm add -Dw @stryker-mutator/core @stryker-mutator/vitest-runner"
```

This updates both `package.json` and `pnpm-lock.yaml`.

### Step 2: Add Stryker to `pnpm.onlyBuiltDependencies` if needed

Check if `@stryker-mutator/core` has native build scripts. If it does, add it to the `pnpm.onlyBuiltDependencies` array in `package.json` (alongside `@biomejs/biome` and `esbuild`). If it doesn't have native build scripts, skip this.

### Step 3: Rebuild the Docker dev image

```bash
docker compose build dev
```

This bakes the new lockfile and dependencies into the image.

### Step 4: Verify Stryker is available inside the container

```bash
docker compose run --rm dev exec stryker --version
```

This should print the Stryker version. If it fails, the install didn't work.

Also verify the vitest-runner plugin is loadable:

```bash
docker compose run --rm --entrypoint sh dev -c "node -e \"require('@stryker-mutator/vitest-runner')\""
```

### Step 5: Run the full test suite to confirm no regressions

```bash
docker compose run --rm dev run test
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
```

Expected: 546 passed / 2 skipped, typecheck clean, lint clean. Zero regressions — this workstream only adds dependencies.

### Step 6: Verify named volumes are fresh

If tests fail with module resolution errors, the stale node_modules volume needs clearing:

```bash
docker compose down -v
docker compose build dev
docker compose run --rm dev run test
```

This is documented in CLAUDE.md: "When adding new workspace packages, you must `docker compose down -v` to recreate stale volumes."

## What NOT to do

- Do NOT modify any TypeScript source files
- Do NOT modify the Dockerfile (the `pnpm install --frozen-lockfile` in the dev stage already picks up new lockfile entries)
- Do NOT modify compose.yaml
- Do NOT add Stryker to any sub-package `package.json` — it goes at the workspace root only
- Do NOT run `pnpm install` on the host — everything goes through Docker

## Expected output

| Metric | Expected |
|--------|----------|
| Changed files | 2 (`package.json`, `pnpm-lock.yaml`) |
| New files | 0 |
| Test count | 546 passed / 2 skipped (unchanged) |
| Typecheck | Clean |
| Lint | Clean |
| `stryker --version` in container | Prints version number |

## Commit

```
Stage 3c: add Stryker mutation testing dependencies
```

Single commit with `package.json` and `pnpm-lock.yaml`.
