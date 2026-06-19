---
name: dependabot-zero-and-ci-fix
overview: "Two related close-out tasks on main: (1) land the qs + ip-address override restore to take Dependabot to zero, with a mandatory lockfile regen; (2) diagnose the actual GitHub Actions failure from its real log and fix the root cause — do not guess."
todos:
  - id: task-1-overrides
    content: "Regen lockfile for the restored qs/ip-address overrides, rebuild, verify pnpm audit = 0, commit + push"
    status: pending
  - id: task-2-diagnose-ci
    content: "Pull the actual failing Actions run log (gh run list/view), identify the failing workflow + step + root cause — do NOT guess"
    status: pending
  - id: task-3-fix-ci
    content: "Fix the root cause from the log; re-trigger the workflow; confirm green"
    status: pending
  - id: task-4-verify
    content: "Full local gate green + both workflows green on GitHub + Dependabot 0 open; docs/memory note; archive prompt"
    status: pending
isProject: false
---

# Dependabot → 0  +  GitHub Actions root-cause fix

Two close-out tasks on `main`. Task 1 is mechanical and already staged. Task 2 is a **diagnosis** — the failure must come from the real Actions log, not a hypothesis.

## Pre-state (already done, do not redo)

`pnpm-workspace.yaml` already has the two restored overrides (committed-or-staged):

```yaml
overrides:
  qs: ">=6.15.2"
  ip-address: ">=10.1.1"
```

These are the two transitive moderates that survived the 2026-06 refresh: `qs@6.15.1` via `@stryker-mutator/core>typed-rest-client`, `ip-address@10.1.0` via `@modelcontextprotocol/sdk>express-rate-limit`. `pnpm audit --audit-level=high` is already clean; these are the last two moderates (Dependabot #21, #12).

## Task 1 — Land the override restore (mandatory lockfile regen)

**The lockfile MUST be regenerated** — committing the `pnpm-workspace.yaml` override change without it makes `pnpm install --frozen-lockfile` fail in CI (and may be the very thing breaking Actions — see Task 2).

```bash
docker compose run --rm -e CI=true dev install --no-frozen-lockfile
docker compose build dev
docker compose run --rm dev exec pnpm audit          # default level — must show 0 vulnerabilities (moderates included)
docker compose run --rm dev run test                 # confirm 1550/6 still holds after lockfile change
```

- **PASS:** `pnpm audit` reports 0, tests 1550/6.
- If `qs` or `ip-address` still appear: the override didn't take — check `pnpm why qs` / `pnpm why ip-address` for a transitive that pins below the floor and can't be lifted; if genuinely unliftable, that's a real deferral (document it), but the expected outcome is both clear since the patched versions resolve.
- Commit: `deps: restore qs + ip-address overrides — transitive deps still pin vulnerable versions`. Include `pnpm-workspace.yaml` + `pnpm-lock.yaml`. Push.

## Task 2 — Diagnose the GitHub Actions failure from the REAL log

**Do not guess. Pull the actual failure first.** Context already ruled out by inspection: the `allowBuilds` key is correct for pnpm 11 (it replaced `onlyBuiltDependencies` in v11 — verified against pnpm docs, not a bug); the `cost-regression` / `eval-regression` / `protocol-compliance` workflows are Docker-only with no native Node/pnpm setup, so the refresh can't have broken them structurally. The prime suspect is `bollard-verify.yml`, the only workflow with a native-runner path (`pnpm install --frozen-lockfile` → `typecheck` → `lint` on Node 24 / pnpm 11.5.2 before Docker) — but confirm from the log, don't assume.

```bash
gh run list --branch main --limit 10
# identify the failing run + workflow, then:
gh run view <run-id> --log-failed
```

Identify exactly: which workflow, which step, and the root-cause error line. Likely candidates to confirm or rule out against the log:

1. **`pnpm install --frozen-lockfile` mismatch on the runner** — a refresh commit changed a manifest/workspace setting but the committed lockfile doesn't reconcile under native pnpm 11. (If Task 1's regen produces a lockfile diff beyond qs/ip-address, the committed lockfile was already stale — that's likely the CI break, and Task 1 fixes it.)
2. **better-sqlite3 native build on Node 24** — native addon rebuilding against the Node 24 ABI on the runner; missing prebuilt or build-tool issue. Docker masks this if the image cached a working build.
3. **pnpm 11 `strictDepBuilds` (defaults true)** — a build-script dependency not listed in `allowBuilds` errors during native install. Check whether the log names an unapproved build dependency; if so, add it to `allowBuilds` in `pnpm-workspace.yaml`.
4. **A deprecated/renamed npm script or tool flag** — TS 6 / Biome 2 changed a CLI flag that `pnpm run typecheck` / `pnpm run lint` invoke natively.

Fix the **root cause the log shows** — one targeted commit, message naming the actual failure (e.g. `ci: regenerate lockfile to fix frozen-install on runner` or `ci: add <pkg> to allowBuilds for native CI install`). Do not change workflow logic beyond what the error requires.

## Task 3 — Re-trigger and confirm green

```bash
# after pushing Task 1 + Task 2 fixes:
gh run list --branch main --limit 5          # watch the auto-triggered bollard-verify run
gh run watch <run-id>                         # or re-dispatch protocol-compliance if relevant
```

- **bollard-verify** must go green on the push.
- If the fix touched anything `protocol-compliance` guards, confirm that too.
- Do not declare done on a local pass alone — the Actions run itself must be green (that was the gap that let this slip).

## Task 4 — Verify + close out

1. Local full gate green: `typecheck`, `lint`, `test` (1550/6), `audit-docs` exit 0, `pnpm audit` = 0.
2. GitHub: `bollard-verify` green on `main`; Dependabot alerts page shows **0 open**.
3. If Task 2's fix was a lockfile regen or `allowBuilds` addition, add a one-line note to `CLAUDE.md`'s known-limitations/CI section so the next person knows native-runner install has this constraint.
4. Update the dep-refresh DEFERRED table in `spec/archive/dependency-refresh-2026-06.md`: mark qs/ip-address **resolved** (no longer deferred).
5. Archive this prompt → `spec/archive/`. Commit docs.

## Out of scope

- No dependency version changes beyond the two override restores and whatever the CI root cause strictly requires.
- No retag of eval/cost baselines, no agent-prompt or MODEL_REGISTRY changes.
- Do not "fix" the `allowBuilds` key — it is correct for pnpm 11.
- Do not disable or weaken a CI check to make it pass — fix the underlying cause.
