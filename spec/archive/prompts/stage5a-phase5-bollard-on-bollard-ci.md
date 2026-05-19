# Cursor Prompt — Stage 5a Phase 5: Bollard-on-Bollard CI

> **Context:** Phases 1–4a are done. `bollard verify --quiet` exits 0/1 with machine-readable JSON on failure. `--ci-passed` lets us skip checks already done by GitHub Actions. Phase 5 wires Bollard's own static verification into CI: every push and every PR runs `bollard verify --quiet` inside the `dev` Docker container, using `--ci-passed` to skip typecheck/lint that GitHub Actions already ran natively.
>
> **Read CLAUDE.md fully before writing any code.** Then read:
> - `.github/workflows/cost-regression.yml` — the only existing workflow; follow the same patterns (checkout@v4, docker compose build dev, docker compose run --rm dev)
> - `packages/cli/src/quiet-verify.ts` — the JSON shape emitted on failure
> - `packages/verify/src/ci-environment.ts` — `CIEnvironment`, provider detection (GitHub Actions = `GITHUB_ACTIONS === "true"`)

---

## What to build

One new file: `.github/workflows/bollard-verify.yml`

No code changes. No new tests. No CLAUDE.md update yet — do that after the workflow is committed and the first real run is validated.

### Workflow design

```yaml
name: Bollard Verify

on:
  push:
    branches: ["main"]
  pull_request:
    branches: ["main"]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Node.js (for native typecheck + lint)
        uses: actions/setup-node@v4
        with:
          node-version: "22"

      - name: Install pnpm
        uses: pnpm/action-setup@v4
        with:
          version: latest

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Typecheck
        run: pnpm run typecheck

      - name: Lint
        run: pnpm run lint

      - name: Build dev image
        run: docker compose build dev

      - name: Bollard verify (skipping typecheck + lint already run above)
        run: |
          docker compose run --rm dev sh -c \
            'pnpm --filter @bollard/cli run start -- verify --quiet --ci-passed typecheck,lint'

      - name: Upload verify result
        uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: bollard-verify-${{ github.run_id }}
          path: .bollard/runs/history.jsonl
```

### Design rationale

**Why run typecheck + lint natively before Docker?**
- Native Node.js runs are 3–5× faster than inside Docker (no container overhead, no image build for these steps).
- `--ci-passed typecheck,lint` then tells Bollard to skip those two — it only runs `audit` and `secretScan` inside the container.
- This avoids paying twice for typecheck/lint while still getting Bollard's audit and secret scanning (which conventional CI doesn't run).

**Why `--quiet`?**
- `bollard verify --quiet` exits 0 on success (no output) and exits 1 on failure (prints JSON to stdout). CI reads the exit code; the JSON is visible in the Actions log for debugging.

**Why `actions/upload-artifact` on `history.jsonl`?**
- On failure, the run history file contains the structured `VerifyRecord` with per-check results. It's the most useful artifact for debugging a CI failure — more structured than raw log output.
- Only uploaded on failure to avoid storing it on every green run.

**Why not run the full `implement-feature` pipeline on every push?**
- That costs ~$2.50 per run and takes ~10 minutes. It belongs in the cost-regression workflow (already on a weekly schedule + manual dispatch). Static verification is instant and free.

**Bootstrap paradox note** (from spec §5a Phase 5):
- The pipeline verifies the *current* Bollard (what's on the branch being verified), not a prior version. For static checks this is fine — we're checking types and lint of the code being merged, not running it against itself.

---

## CLAUDE.md update

Find the `### Stage 5a Phase 4a (DONE)` entry. After it add:

```
### Stage 5a Phase 5 (DONE) — Bollard-on-Bollard CI:

`.github/workflows/bollard-verify.yml`: triggers on push/PR to `main`. Runs typecheck + lint natively (fast), then `bollard verify --quiet --ci-passed typecheck,lint` inside the `dev` Docker container (runs audit + secretScan only — skips what was already run). Exits 1 on failure; uploads `.bollard/runs/history.jsonl` as an artifact on failure for structured per-check debugging. Cost: $0 (no LLM calls). The full `implement-feature` pipeline CI is in `cost-regression.yml` (weekly + manual dispatch).
```

Also update the roadmap line: mark Phase 5 DONE, Next → Phase 4b (adversarial test promotion) or Phase 6 (protocol compliance CI).

---

## Validation

Since this is a GitHub Actions workflow, local validation is limited. Verify the YAML is syntactically valid:

```bash
docker compose run --rm dev sh -c \
  'node -e "require(\"js-yaml\").load(require(\"fs\").readFileSync(\".github/workflows/bollard-verify.yml\",\"utf8\")); console.log(\"YAML valid\")"' \
  2>/dev/null || \
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/bollard-verify.yml')); print('YAML valid')"
```

Then confirm the file is committed and push to main — the first real validation is watching the Actions tab on GitHub.

---

## Constraints

- Do NOT run `pnpm run test` (Vitest) in this workflow — tests are expensive in CI and are already run by developers locally and by the cost-regression pipeline.
- Do NOT add `workflow_dispatch` — this workflow runs on every push/PR automatically. Manual dispatch belongs to cost-regression only.
- Do NOT cache Docker layers in this first version — keep it simple. Docker layer caching can be added later if the `docker compose build dev` step becomes a bottleneck.
- The `--ci-passed typecheck,lint` list must match the check names Bollard uses internally (`typecheck` and `lint` — not `tsc` or `biome`). Verified in Phase 4a.
- Do not add any new source files, tests, or dependencies. This phase is exactly one YAML file + CLAUDE.md update.
