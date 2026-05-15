# Cursor Prompt — Stage 5d Phase 8: Context Window Management

> **Purpose:** The 2026-05-13 API logs revealed that 94% of run cost is input tokens, not output. Context grows monotonically from ~6K tokens/turn (early) to ~33K tokens/turn (late) as tool results and file contents accumulate in the message history. Even with Phase 7's turn reduction (target: 30 turns), at 20K avg input/turn that's 600K input tokens = **$1.80 in input alone** — above the $1.00 target. Phase 8 reduces cost-per-turn by attacking the three context inflators: large `read_file` results sitting at full size for many turns, large `run_command` outputs that are never needed after the first read, and a `COMPACT_KEEP_RECENT = 6` window that is too wide for the pre-loaded file content that dominates early turns. Target: average context < 15K tokens/turn. Combined with Phase 7 (< 40 turns), the arithmetic reaches $0.90 on a bounded task.

Read CLAUDE.md fully before writing any code. Then read:
- `spec/stage5d-token-economy.md` — Phase 8 design and the 94% input-cost finding
- `packages/agents/src/executor.ts` — `compactOlderTurns`, `MAX_TOOL_RESULT_CHARS`, `COMPACT_KEEP_RECENT` constants, the full turn loop
- `packages/agents/src/tools/read-file.ts` — currently returns full file content with no line cap
- `packages/agents/src/tools/run-command.ts` — currently returns full stdout+stderr with no line cap
- `packages/agents/tests/executor.test.ts` — existing compaction tests to understand what to update
- `packages/agents/tests/tools.test.ts` — existing tool tests

---

## What the current code does (read before changing anything)

In `executor.ts`:
- `MAX_TOOL_RESULT_CHARS = 8_000` — tool results are capped at 8K chars before being added to messages. This is the first cap, applied immediately.
- `COMPACT_KEEP_RECENT = 6` — `compactOlderTurns` leaves the last 6 messages untouched; messages older than that get their tool results truncated to `COMPACTED_MAX_CHARS = 500` chars.
- `compactOlderTurns` is called after every turn (line 231 in the verification-retry path and line 336 in the tool-use path).

**The gap:** `read_file` returns the entire file — no line cap before the tool result cap. A 400-line TypeScript file is ~12K chars, which gets capped to 8K at the tool result boundary. That 8K sits in the last-6-messages window at full size for up to 6 turns before compaction squishes it to 500 chars. In a 30-turn run with 5 pre-loaded files (each 6–8K after the cap), turns 1–6 carry ~40K chars of file content alone. That's the primary driver of the 33K input tokens seen in late turns.

**The `run_command` gap:** tsc output for a large project can be 200+ lines of errors, all returned as-is. `run_command` has no internal truncation — it just relies on `MAX_TOOL_RESULT_CHARS` to cap at 8K. 8K of tsc/biome error output is still very expensive to carry for 6 turns.

---

## What to change

### 8a — `packages/agents/src/tools/read-file.ts`: add line cap

Add a `maxLines` parameter (optional, default 200) and a truncation marker. The tool should truncate at `maxLines` and report the total line count so the coder knows whether it got the full file:

```typescript
const MAX_LINES = 200

export const readFileTool: AgentTool = {
  name: "read_file",
  description:
    "Read the contents of a file. Returns up to 200 lines by default. Use offset and limit to read specific ranges of large files.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path to the file from the project root" },
      offset: {
        type: "number",
        description: "Line number to start reading from (1-based, default: 1)",
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to return (default: 200, max: 200)",
      },
    },
    required: ["path"],
  },
  async execute(input, ctx) {
    const filePath = resolve(ctx.workDir, String(input["path"] ?? ""))
    if (!filePath.startsWith(resolve(ctx.workDir))) {
      throw new Error("Path traversal detected: path must be within the project directory")
    }
    const content = await readFile(filePath, "utf-8")
    const lines = content.split("\n")
    const totalLines = lines.length
    const offset = Math.max(0, (Number(input["offset"] ?? 1) - 1))
    const limit = Math.min(MAX_LINES, Number(input["limit"] ?? MAX_LINES))
    const slice = lines.slice(offset, offset + limit)
    const result = slice.join("\n")
    if (totalLines > offset + limit) {
      return `${result}\n[...truncated: showing lines ${offset + 1}–${offset + limit} of ${totalLines}. Use offset=${offset + limit + 1} to read more.]`
    }
    return result
  },
}
```

Key design decisions:
- **200 lines default** — covers the vast majority of source files in Bollard (most are 50–150 lines). The `max_lines` cap of 200 means even a fully-read file is ~6K chars maximum (at ~30 chars/line average), down from 8K+ at the tool-result boundary.
- **`offset` + `limit` parameters** — the coder can paginate large files. This is strictly better UX than "here's the first 200 lines and you can't see more." The coder prompt already teaches line-range editing; pagination is the natural companion.
- **Truncation marker includes total line count** — the coder knows how much it's missing without needing another tool call.
- **`limit` is capped at 200** — even if the coder passes `limit: 9999`, it gets 200. The cap is enforced in the tool, not just documented.

### 8b — `packages/agents/src/tools/run-command.ts`: add error-output line cap

Commands like `tsc --noEmit` and `biome check` on a large project produce hundreds of lines of output. The coder only needs to see the first N errors — reading line 200 of a tsc error dump never changes what fix to apply.

Add a `MAX_OUTPUT_LINES = 100` constant and truncate stdout+stderr independently:

```typescript
const MAX_OUTPUT_LINES = 100

// Inside execute(), replace the result-building block:
let result = ""
if (stdout) {
  const stdoutLines = stdout.split("\n")
  const truncated = stdoutLines.length > MAX_OUTPUT_LINES
  const displayed = stdoutLines.slice(0, MAX_OUTPUT_LINES).join("\n")
  result += `stdout:\n${displayed}${truncated ? `\n[...truncated: ${stdoutLines.length - MAX_OUTPUT_LINES} more lines not shown]` : ""}\n`
}
if (stderr) {
  const stderrLines = stderr.split("\n")
  const truncated = stderrLines.length > MAX_OUTPUT_LINES
  const displayed = stderrLines.slice(0, MAX_OUTPUT_LINES).join("\n")
  result += `stderr:\n${displayed}${truncated ? `\n[...truncated: ${stderrLines.length - MAX_OUTPUT_LINES} more lines not shown]` : ""}\n`
}
return result || "(no output)"
```

Also apply the same cap in the error path (the `catch` block that returns `Command failed (exit N):\nstdout:\n...\nstderr:\n...`).

**Why 100 lines, not 50:** tsc errors for a multi-package workspace can legitimately have 60–80 lines of distinct errors. 50 would truncate real signal. 100 captures all meaningful errors on any plausible project while cutting 200-line dumps by half.

**Note:** The `maxBuffer: 2 * 1024 * 1024` stays — that's for the child process buffer, not the output we return to the LLM. We still want the process to complete; we just trim what we show the model.

### 8c — `packages/agents/src/executor.ts`: tighten compaction constants

Three targeted changes:

**8c-i — Lower `MAX_TOOL_RESULT_CHARS` from 8000 to 4000:**

```typescript
const MAX_TOOL_RESULT_CHARS = 4_000
```

With 8a in place, `read_file` results are already capped at ~6K chars (200 lines × ~30 chars). The executor cap at 4K provides a second safety net for any tool that bypasses the per-tool cap (e.g. `search` returning many results). This does not affect the per-tool truncation — it's an additional ceiling on what enters the message history at all.

**8c-ii — Lower `COMPACT_KEEP_RECENT` from 6 to 4:**

```typescript
const COMPACT_KEEP_RECENT = 4
```

Currently, tool results from 6 turns ago sit at full size. With 4, they compact after 4 turns. At 30 chars/line × 200 lines = 6K chars per file read, compacting 2 turns earlier saves ~12K chars from staying in context. On a 30-turn run, this alone cuts ~10% of accumulated input tokens.

**8c-iii — Raise `COMPACTED_MAX_CHARS` from 500 to 800:**

```typescript
const COMPACTED_MAX_CHARS = 800
```

500 chars is sometimes too aggressive — a compacted `read_file` result at 500 chars loses the function signatures that the coder needs to reference when writing a test 20 turns later. 800 chars preserves ~25 lines of code, which is enough for a function signature + docstring + first few lines of body. This is a small increase but prevents the "coder re-reads a file because the compact was too lossy" pattern.

**These three constants together** reduce the worst-case context per turn:
- Before: up to 8K chars per tool result × up to 6 uncompacted turns = 48K chars of tool results in the window
- After: up to 4K chars per tool result × up to 4 uncompacted turns = 16K chars — a 67% reduction in the tool-result contribution to context size

### 8d — `packages/agents/src/tools/read-file.ts`: update the tool description in coder.md

The coder prompt's `# File Editing Strategy` section references `read_file` without mentioning pagination. After 8a ships, add a one-line note to `packages/agents/prompts/coder.md` in the `# Rules` section:

```markdown
10. `read_file` returns up to 200 lines. For large files, use `offset` and `limit` to read specific sections. Check the truncation marker to know if there's more.
```

This is a prompt change, not a code change — it teaches the coder to paginate rather than assuming it got the full file.

---

## Tests to update / add

### `packages/agents/tests/tools.test.ts`

**read_file tests:**
1. Update any existing test that checks the full content of a >200-line fixture file — the tool now returns truncated content.
2. Add: reading a file with exactly 200 lines returns all lines with no truncation marker.
3. Add: reading a file with 250 lines returns the first 200 lines + truncation marker showing `lines 1–200 of 250`.
4. Add: `offset=201, limit=50` on the same 250-line file returns lines 201–250 with no truncation marker.
5. Add: `limit=300` is capped at 200.

**run_command tests:**
1. Add: a command that produces 150 lines of stdout returns the first 100 lines + truncation marker showing `50 more lines not shown`.
2. Add: a command that produces 80 lines of stdout returns all 80 lines with no truncation marker.
3. Add: the failed-command error path also truncates (test with a mock that produces 200-line stdout on failure).

### `packages/agents/tests/executor.test.ts`

1. Update the `MAX_TOOL_RESULT_CHARS` constant reference if any test asserts the old value of 8000.
2. Update `COMPACT_KEEP_RECENT` reference if any test asserts 6.
3. Add: a run with 5 turns of `read_file` calls — verify that after turn 5, messages from turn 1 are compacted to ≤ 800 chars (the new `COMPACTED_MAX_CHARS`).
4. Existing cost-cap test (`BurnPerTurnProvider` at $0.01/turn, cap $0.05) should still pass — no change to cost logic.

---

## CLAUDE.md update

Find the Stage 5d section. After the Phase 7 DONE entry, add:

```
### Stage 5d Phase 8 (DONE) — Context Window Management:

Three changes targeting the 94% input-token cost share identified in the 2026-05-13 API logs: (8a) `read_file` capped at 200 lines with `offset`/`limit` pagination; (8b) `run_command` output capped at 100 lines per stream (stdout/stderr separately); (8c) executor constants tightened — `MAX_TOOL_RESULT_CHARS` 8000→4000, `COMPACT_KEEP_RECENT` 6→4, `COMPACTED_MAX_CHARS` 500→800. (8d) coder prompt updated with `read_file` pagination note. Target: average context < 15K tokens/turn (from ~20K avg, 33K peak). Combined with Phase 7 (< 40 turns), arithmetic reaches ~$0.90 on a bounded single-method task.
```

Update the test count line to reflect post-Phase-8 count.

---

## Validation

```bash
# Tests must pass:
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test

# Verify constants:
grep "MAX_TOOL_RESULT_CHARS" packages/agents/src/executor.ts
# Expected: 4_000

grep "COMPACT_KEEP_RECENT" packages/agents/src/executor.ts
# Expected: 4

grep "MAX_LINES" packages/agents/src/tools/read-file.ts
# Expected: 200

grep "MAX_OUTPUT_LINES" packages/agents/src/tools/run-command.ts
# Expected: 100

# Verify read_file truncation works:
docker compose run --rm dev sh -c \
  'node -e "
    const lines = Array.from({length:300}, (_,i)=>\"line \"+i).join(\"\n\");
    const truncated = lines.split(\"\n\").slice(0,200).join(\"\n\");
    console.log(\"Lines in truncated:\", truncated.split(\"\n\").length);
    console.assert(truncated.split(\"\n\").length === 200, \"FAIL\");
    console.log(\"PASS\");
  "'
```

Do NOT run a Bollard-on-Bollard self-test as part of this phase — that's Phase 8 validation, which runs after the code ships and tests pass. The self-test for Phase 8 is the same `peek(): number` task from the Phase 7 validation plan: after Phase 8 ships, run it and compare average input tokens/turn (from Anthropic usage UI) against the 20K pre-Phase-8 baseline.

---

## Constraints

- **Do not remove the `offset`/`limit` parameters from the input schema** — they are part of the tool's public interface and the coder prompt references them. Once added, they must stay.
- **`limit` must be enforced in code, not just documented.** `Math.min(MAX_LINES, Number(input["limit"] ?? MAX_LINES))` — the cap is mechanical, not advisory.
- **Do not change the `maxBuffer` in `run-command.ts`.** That's the child process buffer limit, not the output-to-LLM limit. Reducing it would cause command failures on large projects.
- **Do not change `COMPACTED_MAX_CHARS` below 500.** 800 is an increase from 500, intentionally. Going lower than 500 risks the coder re-reading files it has already seen because the compacted version lost too much.
- **The `search` tool is NOT capped in this phase.** Search results are already short (line + context per match). Do not add a line cap to search — it would truncate multi-match results that the coder genuinely needs.
- **No changes to the planner, boundary-tester, contract-tester, behavioral-tester, or semantic-reviewer tools or prompts.** This phase targets the coder agent's context growth only. Non-coder agents have much shorter runs and are not the cost driver.
- **Model strings, maxTurns, temperature — all unchanged.** Phase 8 is context management only.
