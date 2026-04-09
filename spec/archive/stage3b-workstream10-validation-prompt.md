# Stage 3b — Workstream 10: Final validation + results document

> **Scope:** comprehensive validation of all Stage 3b deliverables. Run the standard static checks, then exercise the polyglot stack with targeted checks for each new capability. Write `spec/stage3b-validation-results.md` documenting every check. This is the stage sign-off — after this, Stage 3b is GREEN or RED with an action list.

## Pre-validation: baseline

```bash
docker compose build dev
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

Record the baseline. Expected: `523 passed / 2 skipped`, typecheck clean, lint clean. If anything fails before the checks begin, stop and fix — the baseline must be green.

## Check 1 — Dev image integrity

Verify that helper binaries are on PATH and functional in the `dev` image:

```bash
docker compose run --rm dev sh -c 'bollard-extract-go --version && bollard-extract-rs --version'
```

Expected: both print a version string and exit 0.

Also verify Python is available:

```bash
docker compose run --rm dev sh -c 'python3 --version'
```

Record versions.

## Check 2 — `dev-full` image (compose profile `full`)

```bash
docker compose --profile full build dev-full
docker compose --profile full run --rm dev-full sh -c 'go version && rustc --version && python3 --version && pytest --version && ruff --version'
```

Record versions and image size (`docker image ls` for `bollard-dev-full`).

## Check 3 — Extractors (all four languages)

Test that each deterministic extractor produces meaningful output from a real file:

**TypeScript** (built-in compiler extractor — baseline):
```bash
docker compose run --rm dev sh -c 'pnpm --filter @bollard/verify run test -- --grep "TsCompilerExtractor" --reporter=verbose 2>&1 | tail -20'
```

**Python:**
```bash
docker compose run --rm dev sh -c 'pnpm --filter @bollard/verify run test -- --grep "PythonAstExtractor" --reporter=verbose 2>&1 | tail -20'
```

**Go:**
```bash
docker compose run --rm dev sh -c 'pnpm --filter @bollard/verify run test -- --grep "GoAstExtractor" --reporter=verbose 2>&1 | tail -20'
```

**Rust:**
```bash
docker compose run --rm dev sh -c 'pnpm --filter @bollard/verify run test -- --grep "RustSynExtractor" --reporter=verbose 2>&1 | tail -20'
```

All four must pass. Record per-language test counts.

## Check 4 — Helper binary integration

```bash
docker compose run --rm dev sh -c 'pnpm --filter @bollard/verify run test -- --grep "extractor-helpers" --reporter=verbose 2>&1 | tail -20'
```

These are the unconditional helper tests from WS1. Record count.

## Check 5 — Contract graph providers (all four languages)

Test that each `ContractGraphProvider` produces correct output:

```bash
docker compose run --rm dev sh -c 'pnpm --filter @bollard/verify run test -- --grep "ContractGraphProvider\|TypeScriptContractProvider\|PythonContractProvider\|GoContractProvider\|RustContractProvider\|buildContractContext" --reporter=verbose 2>&1 | tail -40'
```

Record per-provider test counts. Every provider must pass all its cases.

## Check 6 — Contract graph on Bollard itself (TypeScript baseline)

```bash
docker compose run --rm dev --filter @bollard/cli run start -- contract 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(f'Modules: {len(data[\"modules\"])}')
print(f'Edges: {len(data[\"edges\"])}')
print(f'Affected edges: {len(data[\"affectedEdges\"])}')
for m in data['modules']:
    print(f'  {m[\"id\"]}: {len(m[\"publicExports\"])} exports, lang={m[\"language\"]}')
"
```

Expected: 8 modules (the @bollard/* packages), ~18 edges, all `language: "typescript"`. This is the same output as the Stage 3a baseline — should be identical or larger if new exports were added.

## Check 7 — Risk gate (polyglot)

```bash
docker compose run --rm dev sh -c 'pnpm --filter @bollard/blueprints run test -- --grep "scanDiffForExportChanges" --reporter=verbose 2>&1 | tail -30'
```

Record test count. Must include the new Python/Go/Rust cases from WS8.

## Check 8 — Test summary parsers (polyglot)

```bash
docker compose run --rm dev sh -c 'pnpm --filter @bollard/verify run test -- --grep "parseSummary" --reporter=verbose 2>&1 | tail -30'
```

Record test count. Must include Vitest, pytest, `go test`, and `cargo test` cases from WS8.

## Check 9 — `implement-feature` self-test (TypeScript)

Re-run the Stage 3a GREEN baseline against the same CostTracker task. This is the most important check — it exercises the full 18-node pipeline end-to-end.

**Before running:** verify no leftover `subtract()` state on disk:
```bash
docker compose run --rm dev sh -c 'grep -c "subtract" packages/engine/src/cost-tracker.ts || echo "clean"'
```

If `subtract` already exists (from the Stage 3a golden corpus), temporarily remove it as the sanity checkpoint did. Record the pre-run state.

**Run:**
```bash
docker compose run --rm -e BOLLARD_AUTO_APPROVE=1 dev sh -c \
  'pnpm --filter @bollard/cli run start -- run implement-feature --task "Add a subtract(amount: number) method to CostTracker that subtracts the given USD amount from the running total. Throw on negative input or underflow. Include basic validation and update snapshot() to reflect the subtracted cost." --work-dir /app'
```

Record:
- Node count: expect 18/18
- Retries: expect 0
- `verify-claim-grounding`: proposed / grounded / dropped
- `contract_grounding_result` log event: proposed / grounded / dropped / dropRate
- Coder turn usage: X/60
- Cost: $X.XX
- Duration: Xm Xs
- Surviving contract test file path + line count

**After run:** clean up (git checkout, branch delete, remove .bollard artifacts). Verify test count returns to 523.

## Check 10 — Contract graph providers on real fixtures (Python, Go, Rust)

These are **not** full `implement-feature` runs (those require LLM spend against real project code). Instead, exercise the contract providers against small fixture projects in temp dirs to verify they produce non-empty graphs.

Create three temp-dir fixtures and run `buildContractContext` against each:

**Python fixture:**
```bash
docker compose run --rm dev sh -c '
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/packages/alpha" "$TMPDIR/packages/beta"
echo "[project]
name = \"alpha\"" > "$TMPDIR/packages/alpha/pyproject.toml"
echo "from .core import greet" > "$TMPDIR/packages/alpha/__init__.py"
echo "def greet(name: str) -> str:
    return f\"Hello {name}\"" > "$TMPDIR/packages/alpha/core.py"
echo "[project]
name = \"beta\"" > "$TMPDIR/packages/beta/pyproject.toml"
echo "import alpha
def handle():
    return alpha.greet(\"world\")" > "$TMPDIR/packages/beta/__init__.py"
pnpm --filter @bollard/cli run start -- contract --work-dir "$TMPDIR" 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(f\"Python: {len(data['modules'])} modules, {len(data['edges'])} edges\")
for m in data[\"modules\"]:
    print(f\"  {m['id']}: {len(m['publicExports'])} exports\")
"
rm -rf "$TMPDIR"
'
```

Expected: 2 modules, ≥1 edge.

**Go fixture:**
```bash
docker compose run --rm dev sh -c '
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/svc/auth" "$TMPDIR/svc/billing"
echo "go 1.22
use (
    ./svc/auth
    ./svc/billing
)" > "$TMPDIR/go.work"
echo "module example.com/app/svc/auth
go 1.22" > "$TMPDIR/svc/auth/go.mod"
echo "package auth
func Login(user string) error { return nil }" > "$TMPDIR/svc/auth/auth.go"
echo "module example.com/app/svc/billing
go 1.22" > "$TMPDIR/svc/billing/go.mod"
printf "package billing\nimport \"example.com/app/svc/auth\"\nfunc Charge() { auth.Login(\"x\") }" > "$TMPDIR/svc/billing/billing.go"
pnpm --filter @bollard/cli run start -- contract --work-dir "$TMPDIR" 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(f\"Go: {len(data['modules'])} modules, {len(data['edges'])} edges\")
for m in data[\"modules\"]:
    print(f\"  {m['id']}: {len(m['publicExports'])} exports\")
"
rm -rf "$TMPDIR"
'
```

Expected: 2 modules, ≥1 edge.

**Rust fixture:**
```bash
docker compose run --rm dev sh -c '
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/crates/auth/src" "$TMPDIR/crates/billing/src"
echo "[workspace]
members = [\"crates/auth\", \"crates/billing\"]" > "$TMPDIR/Cargo.toml"
printf "[package]\nname = \"auth\"\nversion = \"0.1.0\"\nedition = \"2021\"" > "$TMPDIR/crates/auth/Cargo.toml"
echo "pub fn login(user: &str) -> bool { true }" > "$TMPDIR/crates/auth/src/lib.rs"
printf "[package]\nname = \"billing\"\nversion = \"0.1.0\"\nedition = \"2021\"" > "$TMPDIR/crates/billing/Cargo.toml"
printf "use auth::login;\npub fn charge() { login(\"x\"); }" > "$TMPDIR/crates/billing/src/lib.rs"
pnpm --filter @bollard/cli run start -- contract --work-dir "$TMPDIR" 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(f\"Rust: {len(data['modules'])} modules, {len(data['edges'])} edges\")
for m in data[\"modules\"]:
    print(f\"  {m['id']}: {len(m['publicExports'])} exports\")
"
rm -rf "$TMPDIR"
'
```

Expected: 2 modules, ≥1 edge.

If any fixture returns 0 modules or 0 edges when expected, that's a regression — investigate before marking GREEN.

**Important:** these fixture tests exercise `bollard contract --work-dir <dir>`. The CLI's `contract` command calls `buildContractContext` which routes to the correct provider based on `detectToolchain(workDir)`. This validates the full stack: detection → provider selection → extraction → graph assembly → JSON output.

For the Go and Rust fixtures, `detectToolchain` will return `"go"` / `"rust"` because it finds `go.mod` / `Cargo.toml`. The Python fixture is trickier — `detectToolchain` looks for `pyproject.toml` at the root; the fixture has it in subdirs. Two options:
- Add a root `pyproject.toml` to the Python fixture (simplest)
- Or note that the CLI's `contract` command may not detect Python correctly for this layout and test via unit tests only

Use your judgment. If the CLI can't detect the language for the fixture layout, note it as a known gap and test the provider directly via the unit tests (which already passed in Check 5).

## Check 11 — ADR-0002 exists and renders

```bash
docker compose run --rm dev sh -c 'ls spec/adr/ && head -5 spec/adr/0002-*.md'
```

Verify the file exists and has correct frontmatter.

## Check 12 — File structure audit

Verify the `contract-providers/` split is clean:

```bash
docker compose run --rm dev sh -c '
echo "=== contract-extractor.ts (barrel) ==="
wc -l packages/verify/src/contract-extractor.ts
echo ""
echo "=== contract-providers/ ==="
wc -l packages/verify/src/contract-providers/*.ts
echo ""
echo "=== No stale monolith ==="
grep -c "class TypeScriptContractProvider" packages/verify/src/contract-extractor.ts || echo "clean (not in barrel)"
'
```

Expected: barrel is ~10 lines, providers are in separate files, no provider class in the barrel.

## Writing the results document

After all checks, create `spec/stage3b-validation-results.md` with:

1. **Header** — date, image versions, baseline test count
2. **Per-check results** — Pass/Fail + evidence (command output snippets, counts)
3. **Stage 3b commit log** — list all WS1–WS10 commit SHAs with one-line summaries
4. **Known gaps** — anything intentionally deferred to Stage 3c/4
5. **Final status** — GREEN (all checks pass) or RED (with action list)

Follow the format of `spec/stage3a-validation-results.md` — table-driven where possible, prose for narrative checks.

## CLAUDE.md final update

After writing the validation results:

- **Test count** — final authoritative number (should still be 523/2 after cleanup)
- **"Stage 3a → Stage 3b follow-ups"** — mark all completed items as Done with workstream references. The only remaining open items should be clearly labeled as Stage 3c/4.
- **"Current Test Stats"** section — update the "Latest count" line with the post-WS10 number and date
- **"Stage 3b Validation" section** — add a new section parallel to "Stage 3a Validation" with the date, status, and link to `spec/stage3b-validation-results.md`
- **File tree** — verify the `contract-providers/` directory is reflected

## Commit

```
Stage 3b: validation results + CLAUDE.md final update

- spec/stage3b-validation-results.md: 12-check validation report
- CLAUDE.md: Stage 3b validation section, test counts, follow-up
  items marked Done, file tree updated

Stage 3b status: GREEN / RED (fill in after checks)
```

## Reporting back

Fill in this template:

```
Stage 3b validation: [DATE]

Baseline:  [N] passed / 2 skipped, typecheck clean, lint clean

Check 1  — Dev image helpers:     PASS/FAIL
Check 2  — dev-full image:        PASS/FAIL  (size: X.XX GB)
Check 3  — Extractors (4 langs):  PASS/FAIL  (TS:N Go:N Py:N Rs:N)
Check 4  — Helper binaries:       PASS/FAIL
Check 5  — Contract providers:    PASS/FAIL  (TS:N Py:N Go:N Rs:N)
Check 6  — Contract graph (self): PASS/FAIL  (modules:N edges:N)
Check 7  — Risk gate polyglot:    PASS/FAIL  (N tests)
Check 8  — Test parsers:          PASS/FAIL  (N tests)
Check 9  — implement-feature:     PASS/FAIL  (nodes:X/X, grounding:N/M/D, cost:$X.XX)
Check 10 — Contract fixtures:     PASS/FAIL  (Py:N/N Go:N/N Rs:N/N modules/edges)
Check 11 — ADR-0002:              PASS/FAIL
Check 12 — File structure:        PASS/FAIL  (barrel:N lines)

Post-cleanup test count: [N] passed / 2 skipped

Status: GREEN / RED
If RED: [action list]
```
