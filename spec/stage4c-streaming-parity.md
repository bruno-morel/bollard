# Stage 4c (Part 1) — OpenAI / Google Streaming Parity

> **Status:** GREEN (2026-04-16)  
> **Depends on:** Stage 4b (production feedback loop, GREEN 2026-04-16)  
> **Validates:** `chatStream` on OpenAI and Google providers, error semantics, executor integration  
> **Prerequisite for:** Stage 4c Part 2 (Java/Kotlin Wave 1)

**Validation:** `684` tests passed / `4` skipped (`docker compose run --rm dev run test`); `pnpm exec tsc --build` and `biome check` clean. Live streaming smoke tests skip without API keys.

---

## 1. Goal

Implement `chatStream` on the OpenAI and Google LLM providers so all three providers have full streaming support. This clears the last "stub throws PROVIDER_NOT_FOUND" limitation from the LLM layer. After this, any `LLMProvider` works identically with the executor's streaming path — no more silent fallback to non-streaming `chat()` for OpenAI/Google users.

---

## 2. Current State

### What exists

| Provider | `chat()` | `chatStream()` | SDK |
|----------|----------|-----------------|-----|
| Anthropic | ✅ Full | ✅ Full (reference) | `@anthropic-ai/sdk` — `client.messages.stream()` |
| OpenAI | ✅ Full | ✅ Full (`stream: true`) | `openai` v4.x — `client.chat.completions.create({ stream: true })` |
| Google | ✅ Full | ✅ Full | `@google/generative-ai` — `model.generateContentStream()` |

### Reference: Anthropic `chatStream` event flow

```
SDK: client.messages.stream(params)
  → content_block_start (tool_use)  → emit tool_use_start { toolName, toolUseId }
  → content_block_delta (text)      → emit text_delta { text }
  → content_block_delta (json)      → emit tool_input_delta { toolUseId, partialJson }
  → content_block_stop              → emit content_block_stop { index }
  → message_delta                   → emit message_delta { stopReason, usage }
  → stream end                      → stream.finalMessage() → emit message_complete { response }
```

### Reference: Executor consumption (`streamToResponse`)

```typescript
// packages/agents/src/executor.ts
const response = provider.chatStream
  ? await streamToResponse(provider.chatStream(request), ctx, displayTurn)
  : await chatWithRetry(provider, request, agent.role)
```

The executor:
1. Iterates the `AsyncIterable<LLMStreamEvent>`
2. Emits `stream_delta` progress events on `text_delta` (character count, not tokens)
3. Waits for `message_complete` to get the final `LLMResponse`
4. If `chatStream` is undefined, falls back to `chat()` with retry

No changes to the executor are needed — it already handles the `LLMStreamEvent` union generically.

---

## 3. Scope (What Ships)

### 3.1 OpenAI `chatStream`

**File:** `packages/llm/src/providers/openai.ts`

Replace the stub with a real implementation using the OpenAI streaming API:

```typescript
async *chatStream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
  // SDK call: client.chat.completions.create({ ...params, stream: true })
  // Returns AsyncIterable<ChatCompletionChunk>
}
```

**SDK method:** `client.chat.completions.create({ ...params, stream: true })` returns an async iterable of `ChatCompletionChunk`.

**Event mapping:**

| OpenAI chunk field | Bollard event | Notes |
|--------------------|---------------|-------|
| `delta.content` (string) | `text_delta` | Partial text response |
| `delta.tool_calls[i]` with `function.name` | `tool_use_start` | First chunk for a tool call includes the name |
| `delta.tool_calls[i].function.arguments` | `tool_input_delta` | Partial JSON string for the tool's arguments |
| — (end of content block) | `content_block_stop` | Emit when a tool call's argument stream completes |
| `finish_reason` present | `message_delta` | Map `finish_reason` to `stopReason` |
| Stream ends | `message_complete` | Assemble full `LLMResponse` from buffered chunks |

**Buffering strategy:** OpenAI streams tool calls by `index` within the `delta.tool_calls` array. The implementation must:
1. Track a `Map<number, { name: string; id: string; args: string }>` for in-progress tool calls
2. On first chunk for an index (has `function.name`): emit `tool_use_start`, create buffer entry
3. On subsequent chunks for same index: emit `tool_input_delta`, append to buffer
4. When `finish_reason` arrives or stream ends: emit `content_block_stop` for each tool, then `message_delta`
5. Assemble the final `LLMResponse` from buffered text + tool calls, compute cost estimate, emit `message_complete`

**Stop reason mapping:**
| OpenAI `finish_reason` | Bollard `stopReason` |
|------------------------|---------------------|
| `"stop"` | `"end_turn"` |
| `"tool_calls"` | `"tool_use"` |
| `"length"` | `"max_tokens"` |
| other | `"end_turn"` |

**Error handling:** Same pattern as `chat()` — catch SDK-specific errors, wrap in `BollardError`:
- `RateLimitError` → `LLM_RATE_LIMIT`
- `AuthenticationError` → `LLM_AUTH`
- `APIConnectionTimeoutError` → `LLM_TIMEOUT`
- Other → `LLM_PROVIDER_ERROR`

If the stream ends without a `finish_reason`, throw `LLM_INVALID_RESPONSE`.

### 3.2 Google `chatStream`

**File:** `packages/llm/src/providers/google.ts`

Replace the stub with a real implementation using the Google Generative AI streaming API:

```typescript
async *chatStream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
  // SDK call: model.generateContentStream({ contents, tools })
  // Returns { stream: AsyncIterable<GenerateContentResponse> }
}
```

**SDK method:** `model.generateContentStream({ contents, tools })` returns `{ stream: AsyncIterable<GenerateContentResponse> }`.

**Event mapping:**

| Google chunk field | Bollard event | Notes |
|--------------------|---------------|-------|
| `candidate.content.parts[i].text` | `text_delta` | Partial text |
| `candidate.content.parts[i].functionCall` | `tool_use_start` + `tool_input_delta` | Google sends complete function calls per chunk (not streamed incrementally) |
| — | `content_block_stop` | After each function call part |
| `candidate.finishReason` present | `message_delta` | Map finish reason |
| Stream ends | `message_complete` | Assemble full response |

**Google-specific note:** Unlike Anthropic and OpenAI, Google's streaming API sends `functionCall` parts as complete objects (name + args together), not as incremental deltas. This simplifies the implementation — no buffering needed for tool calls. Each `functionCall` part becomes a `tool_use_start` immediately followed by a `tool_input_delta` (with the full JSON) and `content_block_stop`.

**Stop reason mapping:**
| Google `finishReason` | Bollard `stopReason` |
|----------------------|---------------------|
| `"STOP"` | `"end_turn"` |
| `"MAX_TOKENS"` | `"max_tokens"` |
| Other / tool calls present | `"tool_use"` |

**Tool call ID generation:** Google doesn't provide tool call IDs. Use the same pattern as the existing `chat()` method: `google-${name}-${Date.now()}`.

**Error handling:** Same pattern as `chat()` — Google SDK errors map to `LLM_PROVIDER_ERROR`. Rate limit and auth errors are detected from error messages/status codes.

If the stream yields zero candidates, throw `LLM_INVALID_RESPONSE`.

### 3.3 Anthropic `tool_input_delta` fix

**Minor fix:** The current Anthropic implementation emits `tool_input_delta` with `toolUseId: ""` (hardcoded empty string). Track the current tool's ID from the preceding `content_block_start` event and pass it through. This is a 2-line fix but aligns all three providers on correct `toolUseId` semantics.

---

## 4. What Does NOT Ship

| Item | Why | When |
|------|-----|------|
| Streaming retry logic | The executor's `chatWithRetry` handles retries for `chat()`; streaming retries are complex (partial state) and not needed until proven necessary | When needed |
| Token-accurate progress events | Executor counts characters, not tokens, for `stream_delta`. Good enough for spinner UX | When needed |
| Streaming in MockProvider | MockProvider is sync by design; tests don't need streaming | Not planned |

---

## 5. Implementation Sequence

### Phase 1: OpenAI streaming

1. Implement `chatStream` on `OpenAIProvider` with tool call buffering
2. Add streaming tests (mock + live smoke test with `OPENAI_API_KEY`)
3. Fix Anthropic `tool_input_delta` toolUseId passthrough

### Phase 2: Google streaming

4. Implement `chatStream` on `GoogleProvider`
5. Add streaming tests (mock + live smoke test with `GOOGLE_API_KEY`)

### Phase 3: Validation

6. Run full test suite — all existing tests must pass
7. Run `implement-feature` with `BOLLARD_LLM_PROVIDER=openai` — verify streaming events appear in CLI spinner
8. Run `implement-feature` with `BOLLARD_LLM_PROVIDER=google` — same check
9. Document results

---

## 6. Test Plan

### Unit tests

| File | Tests | Coverage |
|------|-------|----------|
| `openai.test.ts` (extended) | Stream text-only response, stream with tool calls, stream error handling, incomplete stream (no finish_reason), stop reason mapping | ~6 new |
| `google.test.ts` (extended) | Stream text-only response, stream with function calls, stream error handling, empty candidates, stop reason mapping | ~6 new |
| `anthropic.test.ts` (extended) | Verify `tool_input_delta` carries correct `toolUseId` | ~1 new |

**Estimated new tests:** ~13

### Live smoke tests

Each provider already has a `skipIf(!key)` live test. Add streaming variants:

| Test | Trigger |
|------|---------|
| OpenAI streaming smoke | `OPENAI_API_KEY` set |
| Google streaming smoke | `GOOGLE_API_KEY` set |

These stream a simple prompt and verify `message_complete` is emitted.

---

## 7. Files Changed

| File | Change |
|------|--------|
| `packages/llm/src/providers/openai.ts` | Replace `chatStream` stub with real implementation |
| `packages/llm/src/providers/google.ts` | Replace `chatStream` stub with real implementation |
| `packages/llm/src/providers/anthropic.ts` | Fix `tool_input_delta` `toolUseId` (2-line change) |
| `packages/llm/tests/openai.test.ts` | Add ~6 streaming tests |
| `packages/llm/tests/google.test.ts` | Add ~6 streaming tests |
| `packages/llm/tests/client.test.ts` | Possibly extend provider resolution tests |
| `CLAUDE.md` | Remove "OpenAI and Google providers expose stubs" from known limitations |

---

## 8. Acceptance Criteria

Stage 4c Part 1 is **GREEN** when:

1. `docker compose run --rm dev run test` passes (existing ~665 + ~13 new)
2. `docker compose run --rm dev run typecheck` clean
3. `docker compose run --rm dev run lint` clean
4. OpenAI `chatStream` yields correct `LLMStreamEvent` sequence for text and tool-use responses
5. Google `chatStream` yields correct `LLMStreamEvent` sequence for text and function-call responses
6. Both providers throw `LLM_INVALID_RESPONSE` on incomplete streams
7. Error mapping is consistent across all three providers (rate limit, auth, timeout)
8. Anthropic `tool_input_delta` now carries correct `toolUseId`
9. Executor `streamToResponse` works unchanged with all three providers

---

## 9. Risks

| Risk | Mitigation |
|------|------------|
| OpenAI SDK streaming API changes between versions | Pin SDK version; streaming is stable in v4.x |
| Google `generateContentStream` behaves differently across models | Test with both `gemini-2.0-flash` and `gemini-2.5-pro`; flash is the default |
| Tool call index tracking in OpenAI is fragile | Explicit Map-based buffer with assertions; test with multi-tool responses |
| Live smoke tests are flaky (rate limits, transient errors) | Tests use `skipIf` guards and are isolated from CI pass/fail |
