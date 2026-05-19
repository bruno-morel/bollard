# Cursor Prompt — Pipeline Hardening (Post Stage 4c Part 1)

> **Purpose:** Four small, independent fixes that harden the Bollard pipeline. Each was surfaced by the bollard-on-bollard self-test (2026-04-17). None are blocking — they reduce wasted turns, manual cleanup, and spurious failures on future runs.

---

## Context

You are working in the Bollard project. **Read `CLAUDE.md` at the project root first** — it is the source of truth for conventions, architecture, and constraints.

**All commands go through Docker Compose. Never run bare pnpm/node/tsc on the host.**

---

## Fix 1: Auto-format generated adversarial test files

### Problem

The `write-tests`, `write-contract-tests`, and `write-behavioral-tests` blueprint nodes write LLM-generated test files to disk. These files often fail Biome lint/format because the LLM doesn't match Biome's exact style (import ordering, trailing commas, semicolons). This causes either:
- The `static-checks` node to fail (if it runs after write)
- Manual `biome check --write` cleanup after every pipeline run

### Fix

In `packages/blueprints/src/implement-feature.ts`, add a Biome format call after each file write in the three write nodes. Use `execFile` (not shell) with `biome check --write --unsafe <path>`. The `--unsafe` flag is needed because some LLM-generated import orderings require unsafe fixes.

**Locations (find by searching for the string pattern, not line numbers which may have shifted):**

1. **`write-tests` node** — after `await writeFile(fullPath, cleanOutput, "utf-8")`, before the return. Search for `id: "write-tests"` to find the node.

2. **`write-contract-tests` node** — after `await writeFile(fullPath, fileContent, "utf-8")`, before the return. Search for `id: "write-contract-tests"`.

3. **`write-behavioral-tests` node** — after `await writeFile(fullPath, fileContent, "utf-8")`, before the return. Search for `id: "write-behavioral-tests"`.

**Implementation pattern (same for all three):**

```typescript
// After writeFile, before return — format the generated file
try {
  await execFileAsync("biome", ["check", "--write", "--unsafe", fullPath], {
    cwd: workDir,
    timeout: 15_000,
  })
  ctx.log.debug?.(`Formatted ${fullPath}`)
} catch {
  // Non-fatal: if biome isn't available or the file has unfixable issues,
  // static-checks will catch it. Don't block the pipeline here.
  ctx.log.debug?.(`Biome format skipped for ${fullPath}`)
}
```

You'll need to add `execFileAsync` import if it's not already imported in implement-feature.ts. Use the same `promisify(execFile)` pattern used in other files:

```typescript
import { execFile } from "node:child_process"
import { promisify } from "node:util"
const execFileAsync = promisify(execFile)
```

**Important:** The format call must be non-fatal (wrapped in try/catch). If Biome isn't available in the container, the pipeline should continue — `static-checks` will catch real issues.

### Tests

Add a test in `packages/blueprints/tests/implement-feature.test.ts` that verifies each write node's execute function calls biome after writing. You can mock `execFileAsync` or just verify the node structure includes the format step. At minimum, verify the three write nodes exist and have the right IDs.

---

## Fix 2: Search tool — switch from grep to ripgrep with safer pattern handling

### Problem

The `search` tool in `packages/agents/src/tools/search.ts` uses `grep` with `-e` flag. When the LLM passes patterns with unescaped regex metacharacters (`(`, `{`, etc.), grep throws errors like `Unmatched )` or `Invalid content of \{\}`. This wastes coder turns and cost.

### Fix

Replace `grep` with `rg` (ripgrep), which is already in the dev image. Add a `--fixed-strings` (`-F`) flag by default, with an option for regex mode. Ripgrep is more forgiving with pattern syntax and has better defaults for code search.

**File:** `packages/agents/src/tools/search.ts`

**Changes:**

1. Update the input schema to add an optional `regex` boolean:
```typescript
inputSchema: {
  type: "object",
  properties: {
    pattern: { type: "string", description: "The pattern to search for (literal string by default)" },
    path: { type: "string", description: "Directory or file to search in (default: project root)" },
    glob: { type: "string", description: "File glob pattern to filter (e.g. '*.ts')" },
    regex: { type: "boolean", description: "Treat pattern as regex instead of fixed string (default: false)" },
  },
  required: ["pattern"],
},
```

2. Replace the grep invocation with ripgrep:
```typescript
const isRegex = input["regex"] === true
const args = [
  "-n",                                          // line numbers
  "--no-heading",                                 // flat output like grep
  ...(isRegex ? [] : ["--fixed-strings"]),        // literal match by default
  "--glob", `!node_modules`,
  "--glob", `!dist`,
  "--glob", `!.git`,
  ...(input["glob"] ? ["--glob", String(input["glob"])] : []),
  "--max-count", "100",                           // limit matches per file
  String(input["pattern"]),
  searchPath,
]
try {
  const { stdout } = await execFileAsync("rg", args, {
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  })
  const lines = stdout.split("\n").slice(0, 100)
  return lines.join("\n") || "No matches found."
} catch (err: unknown) {
  if (err && typeof err === "object" && "code" in err && err.code === 1) {
    return "No matches found."
  }
  throw err
}
```

3. Update the tool description:
```typescript
description: "Search for a pattern in files using ripgrep. By default searches for literal strings. Set regex: true for regex patterns. Returns matching lines with file paths and line numbers.",
```

### Tests

In `packages/agents/tests/tools.test.ts`, update the search tool tests:
- Verify the tool uses `rg` (not `grep`)
- Test with a pattern containing regex metacharacters (e.g. `"foo(bar)"`) — should work without errors in fixed-string mode
- Test with `regex: true` to verify regex mode still works

**Check first:** Verify `rg` is available in the dev Docker image. Run `docker compose run --rm --entrypoint sh dev -c "which rg"`. If not present, add `ripgrep` to the Dockerfile's apt install line. Ripgrep is available via apt as `ripgrep` in the Node 22 base image.

---

## Fix 3: Coder allowlist — add `rm` with path guard (not `mv`)

### Problem

The coder agent tried `rm` and `mv` to clean up a stray file (`cost-tracker-new.ts`) during the self-test. Both are blocked by the `run_command` allowlist. The coder couldn't clean up after itself.

### Fix

**File:** `packages/agents/src/tools/run-command.ts`

Add `rm` to `DEFAULT_ALLOWED_COMMANDS`, but **add a path guard** that prevents deletion outside `workDir`. Do NOT add `mv` — it can move files to unexpected locations and the coder should use `write_file` + `rm` instead.

1. Add `"rm"` to the `DEFAULT_ALLOWED_COMMANDS` array.

2. Add a path guard for `rm` before execution (after the allowlist check, before `execFileAsync`):

```typescript
// Safety guard: rm can only target files inside workDir
if (executable === "rm") {
  const rmTargets = parts.slice(1).filter(arg => !arg.startsWith("-"))
  for (const target of rmTargets) {
    const resolved = resolve(cwd, target)
    if (!resolved.startsWith(resolve(ctx.workDir))) {
      throw new Error(`rm target "${target}" is outside the work directory`)
    }
  }
  // Prevent rm -rf / or rm -rf . (only allow specific files, not directories)
  if (parts.includes("-rf") || parts.includes("-r")) {
    throw new Error("Recursive rm is not allowed. Delete files individually.")
  }
}
```

This allows `rm packages/engine/src/cost-tracker-new.ts` but blocks `rm -rf .`, `rm /etc/passwd`, or `rm ../../../something`.

### Tests

In `packages/agents/tests/tools.test.ts`, add tests:
- `rm` of a file inside workDir succeeds
- `rm` of a file outside workDir throws path traversal error
- `rm -rf` throws "Recursive rm is not allowed"
- `rm -r` throws "Recursive rm is not allowed"

---

## Fix 4: Anthropic smoke test model ID

### Problem

The live Anthropic smoke test uses model ID `claude-haiku-3-5-20241022` which returns a 404. The model ID has drifted.

### Fix

**File:** `packages/llm/tests/client.test.ts`

Find the line `model: "claude-haiku-3-5-20241022"` in the Anthropic live smoke test and update it to `"claude-haiku-4-5-20251001"`.

Also check `packages/llm/src/providers/anthropic.ts` — the `PRICING` table may need updating:

```typescript
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-opus-4-20250514": { input: 15, output: 75 },
}
```

Replace the old Haiku entry with the new model ID. Keep the same pricing (the per-MTok rates are approximately the same).

---

## Validation

After all four fixes, run:

```bash
# Rebuild (ripgrep may need to be added to Dockerfile)
docker compose build dev

# Full test suite
docker compose run --rm dev run test

# Type check
docker compose run --rm dev run typecheck

# Lint
docker compose run --rm dev run lint
```

All existing tests (699 + any new) must pass. No typecheck or lint errors.

### Quick smoke test for Fix 2

```bash
docker compose run --rm --entrypoint sh dev -c "rg --version"
```

If this fails, add `ripgrep` to the Dockerfile.

---

## Commit guidance

One commit per fix, conventional format:

```
Stage 4c: auto-format generated adversarial test files (write nodes)
Stage 4c: switch search tool from grep to ripgrep with fixed-string default
Stage 4c: add rm to coder allowlist with path guard
Stage 4c: update Anthropic smoke test model ID to claude-haiku-4-5
```
