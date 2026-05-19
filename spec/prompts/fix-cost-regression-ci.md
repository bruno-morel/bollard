# Cursor Prompt — Fix cost-regression CI YAML syntax error

> **Context:** `.github/workflows/cost-regression.yml` has a YAML syntax error on line 24 that prevents the workflow from running at all. GitHub Actions rejects it with "Invalid workflow file — You have an error in your yaml syntax on line 24."
>
> **Read CLAUDE.md fully before making any changes.** Then read:
> - `.github/workflows/cost-regression.yml` — the broken file
> - `.github/workflows/eval-regression.yml` — the new sibling workflow (correct syntax to mirror)

---

## The problem

The "Check cost regression" step uses a backslash line continuation inside a `run: |` block scalar:

```yaml
- name: Check cost regression
  run: |
    docker compose run --rm dev sh -c \
      'pnpm --filter @bollard/cli run start -- cost-baseline diff'
```

Backslash continuation is a shell feature, but inside a YAML block scalar (`|`) the YAML parser sees a literal backslash + newline, which produces an invalid shell command. GitHub Actions rejects the file entirely.

---

## The fix

Replace the backslash-continued multi-line command with a single-line `run:` (no block scalar needed):

```yaml
- name: Check cost regression
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  run: >-
    docker compose run --rm dev sh -c
    'pnpm --filter @bollard/cli run start -- cost-baseline diff'
```

Or more simply, since `sh -c` with a single quoted string doesn't need the backslash at all — just put it on one line:

```yaml
- name: Check cost regression
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  run: docker compose run --rm dev sh -c 'pnpm --filter @bollard/cli run start -- cost-baseline diff'
```

Use the single-line form — it's unambiguous and matches how `eval-regression.yml` handles the same pattern.

Note: also add `ANTHROPIC_API_KEY` to the env of this step — `cost-baseline diff` calls `resolveConfig` which requires an API key (same as `eval diff` in `eval-regression.yml`).

---

## Also fix: stale default task

While in the file, update the `workflow_dispatch` default task. `runCount()` is already implemented on `main` — running the pipeline with it produces a degenerate run (coder finds the method already exists). Replace with a fresh method:

```yaml
default: "Add a divide(factor: number): void method to CostTracker that divides the current accumulated total by factor in place. factor must be a positive number; throw RangeError if factor <= 0. Do not modify any other existing methods or tests."
```

Also update the fallback in the `run:` line for the "Run pipeline" step to match:

```yaml
run: ./scripts/bollard-metrics-run.sh "${{ github.event.inputs.task || 'Add a divide(factor: number): void method to CostTracker that divides the current accumulated total by factor in place. factor must be a positive number; throw RangeError if factor <= 0. Do not modify any other existing methods or tests.' }}"
```

---

## Validation

```bash
# No Docker needed — just confirm the YAML parses correctly
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/cost-regression.yml'))" && echo "YAML OK"
```

Then optionally trigger the workflow manually from the GitHub UI to confirm it runs end-to-end.

No CLAUDE.md update needed — the workflow fix is infrastructure, not a new phase.

---

## Constraints

- Edit only `.github/workflows/cost-regression.yml`. No other files.
- Do not change the schedule, job name, artifact upload step, or `bollard-metrics-run.sh` script.
- Do not change `eval-regression.yml`.
- The fix must make the YAML valid — confirm with the Python yaml parse check above.
