# Stage 3c Remainder — Per-language Mutation, Semantic Review, Streaming, go.work Detection

> **Goal:** Complete Stage 3c by landing four features in ordered workstreams. Each workstream is self-contained — run typecheck + lint + test after each and commit before starting the next. Stage 3c mutation infrastructure (WS1–WS5) is already shipped; this prompt covers WS6–WS10.

## Ground rules

- All commands run through `docker compose run --rm dev ...`. Never run bare `pnpm`, `node`, or `vitest` on the host.
- Strict TypeScript, no `any`, no new runtime deps (dev deps allowed for mutation tool integration), named exports only, no semicolons.
- All existing tests must still pass after each workstream. Add new tests for every new surface.
- Read `CLAUDE.md` (root) before writing any code — it has authoritative project conventions, current test counts, and the "DO NOT build yet" list.
- Commit message format: `Stage 3c: <what changed>` (e.g., `Stage 3c: MutmutProvider for Python mutation testing`).
- When adding files to a package, make sure the barrel `types.ts` or `index.ts` exports any new public types.

## Current state (post-WS5)

- **Test suite:** 553 passed / 2 skipped (555 total). The 2 skips are LLM live smoke tests (no key).
- **Mutation testing:** Stryker 9.6.0 live for JS/TS. `MutationTestingProvider` interface, `StrykerProvider`, `runMutationTesting` orchestrator, `run-mutation-testing` blueprint node (node 16 of 19), scope-aware targeting via `mutateFiles`.
- **Blueprint:** 19 nodes in `implement-feature` (create-branch → … → run-mutation-testing → generate-diff → approve-pr).
- **Agents:** planner, coder, boundary-tester, contract-tester. No semantic review agent yet.
- **LLM providers:** Anthropic, OpenAI, Google — all synchronous (`chat()` only, no streaming).
- **Go detection:** requires root `go.mod`. `go.work`-only layouts not detected.

---

## WS6 — Per-language mutation providers (MutmutProvider + CargoMutantsProvider)

> Add mutation testing support for Python (mutmut) and Rust (cargo-mutants), extending the `MutationTestingProvider` abstraction.

### Context files to read first

- `packages/verify/src/mutation.ts` — `MutationTestingProvider`, `StrykerProvider`, `runMutationTesting`, `deriveMutatePatterns`
- `packages/verify/tests/mutation.test.ts` — existing tests (17 total)
- `packages/detect/src/types.ts` — `LanguageId`, `ToolchainProfile`

### 6.1 MutmutProvider (Python)

**File:** `packages/verify/src/mutation.ts` (add to existing file)

Create a `MutmutProvider` class implementing `MutationTestingProvider`:

```typescript
export class MutmutProvider implements MutationTestingProvider {
  readonly language: LanguageId = "python"

  async run(
    workDir: string,
    profile: ToolchainProfile,
    mutateFiles?: string[],
  ): Promise<MutationTestResult> { … }
}
```

**Execution flow:**

1. Run `mutmut run --paths-to-mutate <paths> --no-progress` where `<paths>` is either `mutateFiles` joined with commas or derived from `profile.sourcePatterns` (convert globs like `**/*.py` to directory paths like `src/`).
2. Run `mutmut results` and parse the output. mutmut outputs lines like:
   - `Survived mutants (X of Y):` followed by file:line listings
   - `Killed mutants (X of Y):` (or the count from the summary)
3. Map to `MutationTestResult`: `killed`, `survived`, `totalMutants`, `score = (killed / total) * 100`. mutmut doesn't distinguish `noCoverage` or `timeout` — set both to 0.
4. `duration_ms` from wall clock.

**Important:** mutmut does not support a JSON report format. Parse stdout/stderr text output. If `mutmut` is not found on PATH, throw a `BollardError` with code `NODE_EXECUTION_FAILED` and a message suggesting `pip install mutmut`.

### 6.2 CargoMutantsProvider (Rust)

**File:** `packages/verify/src/mutation.ts` (add to existing file)

Create a `CargoMutantsProvider`:

```typescript
export class CargoMutantsProvider implements MutationTestingProvider {
  readonly language: LanguageId = "rust"

  async run(
    workDir: string,
    profile: ToolchainProfile,
    mutateFiles?: string[],
  ): Promise<MutationTestResult> { … }
}
```

**Execution flow:**

1. Run `cargo mutants --json --no-shuffle` in `workDir`. If `mutateFiles` is provided, add `--file <path>` for each file (cargo-mutants accepts `--file` multiple times).
2. Parse the JSON output. cargo-mutants writes a `mutants.out/outcomes.json` file with an array of outcomes, each having a `scenario` and `summary` field. The `summary` field is one of: `"Success"` (killed), `"CaughtMutant"` (killed), `"Unviable"` (skip), `"MissedMutant"` (survived), `"Timeout"` (timeout).
3. Map to `MutationTestResult`.
4. If `cargo-mutants` is not found, throw `NODE_EXECUTION_FAILED` with a message suggesting `cargo install cargo-mutants`.

### 6.3 Update `runMutationTesting` routing

In the existing `runMutationTesting` function, extend the language routing:

```typescript
function getMutationProvider(language: LanguageId): MutationTestingProvider | undefined {
  switch (language) {
    case "typescript":
    case "javascript":
      return new StrykerProvider()
    case "python":
      return new MutmutProvider()
    case "rust":
      return new CargoMutantsProvider()
    default:
      return undefined
  }
}
```

Go mutation testing (`go-mutesting`) is deferred — it has no maintained upstream. The routing should return `undefined` for `"go"`, which triggers the existing "language not supported" skip path.

### 6.4 Tests

**File:** `packages/verify/tests/mutation.test.ts`

Add 6 tests:

1. **MutmutProvider: uses mutateFiles when provided** — mock `execFileAsync`, assert `--paths-to-mutate` includes the files.
2. **MutmutProvider: falls back to sourcePatterns when no mutateFiles** — assert directory derivation from profile.
3. **MutmutProvider: parses mutmut results output** — feed known stdout, assert correct `MutationTestResult`.
4. **CargoMutantsProvider: uses --file flags when mutateFiles provided** — mock exec, assert `--file` args.
5. **CargoMutantsProvider: parses outcomes.json** — write fixture JSON, assert result mapping.
6. **runMutationTesting: routes to correct provider by language** — assert Python → MutmutProvider, Rust → CargoMutantsProvider, Go → skip.

### 6.5 Expected output

| Metric | Expected |
|--------|----------|
| New files | 0 |
| Changed files | 2 (`mutation.ts`, `mutation.test.ts`) |
| Test count delta | +6 |
| Typecheck | Clean |
| Lint | Clean |

### 6.6 Commit

```
Stage 3c: MutmutProvider + CargoMutantsProvider for Python/Rust mutation testing
```

---

## WS7 — Semantic review agent (claims + grounding + advisory)

> Add a new agent that reviews the coder's diff against the plan, producing structured findings. Findings are grounded against the diff + plan corpus, filtered by a deterministic verifier, and surfaced at approve-pr. Advisory only — does not block the pipeline.

### Context files to read first

- `packages/agents/src/contract-tester.ts` — pattern for agent creation (no tools, structured JSON output)
- `packages/agents/prompts/contract-tester.md` — prompt template pattern with `{{#concern}}` blocks
- `packages/verify/src/contract-grounding.ts` — `ClaimRecord`, `ClaimDocument`, `verifyClaimGrounding`, `parseClaimDocument`, `ContractCorpus`
- `packages/blueprints/src/implement-feature.ts` — `verify-claim-grounding` node for the integration pattern
- `spec/08-contract-tester-grounding.md` — design spec for the grounding verifier
- `spec/adr/0001-deterministic-filters-for-llm-output.md` — when/why to add deterministic filters

### 7.1 Design

The semantic review agent follows the **claims + grounding** pattern established by the contract-tester:

1. **Agent** sees: the git diff (`git diff main`), the plan JSON (summary, steps, acceptance criteria, affected files), and the toolchain profile. It does NOT see the full source code — only the diff hunks. This is an intentional information barrier: the reviewer should assess the *change*, not the *codebase*.
2. **Agent produces:** A JSON `ReviewDocument` containing structured `ReviewFinding`s, each grounded against a quote from the diff or the plan.
3. **Deterministic verifier** checks that each finding's grounding quote actually appears in the diff or plan corpus. Ungrounded findings are dropped.
4. **Surviving findings** are attached to the `approve-pr` node's context so the human sees them alongside the diff summary.

### 7.2 Types

**File:** `packages/verify/src/review-grounding.ts` (NEW)

```typescript
export type ReviewSeverity = "info" | "warning" | "error"

export type ReviewCategory =
  | "plan-divergence"      // Diff doesn't match what the plan said
  | "missing-coverage"     // Plan step not reflected in diff
  | "unintended-change"    // Diff touches files/logic not in the plan
  | "error-handling"       // Missing error paths or silent failures
  | "naming-consistency"   // Renamed something but didn't update all references
  | "api-compatibility"    // Public API changed without migration/deprecation

export interface ReviewGrounding {
  quote: string            // Verbatim substring from diff or plan
  source: "diff" | "plan"  // Where the quote came from
}

export interface ReviewFinding {
  id: string               // Unique within document (e.g., "r1", "r2")
  severity: ReviewSeverity
  category: ReviewCategory
  finding: string          // Natural language description
  grounding: ReviewGrounding[]  // Non-empty array required
  file?: string            // Optional: which file the finding applies to
  suggestion?: string      // Optional: what should be done
}

export interface ReviewDocument {
  findings: ReviewFinding[]
}

export interface ReviewCorpus {
  entries: Array<{ text: string; source: "diff" | "plan" }>
}

export interface ReviewVerificationResult {
  kept: ReviewFinding[]
  dropped: Array<{ id: string; reason: string; detail?: string }>
}
```

**Functions in the same file:**

```typescript
export function parseReviewDocument(raw: string): ReviewDocument
// Same pattern as parseClaimDocument: strip fences, parse JSON, validate schema.
// Throws BollardError with a new code (see below) if malformed.

export function buildReviewCorpus(diff: string, plan: unknown): ReviewCorpus
// Split diff by hunks (each hunk = one entry with source: "diff").
// Extract plan summary, steps, acceptance criteria as entries with source: "plan".

export function verifyReviewGrounding(
  doc: ReviewDocument,
  corpus: ReviewCorpus,
): ReviewVerificationResult
// For each finding:
//   1. grounding must be non-empty
//   2. each grounding.quote must be a substring of at least one corpus entry
//      (after whitespace normalization)
//   3. severity must be a valid ReviewSeverity
//   4. category must be a valid ReviewCategory
//   5. id must be unique
// Drop finding if any check fails.
// Unlike contract grounding, do NOT throw if zero findings survive —
// "no issues found" is a valid review outcome.
```

### 7.3 New error code

**File:** `packages/engine/src/errors.ts`

Add `REVIEW_OUTPUT_INVALID` to the `BollardErrorCode` union. Used when `parseReviewDocument` fails to parse the agent's output.

### 7.4 Agent

**File:** `packages/agents/src/semantic-reviewer.ts` (NEW)

```typescript
export function createSemanticReviewerAgent(
  profile?: ToolchainProfile,
): AgentDefinition
```

- **Prompt file:** `packages/agents/prompts/semantic-reviewer.md` (NEW)
- **Temperature:** 0.3 (focused, analytical)
- **Max turns:** 5 (single-shot review, no tools needed)
- **Tools:** None (same as contract-tester — output-only agent)

### 7.5 Prompt template

**File:** `packages/agents/prompts/semantic-reviewer.md` (NEW)

The prompt must instruct the agent to:

1. Read the provided diff hunks and plan JSON
2. Check each plan step against the diff — is it reflected?
3. Check each diff hunk against the plan — is it expected?
4. Flag error handling gaps, naming inconsistencies, API compatibility issues
5. Output a JSON `ReviewDocument` with findings, each grounded against a verbatim quote from the diff or plan
6. Use `{{language}}`, `{{testFramework}}` template variables for language-aware review

**Output format (instruct in prompt):**

```json
{
  "findings": [
    {
      "id": "r1",
      "severity": "warning",
      "category": "plan-divergence",
      "finding": "Plan step 3 specifies adding retry logic with exponential backoff, but the diff shows a fixed 1-second delay.",
      "grounding": [
        { "quote": "Add retry logic with exponential backoff", "source": "plan" },
        { "quote": "+  await sleep(1000)", "source": "diff" }
      ],
      "file": "src/client.ts",
      "suggestion": "Replace the fixed delay with an exponential backoff (e.g., 2^attempt * baseDelay)."
    }
  ]
}
```

When no issues are found, the agent should output `{ "findings": [] }`.

### 7.6 Blueprint integration

**File:** `packages/blueprints/src/implement-feature.ts`

Add 3 new nodes between `run-mutation-testing` (node 16) and `generate-diff` (currently node 17). The blueprint grows from 19 to 22 nodes:

**Node 17: `generate-review-diff`** (deterministic)
- Runs `git diff main` and stores the output in `ctx.results["generate-review-diff"].data.diff`.
- Also extracts `ctx.plan` as the plan source.
- This is a separate node from `generate-diff` (node 20, now renumbered) because it runs earlier in the pipeline and its output feeds the review agent.

**Node 18: `semantic-review`** (agentic, agent: `"semantic-reviewer"`)
- The `agent-handler.ts` constructs the user message from `ctx.results["generate-review-diff"].data.diff` and `ctx.plan`.
- Returns the raw JSON output.

**Node 19: `verify-review-grounding`** (deterministic)
- Calls `parseReviewDocument(raw)` on the agent's output.
- Builds `ReviewCorpus` from the diff and plan.
- Calls `verifyReviewGrounding(doc, corpus)`.
- Logs `semantic_review_result` event: `{ proposed, kept, dropped, dropRate, severityCounts: { info, warning, error } }`.
- Stores `{ findings: result.kept }` in node result data.
- Always returns `status: "ok"` — advisory, never blocks.

**Node 22: `approve-pr`** (human_gate, renumbered from 19)
- Update this node to include review findings in its display. If `ctx.results["verify-review-grounding"]?.data?.findings` has entries, show them above the diff summary so the human reviewer sees them.

### 7.7 Agent handler update

**File:** `packages/cli/src/agent-handler.ts`

Add a case for `agent: "semantic-reviewer"` in the agentic handler:

- Construct the user message: include the diff (from `ctx.results["generate-review-diff"].data.diff`) and the plan JSON (from `ctx.plan`).
- Create the agent via `createSemanticReviewerAgent(profile)`.
- The message should be structured like:

```
## Git Diff

<diff>
{diff content}
</diff>

## Plan

<plan>
{JSON.stringify(plan, null, 2)}
</plan>

Review the diff against the plan. Output a JSON ReviewDocument.
```

### 7.8 Tests

**File:** `packages/verify/tests/review-grounding.test.ts` (NEW)

8 tests:

1. **parseReviewDocument: valid document** — parse a well-formed JSON string.
2. **parseReviewDocument: strips markdown fences** — `\`\`\`json … \`\`\`` wrapped input.
3. **parseReviewDocument: throws REVIEW_OUTPUT_INVALID on bad JSON** — malformed string.
4. **buildReviewCorpus: splits diff hunks and plan fields** — assert entry count and sources.
5. **verifyReviewGrounding: keeps grounded findings** — quote appears in corpus.
6. **verifyReviewGrounding: drops ungrounded findings** — quote not in corpus.
7. **verifyReviewGrounding: returns empty kept on no findings** — `{ findings: [] }` input.
8. **verifyReviewGrounding: drops duplicate IDs** — two findings with same id.

**File:** `packages/agents/tests/semantic-reviewer.test.ts` (NEW)

4 tests:

1. **creates agent with correct role** — `"semantic-reviewer"`.
2. **loads prompt from semantic-reviewer.md** — prompt file exists and loads.
3. **has no tools** — tools array is empty.
4. **fills template placeholders from profile** — `{{language}}` replaced.

**File:** `packages/blueprints/tests/implement-feature.test.ts` (UPDATE)

3 tests:

1. **blueprint has 22 nodes** — update existing node-count test.
2. **semantic-review nodes in correct order** — `generate-review-diff` (17), `semantic-review` (18), `verify-review-grounding` (19).
3. **verify-review-grounding is advisory (always ok)** — execute with findings, assert `status: "ok"`.

### 7.9 Expected output

| Metric | Expected |
|--------|----------|
| New files | 4 (`review-grounding.ts`, `review-grounding.test.ts`, `semantic-reviewer.ts`, `semantic-reviewer.test.ts`, `semantic-reviewer.md`) |
| Changed files | 4 (`implement-feature.ts`, `implement-feature.test.ts`, `agent-handler.ts`, `errors.ts`) |
| Test count delta | +15 (8 grounding + 4 agent + 3 blueprint) |
| Typecheck | Clean |
| Lint | Clean |

### 7.10 Commit

```
Stage 3c: semantic review agent — claims + grounding advisory review of coder diff vs plan
```

---

## WS8 — Streaming LLM responses (Anthropic provider, stubs for others)

> Add `chat_stream` to the `LLMProvider` interface, implement real streaming for Anthropic, and stub OpenAI + Google. Wire streaming into `executeAgent` so the CLI spinner can show tokens arriving in real time.

### Context files to read first

- `packages/llm/src/types.ts` — `LLMProvider`, `LLMRequest`, `LLMResponse`
- `packages/llm/src/providers/anthropic.ts` — current `AnthropicProvider.chat()`
- `packages/llm/src/providers/openai.ts` — `OpenAIProvider.chat()`
- `packages/llm/src/providers/google.ts` — `GoogleProvider.chat()`
- `packages/llm/src/client.ts` — `LLMClient` provider resolution
- `packages/agents/src/executor.ts` — `executeAgent` tool-use loop
- `packages/agents/src/types.ts` — `AgentProgressEvent`
- `spec/archive/stage3a-progress-ux-prompt.md` — Option B streaming design notes

### 8.1 Stream event types

**File:** `packages/llm/src/types.ts` (UPDATE)

```typescript
export type LLMStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use_start"; toolName: string; toolUseId: string }
  | { type: "tool_input_delta"; toolUseId: string; partialJson: string }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; stopReason: LLMResponse["stopReason"]; usage: { outputTokens: number } }
  | { type: "message_complete"; response: LLMResponse }

export interface LLMProvider {
  name: string
  chat(request: LLMRequest): Promise<LLMResponse>
  chatStream?(request: LLMRequest): AsyncIterable<LLMStreamEvent>
}
```

`chatStream` is optional on the interface so existing providers and mocks don't break. The executor checks for it at runtime.

### 8.2 Anthropic streaming implementation

**File:** `packages/llm/src/providers/anthropic.ts` (UPDATE)

Add `chatStream` using the Anthropic SDK's `client.messages.stream()`:

```typescript
async *chatStream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
  const stream = this.client.messages.stream({
    model: request.model,
    max_tokens: request.maxTokens,
    temperature: request.temperature,
    system: request.system,
    messages: this.mapMessages(request.messages),
    tools: request.tools ? this.mapTools(request.tools) : undefined,
  })

  for await (const event of stream) {
    // Map Anthropic stream events to LLMStreamEvent
    // event.type is one of: content_block_start, content_block_delta,
    //   content_block_stop, message_delta, message_stop
    // Yield corresponding LLMStreamEvent for each
  }

  // After stream completes, yield message_complete with the final LLMResponse
  const finalMessage = await stream.finalMessage()
  yield {
    type: "message_complete",
    response: this.mapResponse(finalMessage),
  }
}
```

The key mapping:

| Anthropic event | → LLMStreamEvent |
|----------------|-------------------|
| `content_block_start` (type: text) | (skip — text_delta covers it) |
| `content_block_start` (type: tool_use) | `tool_use_start` |
| `content_block_delta` (type: text_delta) | `text_delta` |
| `content_block_delta` (type: input_json_delta) | `tool_input_delta` |
| `content_block_stop` | `content_block_stop` |
| `message_delta` | `message_delta` |

### 8.3 OpenAI + Google stubs

**File:** `packages/llm/src/providers/openai.ts` (UPDATE)

```typescript
async *chatStream(_request: LLMRequest): AsyncIterable<LLMStreamEvent> {
  throw new BollardError(
    "PROVIDER_NOT_FOUND",
    "OpenAI streaming not yet implemented — use chat() or switch to Anthropic provider",
  )
}
```

**File:** `packages/llm/src/providers/google.ts` (UPDATE) — same pattern.

### 8.4 MockProvider streaming

**File:** `packages/llm/src/mock.ts` (UPDATE)

Add `chatStream` that yields the mock response as a sequence of events (one `text_delta` per word, then `message_complete`). This enables executor streaming tests without live LLM calls.

### 8.5 Executor integration

**File:** `packages/agents/src/executor.ts` (UPDATE)

Update the core LLM call to prefer `chatStream` when available:

```typescript
let response: LLMResponse

if (provider.chatStream) {
  // Stream mode: accumulate response while emitting progress
  response = await streamToResponse(provider.chatStream(request), ctx)
} else {
  // Fallback: synchronous chat (existing behavior)
  response = await provider.chat(request)
}
```

**New helper function** `streamToResponse`:

```typescript
async function streamToResponse(
  stream: AsyncIterable<LLMStreamEvent>,
  ctx: AgentContext,
): Promise<LLMResponse> {
  // Accumulate content blocks from stream events
  // On text_delta: emit AgentProgressEvent { type: "stream_delta", tokens: N }
  //   via ctx.progress (new event type)
  // On tool_use_start: start accumulating tool input
  // On tool_input_delta: append to accumulated JSON
  // On message_complete: return the final LLMResponse
}
```

### 8.6 New progress event type

**File:** `packages/agents/src/types.ts` (UPDATE)

Add a new variant to `AgentProgressEvent`:

```typescript
| { type: "stream_delta"; turn: number; tokensThisChunk: number; totalTokensSoFar: number }
```

The CLI spinner can use this to show a token counter ticking up during LLM generation.

### 8.7 CLI spinner update

**File:** `packages/cli/src/spinner.ts` (UPDATE)

Handle `stream_delta` events in `AgentSpinner`:
- TTY: update the spinner line to show token count (e.g., `⠋ coder · turn 7/60 · 0:43 · $0.18 · 127 tokens`)
- Non-TTY: don't emit per-delta lines (too noisy). The `turn_end` summary already includes token counts.

### 8.8 Tests

**File:** `packages/llm/tests/anthropic.test.ts` (UPDATE)

1. **chatStream yields events in order** — mock the Anthropic SDK's stream, assert event sequence.
2. **chatStream final message matches chat response** — same request to `chat()` and `chatStream()` should produce equivalent `LLMResponse`.

**File:** `packages/llm/tests/mock-stream.test.ts` (NEW)

3. **MockProvider chatStream yields text deltas** — assert word-by-word events.
4. **MockProvider chatStream yields message_complete** — final event has complete response.

**File:** `packages/agents/tests/executor.stream.test.ts` (NEW)

5. **executor uses chatStream when available** — mock provider with `chatStream`, verify streaming path taken.
6. **executor falls back to chat when no chatStream** — provider without `chatStream`, verify non-streaming path.
7. **stream_delta events emitted during streaming** — assert progress callback receives `stream_delta` events.
8. **streamToResponse accumulates correct LLMResponse** — verify tool_use blocks assembled from deltas.

### 8.9 Expected output

| Metric | Expected |
|--------|----------|
| New files | 2 (`mock-stream.test.ts`, `executor.stream.test.ts`) |
| Changed files | 7 (`types.ts` ×2, `anthropic.ts`, `openai.ts`, `google.ts`, `mock.ts`, `executor.ts`, `spinner.ts`, `anthropic.test.ts`) |
| Test count delta | +8 |
| Typecheck | Clean |
| Lint | Clean |

### 8.10 Commit

```
Stage 3c: streaming LLM — Anthropic chatStream, executor integration, stubs for OpenAI/Google
```

### 8.11 Deferred to roadmap

- OpenAI `chatStream` implementation (Chat Completions streaming)
- Google `chatStream` implementation (Generative AI streaming)
- Streaming during retry cycles (currently retries use `chat()` fallback)
- Token-level cost estimation during stream (wait for `message_complete` for accurate cost)

---

## WS9 — `detectToolchain` for go.work-only layouts

> Go workspace detection currently requires a root `go.mod`. Add support for `go.work` files so multi-module Go workspaces are detected correctly.

### Context files to read first

- `packages/detect/src/languages/go.ts` — current Go detector
- `packages/detect/tests/detect.test.ts` — existing detector tests
- `packages/detect/tests/fixtures/go-project/` — existing Go fixture

### 9.1 Update Go detector

**File:** `packages/detect/src/languages/go.ts` (UPDATE)

Current detection signal: `go.mod` exists at root.

Add: also detect when `go.work` exists at root (even without root `go.mod`). A `go.work` file indicates a Go workspace with one or more modules listed in its `use` directives.

```typescript
// Existing: check for go.mod
const goMod = existsSync(join(cwd, "go.mod"))
// New: also check for go.work
const goWork = existsSync(join(cwd, "go.work"))

if (!goMod && !goWork) return null
```

When only `go.work` is present (no root `go.mod`):
- `language` is `"go"` as before
- `packageManager` is `"go"` as before
- Source patterns should scan the `use`-listed directories. Parse `go.work` to extract the `use` paths and derive source patterns like `module1/**/*.go`, `module2/**/*.go`. If parsing fails, fall back to `**/*.go`.
- All other fields (test framework, linter, audit tool) remain the same — `go test`, `golangci-lint`, `go vet` are workspace-aware.

### 9.2 Parse go.work

Add a small helper to extract `use` directives from `go.work`:

```typescript
function parseGoWorkUses(goWorkContent: string): string[] {
  // go.work format:
  //   go 1.22
  //   use (
  //       ./module-a
  //       ./module-b
  //   )
  // or single: use ./module-a
  // Return the paths (without leading ./)
}
```

This is a simple line-by-line parser — no external dependency needed.

### 9.3 Test fixture

**Directory:** `packages/detect/tests/fixtures/go-workspace/` (NEW)

Create a minimal fixture with:
- `go.work` containing `use ./cmd` and `use ./pkg`
- `cmd/go.mod` (minimal)
- `pkg/go.mod` (minimal)
- No root `go.mod`

### 9.4 Tests

**File:** `packages/detect/tests/detect.test.ts` (UPDATE)

Add 3 tests:

1. **detects Go from go.work without root go.mod** — fixture with `go.work` only.
2. **prefers go.mod when both exist** — fixture with both `go.mod` and `go.work` (existing go-project fixture + add a `go.work`).
3. **derives source patterns from go.work use directives** — assert patterns include module paths.

### 9.5 Expected output

| Metric | Expected |
|--------|----------|
| New files | 3 (fixture files: `go.work`, `cmd/go.mod`, `pkg/go.mod`) |
| Changed files | 2 (`go.ts`, `detect.test.ts`) |
| Test count delta | +3 |
| Typecheck | Clean |
| Lint | Clean |

### 9.6 Commit

```
Stage 3c: detectToolchain supports go.work-only Go workspaces
```

---

## WS10 — Stage 3c validation + CLAUDE.md update

> Run the full validation suite, update CLAUDE.md with the final test counts and Stage 3c summary, and prepare for Stage 4.

### 10.1 Run validation

```bash
# Build
docker compose build dev

# Type check
docker compose run --rm dev run typecheck

# Lint
docker compose run --rm dev run lint

# Full test suite
docker compose run --rm dev run test

# Profile detection (verify go.work works)
docker compose run --rm dev --filter @bollard/cli run start -- verify --profile

# Contract graph (unchanged from 3b)
docker compose run --rm dev --filter @bollard/cli run start -- contract
```

Record pass/fail and test counts.

### 10.2 Update CLAUDE.md

Update these sections:

1. **"What Bollard Is"** paragraph — add Stage 3c summary: per-language mutation providers (Python/Rust), semantic review agent with claims + grounding, Anthropic LLM streaming, `go.work` detection.
2. **"Current Test Stats"** — update test count to post-WS10 number.
3. **"Mutation Testing (Stage 3c)"** section — note MutmutProvider and CargoMutantsProvider.
4. **"Stage 3b → Stage 3c follow-ups"** — mark items 5-8 as done with commit references.
5. **"Known limitations"** — update: streaming only for Anthropic, OpenAI/Google stubs. Go mutation testing not supported (no maintained tool). Semantic review is advisory, not a gate.
6. **"Key Types"** section — add `ReviewFinding`, `ReviewDocument`, `LLMStreamEvent`.
7. **"Agents"** section — add semantic-reviewer entry.
8. **"implement-feature blueprint"** — update to 22 nodes, add `generate-review-diff`, `semantic-review`, `verify-review-grounding` descriptions.
9. **"DO NOT build yet"** — remove items that landed in 3c. Add Stage 4 forward references.
10. **Project Structure** tree — add new files (`review-grounding.ts`, `semantic-reviewer.ts`, `semantic-reviewer.md`).

### 10.3 Update spec/stage3c-validation-results.md

Append a "Stage 3c Final Validation" section with:
- Full test count
- New provider smoke tests (if any)
- Semantic review agent dry-run results
- Streaming integration confirmation
- `go.work` detection confirmation

### 10.4 Archive prompts

Move this prompt to `spec/archive/stage3c-remainder-prompt.md` and move all non-archived WS1-WS5 prompts to `spec/archive/` as well.

### 10.5 Expected output

| Metric | Expected |
|--------|----------|
| New files | 0 |
| Changed files | 2 (`CLAUDE.md`, `stage3c-validation-results.md`) + prompt archive moves |
| Test count delta | 0 |
| Typecheck | Clean |
| Lint | Clean |

### 10.6 Commit

```
Stage 3c: validation GREEN — final test counts, CLAUDE.md update, prompt archive
```

---

## Workstream dependency graph

```
WS6 (mutation providers) ─────────────────┐
WS7 (semantic review agent) ──────────────┤
WS8 (streaming LLM) ─────────────────────┤
WS9 (go.work detection) ─────────────────┤
                                           ▼
                                     WS10 (validation)
```

WS6, WS7, WS8, and WS9 are independent of each other and can be done in any order. WS10 must be last.

## Stage 4 forward references (do not build)

After Stage 3c is GREEN, the next stage is **Stage 4: Behavioral-scope adversarial testing + production feedback loop**. Key items:

- Behavioral-tester agent + behavioral extractor (topology, endpoints, failure modes)
- Fault injector (Docker-level network delays, connection drops, resource limits)
- Production probes and drift detection
- Git rollback on coder max-turns failure
- Verification summary batching
- Language expansion Wave 2 (C#/.NET with Stryker.NET)
- OpenAI + Google `chatStream` implementations
