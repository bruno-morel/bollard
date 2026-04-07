# Stage 2 — Validation Prompt (Test Suite + Milestone Check + Retro-Adversarial Pass)

> Paste this into Cursor's Composer. Read `CLAUDE.md` at the repo root for full context. Read `spec/02-bootstrap.md` Stage 2 "Milestone check" section and `spec/07-adversarial-scopes.md` for the adversarial testing design.

---

## Prompt

I'm building **Bollard**, an artifact integrity framework for AI-assisted software development. Read `CLAUDE.md` for full context.

Stage 2 code is complete and committed. This prompt runs the **three validation steps** that confirm Stage 2 is done:

1. **Test suite** — confirm all 340+ tests pass, fix any regressions
2. **Milestone check** — run the full 12-node `implement-feature` pipeline end-to-end on the Bollard repo itself
3. **Retro-adversarial pass** — run the tester agent against Stage 0/1/1.5 packages and compare to hand-written tests

All commands run via Docker Compose. Never run bare `pnpm`, `node`, `vitest`, or `biome` on the host.

### What exists today

- **8 packages:** engine, llm, agents, verify, blueprints, detect, cli, mcp
- **29 test files, 340 tests**, all reported passing at last commit
- **~5950 source LOC, ~4650 test LOC (+~7670 adversarial), ~201 prompt LOC**
- **12-node `implement-feature` blueprint** with Docker-isolated adversarial verification
- **3 agents:** planner (read-only, 25 turns), coder (6 tools, 60 turns), tester (no tools, 5 turns)
- **3 LLM providers:** Anthropic, OpenAI, Google
- **SignatureExtractor** with `TsCompilerExtractor` (TS) and `LlmFallbackExtractor` (all other languages)
- **Docker images:** `Dockerfile.verify`, `Dockerfile.verify-python`, `Dockerfile.verify-go`, `Dockerfile.verify-rust`
- **Adversarial test lifecycle:** ephemeral (default) + persistent-native (opt-in)
- **MCP server** with 6 tools (verify, plan, implement, eval, config, profile)

### Validation order

Complete each step fully before moving to the next.

---

### Step 1: Run the full test suite

Run all tests and fix any failures:

```bash
docker compose run --rm dev run test
```

**Expected:** 340+ tests pass, 0 failures (2 may be skipped — live API smoke tests for OpenAI/Google that skip when `OPENAI_API_KEY`/`GOOGLE_API_KEY` are not set).

If any tests fail:
1. Read the failure output carefully
2. Fix the root cause (not the test) unless the test itself is wrong
3. Re-run `docker compose run --rm dev run test` until all pass
4. Run typecheck + lint too: `docker compose run --rm dev run typecheck && docker compose run --rm dev run lint`

Also run the adversarial test suite:

```bash
docker compose run --rm dev pnpm exec vitest run --config vitest.adversarial.config.ts
```

**Do NOT proceed to Step 2 until Step 1 is green.**

---

### Step 2: Milestone check — end-to-end pipeline run

This is the spec's acceptance test (from `spec/02-bootstrap.md` lines 470–485). Run the full `implement-feature` pipeline against Bollard's own codebase.

**2a: Build the verify images first:**

```bash
docker build -t bollard/verify:latest -f docker/Dockerfile.verify .
```

If building the other language images is needed for your test:
```bash
docker build -t bollard/verify-python:latest -f docker/Dockerfile.verify-python .
docker build -t bollard/verify-go:latest -f docker/Dockerfile.verify-go .
docker build -t bollard/verify-rust:latest -f docker/Dockerfile.verify-rust .
```

**2b: Run the TypeScript milestone:**

```bash
docker compose run --rm dev --filter @bollard/cli run start -- run implement-feature \
  --task "Add a configurable request timeout to the LLM client that defaults to 30s and throws LLM_TIMEOUT on expiry"
```

This triggers the full 12-node pipeline:
1. Create branch → 2. Planner explores codebase, produces JSON plan → 3. Human approves plan → 4. Coder implements → 5. Static checks → 6. Extract type signatures → 7. Tester generates adversarial tests → 8. Write tests → 9. Run tests → 10. Docker-isolated verify → 11. Generate diff → 12. Human approves PR

**What to watch for at each node:**

- **Node 2 (generate-plan):** The planner should produce a structured JSON plan with `summary`, `acceptance_criteria`, `affected_files`, `risk_assessment`, `steps`. It should identify `packages/llm/src/client.ts` and/or provider files as affected.
- **Node 4 (implement):** The coder should modify existing files using `edit_file` (not rewrite them with `write_file`). Watch the tool calls — if it's rewriting whole files, the `edit_file` tool or coder prompt needs tuning.
- **Node 5 (static-checks):** `pnpm run typecheck` and `pnpm run lint` should pass. If they fail, the coder's verification hook should have caught this during implementation — if it didn't, note that as a bug.
- **Node 6 (extract-signatures):** Should use `TsCompilerExtractor` (not the LLM fallback) since this is a TypeScript project. The output should contain function signatures without implementation bodies.
- **Node 7 (generate-tests):** The tester agent should produce a Vitest test file. It should NOT reference private identifiers or implementation details — it only sees signatures + acceptance criteria.
- **Node 8 (write-tests):** The information leak check should pass (no private identifiers in test output). The test file should land in the adversarial test directory (derived via `deriveAdversarialTestPath`).
- **Node 9 (run-tests):** Both the project's own tests AND the adversarial tests should pass. If adversarial tests fail, that's actually a good sign (they found something), but the pipeline will report failure.
- **Node 10 (docker-verify):** Should generate a `compose.verify.yml` and run Docker-isolated verification. If Docker-in-Docker is unavailable, this node degrades gracefully (returns `{ skipped: true, reason: "docker not available" }`).

**If any node fails:**
1. Note which node failed and the error
2. Diagnose whether it's a code bug, prompt issue, or environment problem
3. Fix it
4. Run the pipeline again from scratch (it creates a new branch each time)

**2c: If you have access to a Python project:**

Create a minimal Python project to test the cross-language pipeline:

```bash
mkdir -p /tmp/bollard-python-test
cd /tmp/bollard-python-test

# Create minimal Python project structure
cat > pyproject.toml << 'EOF'
[project]
name = "bollard-test-api"
version = "0.1.0"
requires-python = ">=3.11"

[tool.pytest.ini_options]
testpaths = ["tests"]

[tool.ruff]
line-length = 100
EOF

mkdir -p src/bollard_test tests

cat > src/bollard_test/__init__.py << 'EOF'
EOF

cat > src/bollard_test/rate_limiter.py << 'EOF'
import time
from collections import defaultdict


class RateLimiter:
    """Token bucket rate limiter."""

    def __init__(self, max_requests: int, window_seconds: float):
        if max_requests <= 0:
            raise ValueError("max_requests must be positive")
        if window_seconds <= 0:
            raise ValueError("window_seconds must be positive")
        self._max = max_requests
        self._window = window_seconds
        self._buckets: dict[str, list[float]] = defaultdict(list)

    def allow(self, key: str) -> bool:
        """Return True if the request is allowed, False if rate-limited."""
        now = time.monotonic()
        bucket = self._buckets[key]
        # Evict expired entries
        self._buckets[key] = [t for t in bucket if now - t < self._window]
        if len(self._buckets[key]) >= self._max:
            return False
        self._buckets[key].append(now)
        return True

    def remaining(self, key: str) -> int:
        """Return remaining requests in the current window."""
        now = time.monotonic()
        bucket = self._buckets[key]
        active = [t for t in bucket if now - t < self._window]
        return max(0, self._max - len(active))

    def reset(self, key: str | None = None) -> None:
        """Reset one or all rate-limit buckets."""
        if key is None:
            self._buckets.clear()
        else:
            self._buckets.pop(key, None)
EOF

cat > tests/__init__.py << 'EOF'
EOF

cat > tests/test_rate_limiter.py << 'EOF'
from bollard_test.rate_limiter import RateLimiter


def test_allows_under_limit():
    rl = RateLimiter(max_requests=3, window_seconds=10.0)
    assert rl.allow("user1") is True
    assert rl.allow("user1") is True
    assert rl.allow("user1") is True


def test_blocks_over_limit():
    rl = RateLimiter(max_requests=2, window_seconds=10.0)
    assert rl.allow("user1") is True
    assert rl.allow("user1") is True
    assert rl.allow("user1") is False
EOF

# Initialize git
git init && git add -A && git commit -m "Initial Python project"
```

Then run Bollard against it:

```bash
cd /path/to/bollard
docker compose run --rm dev --filter @bollard/cli run start -- run implement-feature \
  --task "Add rate limiting middleware" \
  --work-dir /tmp/bollard-python-test
```

Watch for:
- `detectToolchain` should identify Python, pytest, ruff
- `extract-signatures` should use `LlmFallbackExtractor` (not the TS compiler)
- `generate-tests` should produce pytest-style tests (not Vitest)
- `write-tests` should place the file with `test_adversarial_` prefix
- `docker-verify` should attempt to generate a `compose.verify.yml` with `bollard/verify-python` image

**Do NOT proceed to Step 3 until at least the TypeScript milestone (2b) completes successfully.**

---

### Step 3: Retro-adversarial pass

This is the "compiler compiling itself" moment. Run the tester agent against Bollard's Stage 0/1/1.5 packages and compare the generated tests to the hand-written ones.

**3a: Extract signatures for each core package:**

The signature extractor runs as part of the pipeline, but we need to run it standalone. Create a small script:

```bash
cat > /tmp/retro-adversarial.ts << 'SCRIPT'
import { resolve } from "node:path"
import { readdir, writeFile, mkdir } from "node:fs/promises"
import { TsCompilerExtractor } from "@bollard/verify/src/type-extractor.js"
import { createTesterAgent } from "@bollard/agents/src/tester.js"
import { executeAgent } from "@bollard/agents/src/executor.js"
import { LLMClient } from "@bollard/llm/src/client.js"
import { detectToolchain } from "@bollard/detect/src/detect.js"

const WORK_DIR = resolve(process.cwd())
const PACKAGES = ["engine", "llm", "agents", "verify", "detect"]
const OUTPUT_DIR = resolve(WORK_DIR, ".bollard", "retro-adversarial")

const config = {
  llm: {
    default: {
      provider: process.env.BOLLARD_PROVIDER ?? "anthropic",
      model: process.env.BOLLARD_MODEL ?? "claude-sonnet-4-20250514",
    },
  },
  agent: { max_cost_usd: 20, max_duration_minutes: 60 },
}

async function getSourceFiles(pkgDir: string): Promise<string[]> {
  const srcDir = resolve(pkgDir, "src")
  const entries = await readdir(srcDir, { recursive: true })
  return (entries as string[])
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
    .map((f) => resolve(srcDir, f))
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true })

  const profile = await detectToolchain(WORK_DIR)
  const extractor = new TsCompilerExtractor()
  const client = new LLMClient(config as any)
  const { provider, model } = client.forAgent("tester")
  const tester = await createTesterAgent(profile)

  const results: Record<string, { testCode: string; cost: number }> = {}

  for (const pkg of PACKAGES) {
    const pkgDir = resolve(WORK_DIR, "packages", pkg)
    console.log(`\n--- Extracting signatures: @bollard/${pkg} ---`)

    const files = await getSourceFiles(pkgDir)
    if (files.length === 0) {
      console.log(`  No source files found, skipping`)
      continue
    }

    const { signatures, types } = await extractor.extract(files, profile)
    console.log(`  ${signatures.length} file(s), ${types.length} type(s)`)

    // Build the tester message (same format as buildTesterMessage in agent-handler.ts)
    const sections: string[] = [
      "# Task",
      `Generate adversarial tests for the @bollard/${pkg} package`,
      "",
      "# Acceptance Criteria",
      `1. Tests exercise the public API of @bollard/${pkg}`,
      "2. Tests include negative/boundary cases",
      "3. Tests include property-based tests where applicable",
      "4. Tests do NOT reference private identifiers or implementation details",
      "",
      "# Public API Surface (signatures only — implementation bodies stripped)",
      "",
    ]

    for (const sig of signatures) {
      sections.push(`## ${sig.filePath}`, "")
      if (sig.imports) sections.push("### Imports", `\`\`\`typescript\n${sig.imports}\n\`\`\``, "")
      if (sig.types) sections.push("### Types", `\`\`\`typescript\n${sig.types}\n\`\`\``, "")
      if (sig.signatures) sections.push("### Signatures", `\`\`\`typescript\n${sig.signatures}\n\`\`\``, "")
    }

    if (types.length > 0) {
      sections.push("# Referenced Type Definitions", "")
      for (const t of types) {
        sections.push(`\`\`\`typescript\n${t.definition}\n\`\`\``, "")
      }
    }

    sections.push(
      "# Instructions",
      "Write a complete Vitest test file. Output ONLY the TypeScript test code, no explanations.",
    )

    const message = sections.join("\n")

    console.log(`  Running tester agent for @bollard/${pkg}...`)
    const result = await executeAgent(
      tester,
      message,
      provider,
      model,
      { pipelineCtx: { runId: `retro-${pkg}`, task: `adversarial tests for ${pkg}`, blueprintId: "retro", config: config as any, currentNode: pkg, results: {}, changedFiles: [], costTracker: { add: () => {}, total: () => 0, exceeded: () => false, remaining: () => 20 }, log: { info: console.log, warn: console.warn, error: console.error, debug: () => {} }, upgradeRunId: () => {} } as any, workDir: WORK_DIR },
    )

    console.log(`  Done. ${result.turns} turns, $${result.totalCostUsd.toFixed(4)}`)

    const outputFile = resolve(OUTPUT_DIR, `${pkg}.adversarial.test.ts`)
    await writeFile(outputFile, result.response, "utf-8")
    results[pkg] = { testCode: result.response, cost: result.totalCostUsd }
  }

  // Summary
  console.log("\n\n=== RETRO-ADVERSARIAL SUMMARY ===\n")
  let totalCost = 0
  for (const [pkg, { cost }] of Object.entries(results)) {
    console.log(`@bollard/${pkg}: $${cost.toFixed(4)}`)
    totalCost += cost
  }
  console.log(`\nTotal cost: $${totalCost.toFixed(4)}`)
  console.log(`Output directory: ${OUTPUT_DIR}`)
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
SCRIPT
```

Then run it:

```bash
docker compose run --rm dev pnpm exec tsx /tmp/retro-adversarial.ts
```

Alternatively, copy the script into the project root and run it from there:

```bash
cp /tmp/retro-adversarial.ts ./retro-adversarial.ts
docker compose run --rm dev pnpm exec tsx retro-adversarial.ts
rm retro-adversarial.ts  # clean up after
```

This will generate one adversarial test file per package in `.bollard/retro-adversarial/`.

**3b: Compare adversarial vs hand-written tests:**

For each package, compare the generated adversarial test to the existing hand-written tests:

```bash
# Side-by-side comparison
for pkg in engine llm agents verify detect; do
  echo "=== @bollard/$pkg ==="
  echo "Hand-written test files:"
  ls packages/$pkg/tests/*.test.ts 2>/dev/null | head -5
  echo ""
  echo "Adversarial test:"
  head -50 .bollard/retro-adversarial/$pkg.adversarial.test.ts 2>/dev/null || echo "(not generated)"
  echo ""
  echo "---"
done
```

**What you're looking for:**

1. **Coverage divergence:** The adversarial tests should cover scenarios the hand-written tests miss. If they're testing exactly the same things in the same way, the tester prompt is too predictable — it needs more adversarial pressure.

2. **Information leak:** The adversarial tests should NOT reference private identifiers (`_total`, `_limit`, private helper functions). If they do, the information barrier is broken — check that the signature extractor is properly stripping implementation bodies.

3. **Meaningful negative tests:** The adversarial tests should include negative/boundary cases (null inputs, empty strings, zero values, overflow, concurrent access). If they're all happy-path tests, the tester prompt needs to emphasize adversarial intent.

4. **Property-based tests:** The tester prompt asks for fast-check property-based tests. Check if the output includes `fc.property`, `fc.assert` patterns.

5. **Test quality:** Can the adversarial tests actually run? Try:
   ```bash
   docker compose run --rm dev pnpm exec vitest run .bollard/retro-adversarial/engine.adversarial.test.ts
   ```
   If they fail, categorize why:
   - **Import errors** → the extractor gave wrong file paths
   - **Type errors** → the extractor gave incomplete signatures
   - **Runtime failures** → the tests found an actual bug (good!)
   - **Trivial failures** → the tester generated broken tests (prompt issue)

**3c: Report findings**

Create a summary file:

```bash
cat > .bollard/retro-adversarial/SUMMARY.md << 'EOF'
# Retro-Adversarial Pass — Stage 2 Validation

## Date
(fill in)

## Packages tested
- @bollard/engine
- @bollard/llm
- @bollard/agents
- @bollard/verify
- @bollard/detect

## Findings per package

### @bollard/engine
- Coverage divergence: (describe what the adversarial tests cover that hand-written ones don't)
- Information leaks: (any private identifiers referenced?)
- Test quality: (do they run? what errors?)
- New bugs found: (list any)

### @bollard/llm
(same structure)

### @bollard/agents
(same structure)

### @bollard/verify
(same structure)

### @bollard/detect
(same structure)

## Overall assessment
- Tester prompt quality: (1-5, with notes)
- Signature extractor quality: (1-5, with notes)
- Information barrier integrity: (pass/fail)
- Bugs found: (total count)
- Prompt tuning needed: (yes/no, what to change)

## Cost
- Total LLM cost for retro-adversarial pass: $X.XX
- Per-package breakdown: (from script output)

## Action items
- [ ] (list any fixes or prompt improvements needed before declaring Stage 2 done)
EOF
```

Fill in the summary with actual findings.

---

### Step 4: Fix anything broken and commit

After all three steps are done:

1. **If tests failed in Step 1:** Fix them, re-run, commit the fixes.
2. **If the pipeline failed in Step 2:** Fix the root cause, re-run the pipeline. Common issues:
   - Coder rewrites whole files instead of using `edit_file` → tighten coder prompt
   - Tester references implementation details → check extractor output
   - Static checks fail after coder finishes → verification hook might not be triggering
   - Docker-verify fails → check Docker-in-Docker setup (`docker.sock` mount in `compose.yaml`)
3. **If the retro-adversarial pass reveals issues in Step 3:** Fix them and add the findings to the summary.

Commit convention:
```bash
git add -A
git commit -m "Stage 2: validation — test suite green, milestone check passed, retro-adversarial findings

- (list key findings/fixes)
"
```

Update `CLAUDE.md` with:
- Updated test count if it changed
- Any issues found and fixed
- The retro-adversarial summary (brief version — full version in `.bollard/retro-adversarial/SUMMARY.md`)

---

### Done criteria

Stage 2 is validated when ALL of the following are true:

- [ ] `docker compose run --rm dev run test` — all tests pass
- [ ] `docker compose run --rm dev run typecheck` — clean
- [ ] `docker compose run --rm dev run lint` — clean
- [ ] The `implement-feature` pipeline runs end-to-end on a TypeScript project (at minimum through node 9, `run-tests`)
- [ ] The adversarial tester produces meaningful, non-trivial tests that differ from hand-written ones
- [ ] The information barrier holds (no private identifiers in adversarial test output)
- [ ] `.bollard/retro-adversarial/SUMMARY.md` exists with findings
- [ ] All fixes are committed
