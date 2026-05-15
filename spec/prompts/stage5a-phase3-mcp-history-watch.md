# Cursor Prompt — Stage 5a Phase 3: MCP History Tools + Watch/MCP History Recording

> **Context:** Stage 5a Phases 1 and 2 are done. The JSONL run history store (`FileRunHistoryStore`) and SQLite derived query layer are live. The CLI `history list/show/compare/summary/rebuild` commands all work. Phase 3 closes the loop on two things: (a) expose history to AI agents via two new MCP tools (`bollard_history`, `bollard_history_summary`); (b) wire `bollard watch` and MCP `handleVerify` to record `VerifyRecord`s with the correct `source` field.
>
> **Read CLAUDE.md fully before writing any code.** Then read:
> - `packages/mcp/src/tools.ts` — every existing tool handler; follow the same pattern exactly (Zod schema → `zodToJsonSchema` → handler async function → entry in `tools[]`)
> - `packages/engine/src/run-history.ts` — `RunRecord`, `VerifyRecord`, `HistoryFilter`, `FileRunHistoryStore`, `RunSummary`, `computeCostTrend`; note `VerifyRecordSource = "cli" | "mcp" | "watch" | "hook"` already defined
> - `packages/cli/src/history.ts` — `runHistoryCommand`; the MCP tools return the same data shapes (JSON-serialisable), not formatted terminal strings
> - `packages/cli/src/watch.ts` — current `startWatch` / `WatchOptions`; needs a `onVerifyComplete` callback or inline `FileRunHistoryStore` call after each verify
> - `packages/cli/src/index.ts` — how `handleVerify` in MCP is currently wired (it calls `runStaticChecks` directly and never records to history)
> - `packages/mcp/tests/tools.test.ts` — existing MCP tool tests; follow the same pattern

---

## What to build

Three self-contained pieces.

### 3a — `bollard_history` MCP tool

Add to `packages/mcp/src/tools.ts`:

**Input schema:**
```typescript
const historyInputSchema = z.object({
  workDir: z.string().optional(),
  limit: z.number().optional(),       // default 10
  offset: z.number().optional(),      // default 0
  status: z.string().optional(),      // "success" | "failure" | "handed_to_human"
  blueprintId: z.string().optional(), // filter by blueprint
  since: z.string().optional(),       // ISO date string, e.g. "2026-05-01"
  runId: z.string().optional(),       // if set, return the single matching record (show mode)
})
```

**Handler logic:**
- If `runId` is provided: call `store.findByRunId(runId)` and return the single record (or `null` if not found)
- Otherwise: build a `HistoryFilter` from the parsed args, call `store.query(filter)`, return the array of records as-is (JSON-serialisable — no formatting)
- Use `new FileRunHistoryStore(dir)` where `dir = parsed.workDir ?? workDir`

**Return shape (list mode):**
```typescript
{ records: HistoryRecord[]; count: number; filter: HistoryFilter }
```

**Return shape (show mode):**
```typescript
{ record: HistoryRecord | null; runId: string }
```

**Description (ADR-0003 pattern — WHY first):**
> "Query Bollard's run history — implement-feature pipeline runs and static verify events. Returns structured `RunRecord` and `VerifyRecord` objects with cost, duration, node-by-node status, test counts, scope results (boundary/contract/behavioral grounding rates), and mutation scores. Use to answer: 'what did the last pipeline run cost?', 'which nodes failed?', 'has cost been trending up?'. Pass `runId` for a single-record lookup. Filters: `status`, `blueprintId`, `since` (ISO date), `limit`, `offset`."

### 3b — `bollard_history_summary` MCP tool

**Input schema:**
```typescript
const historySummaryInputSchema = z.object({
  workDir: z.string().optional(),
  since: z.string().optional(),   // ISO date string
  until: z.string().optional(),   // ISO date string
})
```

**Handler logic:**
- Call `store.summary({ since, until })` — `FileRunHistoryStore.summary()` already returns `RunSummary`
- Return the `RunSummary` object directly

**Return shape:** the `RunSummary` type as-is (already JSON-serialisable):
```typescript
{
  totalRuns: number
  successRate: number
  avgCostUsd: number
  avgDurationMs: number
  avgTestCount: number
  avgMutationScore?: number
  costTrend: "up" | "down" | "stable" | "insufficient_data"
  byBlueprint: Record<string, { count: number; successRate: number; avgCostUsd: number }>
}
```

**Description:**
> "Aggregate statistics for Bollard pipeline runs: total runs, success rate, average cost, average duration, cost trend ('up'/'down'/'stable'/'insufficient_data'), and per-blueprint breakdowns. Use to answer: 'is the pipeline getting more expensive?', 'what is the success rate this week?'. Pass `since`/`until` ISO date strings to scope the window."

### 3c — Wire `bollard watch` into history

In `packages/cli/src/watch.ts`, after each successful or failed `runStaticChecks` call inside the file-change handler, record a `VerifyRecord` with `source: "watch"`.

**Exact change:** In the debounced handler that calls `runStaticChecks(workDir, profile)`:
1. Import `FileRunHistoryStore` from `@bollard/engine/src/run-history.js`
2. Import `buildVerifyRecord` from `./history-record.js`
3. After `runStaticChecks` returns (inside the try/catch), call:
```typescript
const store = new FileRunHistoryStore(workDir)
const record = buildVerifyRecord({
  workDir,
  profile,
  results,          // StaticCheckResult[]
  allPassed,
  source: "watch",
  durationMs,       // elapsed since the verify started
})
await store.record(record).catch(() => {/* non-fatal */})
```

Look at how `packages/cli/src/index.ts` does it for the `verify` command (around line 321–330) — follow the exact same pattern, just with `source: "watch"` instead of `source: "cli"`.

`WatchOptions` does **not** need a new field — recording is always on (same as the `verify` command).

### 3d — Wire MCP `handleVerify` into history

In `packages/mcp/src/tools.ts`, in the `handleVerify` function, after `runStaticChecks` returns, record a `VerifyRecord` with `source: "mcp"`:

```typescript
const { FileRunHistoryStore } = await import("@bollard/engine/src/run-history.js")
const { buildVerifyRecord } = await import("@bollard/cli/src/history-record.js")
const store = new FileRunHistoryStore(dir)
const record = buildVerifyRecord({
  workDir: dir,
  profile,
  results,
  allPassed,
  source: "mcp",
  durationMs: Date.now() - startTs,
})
await store.record(record).catch(() => {/* non-fatal */})
```

Add `const startTs = Date.now()` at the top of `handleVerify`. The `record()` call is fire-and-forget-safe (non-fatal catch) — MCP verify must never fail because of a history write error.

---

## Tests to add

### `packages/mcp/tests/tools.test.ts`

Add to the existing test file (follow the existing pattern — mock `FileRunHistoryStore` or use a temp dir):

1. **`bollard_history` tool exists** — verify `tools` array contains an entry with `name: "bollard_history"`
2. **`bollard_history` handler returns records array** — call handler with empty `workDir` pointing at a temp dir with no history file; expect `{ records: [], count: 0 }`
3. **`bollard_history` handler show mode** — call with `{ runId: "nonexistent" }`; expect `{ record: null, runId: "nonexistent" }`
4. **`bollard_history_summary` tool exists** — verify entry in `tools` array
5. **`bollard_history_summary` handler returns summary shape** — call with temp dir; expect object with `totalRuns`, `successRate`, `costTrend` keys present

Do **not** add integration tests that write real records and read them back — that's already covered in `packages/engine/tests/run-history.test.ts`. Keep MCP tests focused on tool wiring.

---

## CLAUDE.md update

Find the `### Stage 5a Phase 2 (DONE)` entry. After it add:

```
### Stage 5a Phase 3 (DONE) — MCP History Tools + Watch/MCP History Recording:

`bollard_history` MCP tool: query run history with `runId` (show mode) or filters (`status`, `blueprintId`, `since`, `limit`, `offset`); returns `{ records, count, filter }` or `{ record, runId }`. `bollard_history_summary` MCP tool: returns `RunSummary` (totalRuns, successRate, avgCostUsd, costTrend, byBlueprint) with optional `since`/`until` window. `bollard watch` verify completions now recorded with `source: "watch"`. MCP `handleVerify` completions now recorded with `source: "mcp"`. Both wire-ups are non-fatal (catch + ignore history errors). `VerifyRecordSource = "cli" | "mcp" | "watch" | "hook"` was already defined in `run-history.ts`.
```

Also update the roadmap line in CLAUDE.md: find `**Stage 5a Phase 3** adds MCP history tools` (or equivalent) and mark it DONE.

---

## Validation

```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
```

Expected: clean typecheck + lint, test count increases by 5 (the 5 new MCP tool tests).

Then do a smoke test of the two new tools:
```bash
docker compose run --rm dev sh -c \
  'pnpm --filter @bollard/cli run start -- run demo --task "smoke" 2>/dev/null; \
   node -e "
const {FileRunHistoryStore} = await import(\"@bollard/engine/src/run-history.js\");
const s = new FileRunHistoryStore(\"/app\");
const r = await s.query({limit:3,offset:0});
console.log(JSON.stringify(r.map(x=>({type:x.type,runId:x.runId})),null,2));
" 2>/dev/null || true'
```

---

## Constraints

- Do NOT add a `source` field to `WatchOptions` — recording is unconditional (always "watch").
- Do NOT change `VerifyRecord` or `VerifyRecordSource` — the types are already correct.
- Do NOT make MCP `bollard_history` format output as a table — it returns raw JSON objects, same as `history --json` in the CLI. AI agents parse JSON; humans use the CLI.
- The `bollard_history` handler must never throw — wrap `store.query()` / `store.findByRunId()` in try/catch and return `{ records: [], count: 0, error: message }` on failure.
- The `bollard_history_summary` handler must never throw — return `{ error: message }` on failure.
- Both new tools follow the existing `zodToJsonSchema` + `tools[]` registration pattern exactly — no new helper functions needed.
- The `handleVerify` history recording must be after the `runStaticChecks` return, not in a separate async path — it should be `await store.record(...)` with a `.catch(() => {})` to keep it non-fatal.
