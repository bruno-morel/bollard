# Cursor Prompt — Stage 5d Phase 4: Local-Model Runtime

> **Purpose:** Add a `LocalProvider` that runs Qwen2.5-Coder-1.5B-Instruct Q4_K_M via the llama.cpp CLI binary baked into the `dev` image. This is the local-model tier from ADR-0004 — the missing middle between deterministic heuristics and frontier API calls. Phase 2 (verification-feedback patcher) and Phase 5 (per-agent model assignment) both depend on this runtime being present and correctly wired into the existing `LLMClient.forAgent` routing.
>
> **Tier (per ADR-0004):** Infrastructure work only. No LLM calls during implementation. Zero new mandatory runtime deps for `dev` users who don't configure `provider: "local"` — the llama.cpp binary is baked in but the model volume is lazy-pulled on first use.

Read CLAUDE.md fully before writing any code. Then read:
- `spec/adr/0004-determinism-local-frontier-tiers.md` — Tier 1/2/3 routing rules
- `spec/stage5d-token-economy.md` — Phase 4 design + RAM floor / CPU latency constraints
- `packages/llm/src/types.ts` — `LLMProvider`, `LLMRequest`, `LLMResponse`, `LLMStreamEvent`
- `packages/llm/src/client.ts` — `LLMClient.resolveProvider` — add `"local"` case here
- `packages/llm/src/providers/anthropic.ts` — reference implementation for `chat` + `chatStream`
- `packages/llm/src/mock.ts` — reference implementation for `chatStream` streaming simulation
- `packages/engine/src/context.ts` — `BollardConfig` — add `localModels?` config block here
- `packages/engine/src/errors.ts` — `BollardErrorCode` — add three new codes here
- `packages/cli/src/config.ts` — `DEFAULTS` and `resolveConfig` — wire `localModels` defaults
- `packages/llm/tests/client.test.ts` — existing test patterns to follow
- `Dockerfile` — `dev` target — add llama.cpp binary install here
- `compose.yaml` — add `bollard_models` named volume, mount into `dev` and `dev-full`

---

## What to build

### Part A — `BollardConfig` extension (`packages/engine/src/context.ts`)

Add a `localModels?` block to `BollardConfig`:

```typescript
export interface LocalModelsConfig {
  /** Minimum free RAM in GB before attempting local inference. Default: 3 */
  minFreeRamGb: number
  /** Hard timeout per inference call in seconds. Default: 60 */
  timeoutSec: number
  /** Named Docker volume mount path for model files. Default: /var/cache/bollard/models */
  cacheDir: string
  /** Max volume size in GB before LRU eviction (informational only in Phase 4). Default: 5 */
  cacheSizeGb: number
  /**
   * URL prefix for pulling model files on first use.
   * Supports BOLLARD_MODEL_REGISTRY_URL env override.
   * Default: https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main
   */
  registryUrl: string
}

// Add to BollardConfig:
export interface BollardConfig {
  llm: { ... }
  agent: { ... }
  localModels?: LocalModelsConfig   // <-- add this
}
```

The `localModels` field is optional — when absent, `LocalProvider` uses its own hardcoded defaults. `BollardConfig` must remain backward-compatible (no existing tests should break).

---

### Part B — Three new error codes (`packages/engine/src/errors.ts`)

Add to `BollardErrorCode`:

```typescript
| "LOCAL_MODEL_NOT_AVAILABLE"  // binary missing OR RAM floor not met — fall through to frontier, not retryable
| "LOCAL_MODEL_PULL_FAILED"    // model file download failed
| "LOCAL_MODEL_TIMEOUT"        // inference exceeded timeoutSec — fall through, not rate-limit backoff
```

`LOCAL_MODEL_NOT_AVAILABLE` and `LOCAL_MODEL_TIMEOUT` must **not** be added to `RETRYABLE_CODES` — they fall through to frontier instead of retrying locally.

---

### Part C — `LocalProvider` (`packages/llm/src/providers/local.ts`)

New file. Implements `LLMProvider` (including `chatStream`).

#### C1 — RAM floor check

```typescript
import os from "node:os"

function checkRamFloor(minFreeRamGb: number): boolean {
  const freeBytes = os.freemem()
  const freeGb = freeBytes / (1024 ** 3)
  return freeGb >= minFreeRamGb
}
```

Called at the start of every `chat()` call. If `false`, throw `LOCAL_MODEL_NOT_AVAILABLE` with context `{ reason: "ram_floor", freeGb, minFreeRamGb }`. The caller (`LLMClient`) catches this and the pipeline degrades gracefully — the spec says "fall through to frontier, never block the pipeline." **Do not** catch inside `LocalProvider` itself — let it propagate so `LLMClient` can route around it.

#### C2 — Model resolution

```typescript
const DEFAULT_MODEL_ID = "qwen2.5-coder-1.5b-instruct-q4_k_m"
const DEFAULT_REGISTRY_URL =
  "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main"
const MODEL_FILENAME = "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf"

async function resolveModelPath(cacheDir: string, registryUrl: string, warn: WarnFn): Promise<string>
```

1. Check `path.join(cacheDir, MODEL_FILENAME)` — if it exists, return it.
2. Check `which llama-cli` (or `llama-cpp` or `llama` — the binary name varies by distro; try all three, use the first found). If binary not found, throw `LOCAL_MODEL_NOT_AVAILABLE` with `{ reason: "binary_missing" }`.
3. Pull the model: `fetch(registryUrl + "/" + MODEL_FILENAME)` with streaming write to a `.part` temp file, then `fs.rename` to the final path. Use a `.lock` file (`cacheDir/MODEL_FILENAME.lock`) to guard concurrent first-pulls — if the lock exists and is less than 5 minutes old, poll every 500ms until the model file appears (max 10 minutes). If pull fails, throw `LOCAL_MODEL_PULL_FAILED`.
4. Return the resolved path.

The registry URL checks `process.env["BOLLARD_MODEL_REGISTRY_URL"]` and uses it over the config value when set.

#### C3 — Prompt serialization

llama.cpp expects a single string prompt, not an OpenAI-style messages array. Serialize `LLMRequest` into a ChatML-formatted string:

```
<|im_start|>system
{system}
<|im_end|>
<|im_start|>user
{user message content}
<|im_end|>
<|im_start|>assistant
```

Only serialize `role: "user"` and `role: "assistant"` messages. Tool calls (`LLMContentBlock` with `type: "tool_use"` or `type: "tool_result"`) are serialized as JSON strings inside the appropriate turn — `LocalProvider` is **not** used for agentic tool-use loops (that is coder territory, which stays frontier). If the request contains `tools`, log a warning and proceed without tool binding — the local model will emit plain text.

#### C4 — Inference invocation

```typescript
async function runInference(
  binaryPath: string,
  modelPath: string,
  prompt: string,
  request: LLMRequest,
  timeoutSec: number,
): Promise<string>
```

Spawn llama.cpp CLI:

```bash
llama-cli \
  --model <modelPath> \
  --prompt <prompt> \
  --n-predict <maxTokens> \
  --temp <temperature> \
  --ctx-size 2048 \
  --threads 4 \
  --no-display-prompt \
  --log-disable \
  -e   # escape newlines in output
```

Use `child_process.spawn` (not `exec` — we need streaming and the prompt can be large). Write the prompt via stdin when it exceeds 2000 characters (use `--file -` flag) to avoid shell argument length limits.

Kill the process and throw `LOCAL_MODEL_TIMEOUT` if it exceeds `timeoutSec * 1000` ms. Capture stderr — if the process exits non-zero, throw `LOCAL_MODEL_NOT_AVAILABLE` with the first 500 chars of stderr as context.

#### C5 — `chat()` implementation

```typescript
async chat(request: LLMRequest): Promise<LLMResponse> {
  if (!checkRamFloor(this.config.minFreeRamGb)) {
    throw new BollardError({ code: "LOCAL_MODEL_NOT_AVAILABLE", ... })
  }
  const modelPath = await resolveModelPath(...)
  const binaryPath = await findBinary()
  const prompt = serializePrompt(request)
  const raw = await runInference(binaryPath, modelPath, prompt, request, this.config.timeoutSec)
  const text = raw.trim()
  // Approximate token counts — llama.cpp doesn't return exact usage; estimate from char count
  const inputTokens = Math.ceil(prompt.length / 4)
  const outputTokens = Math.ceil(text.length / 4)
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens, outputTokens },
    costUsd: 0,  // local inference has no API cost
  }
}
```

#### C6 — `chatStream()` implementation

Word-chunk the output from the process stdout in real time using the same `spawn` approach, yielding `text_delta` events as chunks arrive. Emit `message_complete` when the process exits cleanly. This gives the CLI spinner something to show during local inference (same `stream_delta` events as Anthropic/OpenAI/Google).

```typescript
async *chatStream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
  // RAM check + model resolution same as chat()
  // spawn llama-cli, read stdout chunks, yield text_delta per chunk
  // on process close: yield message_complete with assembled LLMResponse
}
```

---

### Part D — `LLMClient` update (`packages/llm/src/client.ts`)

Add `"local"` case to `resolveProvider`:

```typescript
case "local": {
  const localConfig = this.config.localModels  // may be undefined — LocalProvider uses defaults
  provider = new LocalProvider(localConfig)
  break
}
```

Import `LocalProvider` from `./providers/local.js`.

`LocalProvider` constructor signature: `constructor(config?: LocalModelsConfig)` — when `config` is `undefined`, use internal defaults (same values as the `LocalModelsConfig` field defaults above).

---

### Part E — `BollardConfig` defaults (`packages/cli/src/config.ts`)

The `DEFAULTS` object does **not** need a `localModels` entry — the field is optional in `BollardConfig` and `LocalProvider` self-defaults. However, `resolveConfig` must pass any `localModels:` block from `.bollard.yml` through to `BollardConfig`. Add parsing for this block in the YAML loader (same pattern as `observe:` was added in Stage 4b).

In `.bollard.yml` the block looks like:

```yaml
localModels:
  minFreeRamGb: 3
  timeoutSec: 60
  cacheDir: /var/cache/bollard/models
  cacheSizeGb: 5
  registryUrl: https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main
```

Add a Zod schema for it alongside the existing `observeSchema`. All fields optional in the schema — missing fields fall back to `LocalProvider` internal defaults.

---

### Part F — Dockerfile (`Dockerfile`)

In the `dev` target, add llama.cpp binary installation after the existing apt-get block. Install from pre-built GitHub release binary to keep the image size predictable (avoid building from source — that would add ~500 MB of build deps):

```dockerfile
# llama.cpp binary — lazy model pull at runtime into /var/cache/bollard/models volume
ARG LLAMACPP_VERSION=b5170
RUN arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
         amd64) LLAMACPP_ASSET="llama-${LLAMACPP_VERSION}-bin-ubuntu-x64.zip" ;; \
         arm64) LLAMACPP_ASSET="llama-${LLAMACPP_VERSION}-bin-ubuntu-arm64.zip" ;; \
         *) echo "Unsupported arch: $arch" && exit 1 ;; \
       esac \
    && apt-get update \
    && apt-get install -y --no-install-recommends unzip curl \
    && curl -fsSL "https://github.com/ggerganov/llama.cpp/releases/download/${LLAMACPP_VERSION}/${LLAMACPP_ASSET}" \
         -o /tmp/llamacpp.zip \
    && unzip -j /tmp/llamacpp.zip "*/llama-cli" -d /usr/local/bin \
    && chmod +x /usr/local/bin/llama-cli \
    && rm /tmp/llamacpp.zip \
    && apt-get remove -y unzip curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*
```

**Important:** Keep this in its own RUN layer after the existing apt-get layer so Docker layer cache for pnpm install is not invalidated by llama.cpp version bumps. The `LLAMACPP_VERSION` ARG allows `docker build --build-arg LLAMACPP_VERSION=b5200` overrides.

Verify the binary is present: `RUN llama-cli --version` (same pattern as the extract helpers).

---

### Part G — `compose.yaml`

Add a `bollard_models` named volume and mount it into both `dev` and `dev-full`:

```yaml
# In dev service volumes:
- bollard_models:/var/cache/bollard/models

# In dev-full service volumes:
- bollard_models:/var/cache/bollard/models

# In volumes: section:
bollard_models:
```

Both services share the same volume so a model pulled during a `dev` session is available in `dev-full` and vice versa. Add `BOLLARD_MODEL_REGISTRY_URL` to the `environment:` block of both services (empty string default — overridden by `.env`).

---

### Part H — Tests (`packages/llm/tests/local.test.ts`)

**Do not make live llama.cpp calls in unit tests.** Gate everything behind `BOLLARD_LOCAL_RUNTIME=1`. All unit tests must pass without the binary or model present.

```typescript
describe("LocalProvider", () => {
  describe("RAM floor check", () => {
    it("throws LOCAL_MODEL_NOT_AVAILABLE when free RAM is below floor")
    it("proceeds when free RAM meets floor")
  })

  describe("prompt serialization", () => {
    it("serializes system + user message into ChatML format")
    it("serializes multi-turn conversation correctly")
    it("includes assistant turns in serialized prompt")
    it("logs warning when request includes tools")
  })

  describe("model path resolution", () => {
    it("returns existing model path without pulling")
    it("throws LOCAL_MODEL_NOT_AVAILABLE when binary is missing and model is absent")
    // pull + lock-file behavior tested via temp dir stubs
  })

  describe("LLMResponse shape", () => {
    it("returns costUsd: 0")
    it("returns stopReason: end_turn")
    it("approximates token counts from char length")
  })
})

describe("LLMClient with local provider", () => {
  it("resolves 'local' provider name without throwing")
  it("passes localModels config to LocalProvider")
  it("uses LocalProvider defaults when localModels is undefined")
})

// Live smoke test — skipped unless BOLLARD_LOCAL_RUNTIME=1
describe.skipIf(!process.env["BOLLARD_LOCAL_RUNTIME"])("LocalProvider live", () => {
  it("generates a short completion from a real model")
  it("streams text_delta events via chatStream")
})
```

Test the `serializePrompt` and `checkRamFloor` functions directly by exporting them (named exports — no default exports per Bollard conventions). Mock `os.freemem()` with `vi.spyOn` for the RAM floor tests.

---

### Part I — `packages/llm/src/providers/local.ts` exports

Named exports only:

```typescript
export { LocalProvider }
export { serializePrompt }    // for testing
export { checkRamFloor }      // for testing
export type { LocalProviderConfig }  // alias for LocalModelsConfig, scoped to this file
```

---

## Constraints

- **No new npm packages.** `LocalProvider` uses only Node built-ins (`child_process`, `os`, `fs/promises`, `path`, `crypto` for lock file naming) and the already-present `@bollard/engine` dep. Node's `fetch` is available in Node 22 (no `node-fetch` needed).
- **No shell expansion in spawn args.** Pass all args as an array, never as a shell string. The prompt goes via stdin (temp file or pipe) when it exceeds 2000 characters.
- **`exactOptionalPropertyTypes: true`** — `LocalModelsConfig` fields that are optional in `.bollard.yml` must use `?: ` not `: X | undefined`. `LocalProvider` constructor receives `config?: LocalModelsConfig` and spreads with fallback: `const minFreeRamGb = config?.minFreeRamGb ?? DEFAULT_MIN_FREE_RAM_GB`.
- **No classes beyond `LocalProvider`.** Helper functions (`checkRamFloor`, `serializePrompt`, `resolveModelPath`, `runInference`, `findBinary`) are plain functions in the same file.
- **`chatStream` must be a real `AsyncIterable`**, not a generator that buffers the full response. Stream stdout chunks as they arrive from the llama.cpp process.
- **Binary name detection**: try `llama-cli` first, then `llama-cpp`, then `llama`. The GitHub release builds ship as `llama-cli`; distro packages sometimes differ.
- **The pipeline must never fail because local inference failed.** `LOCAL_MODEL_NOT_AVAILABLE` and `LOCAL_MODEL_TIMEOUT` propagate up to `LLMClient`, and `LLMClient.forAgent` must catch them and re-throw as `PROVIDER_NOT_FOUND` with a note in the context that the caller should configure a frontier fallback. Phase 2 and Phase 5 are responsible for the actual fallback routing — Phase 4 only makes the error visible cleanly.

---

## Validation checklist

```bash
docker compose build dev        # must succeed — llama-cli --version must pass in build
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test   # expect ~978+ passed / 4 skipped (current 966 + ~12 new)
docker compose run --rm dev --filter @bollard/cli run start -- verify --profile
```

The Dockerfile build is the most important check — if llama.cpp binary installation fails or the asset URL changes, the build breaks. Pin `LLAMACPP_VERSION` to a specific release that is confirmed to have both `amd64` and `arm64` assets before committing.

**Do not run a Bollard-on-Bollard self-test for Phase 4 alone** — the self-test validation belongs in Phase 5 after per-agent routing is wired. Phase 4's validation is: binary in image, `LocalProvider` unit tests pass, `LLMClient` resolves `"local"`, no regressions on existing tests.
