# Cursor Prompt — Stage 5d Phase 4b: Make Local-Model Runtime Fully Opt-In

> **Purpose:** The local LLM tier (`LocalProvider`, llama.cpp binary) was implemented in Phase 4 but currently ships as a default part of the `dev` image. That is wrong — it adds significant build time (~3–5 min for cmake), image weight, and complexity for contributors who never use it. This change makes local inference a first-class opt-in feature with its own `dev-local` Docker profile, zero impact on `docker compose build dev`, and a clean `.bollard.yml` activation path. Nothing in the pipeline depends on it today; this change ensures nothing accidentally will in the future.

Read CLAUDE.md fully before writing any code. Then read:
- `spec/stage5d-token-economy.md` — Phase 4 design and opt-in framing
- `Dockerfile` — current state: `llamacpp-builder` stage + `COPY --from=llamacpp-builder` in `dev` target
- `compose.yaml` — current state: `bollard_models` volume on both `dev` and `dev-full`
- `packages/llm/src/providers/local.ts` — `LocalProvider`, `checkRamFloor`, `findBinary`
- `packages/llm/src/client.ts` — `case "local"` arm in `resolveProvider`
- `packages/cli/src/config.ts` — `localModelsYamlSchema` and `.bollard.yml` parsing
- `CLAUDE.md` — known limitations section and "Two images: dev and dev-full" section

---

## What to change

### 1 — `Dockerfile`: move llama.cpp out of `dev`, into a new `dev-local` target

**Current state:**
- `llamacpp-builder` stage exists (stages A–D)
- `dev` target copies the binary: `COPY --from=llamacpp-builder /out/llama-cli ...`
- `dev` smoke-test includes `llama-cli --version`

**Target state:**
- `llamacpp-builder` stage stays (renumber comment to Stage E, after dev-full)
- `dev` target: **remove** the `COPY --from=llamacpp-builder` line and remove `llama-cli --version` from the smoke-test RUN
- `dev-full` target: **no change** — it extends `dev`, so it also won't have llama-cli
- Add a new `dev-local` target (Stage F) that extends `dev` and adds the binary:

```dockerfile
# ──────────────────────────────────────────────────────────────
# Stage E — llama.cpp CLI builder (opt-in, same libc as node:22-slim)
# Only consumed by dev-local. Never included in dev or dev-full.
# ──────────────────────────────────────────────────────────────
FROM node:22-slim AS llamacpp-builder
ARG LLAMACPP_VERSION=b9113
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl build-essential cmake pkg-config \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl -fsSL "https://github.com/ggml-org/llama.cpp/archive/refs/tags/${LLAMACPP_VERSION}.tar.gz" \
        -o /tmp/llama.tgz \
    && tar -xzf /tmp/llama.tgz -C /src --strip-components=1 \
    && rm /tmp/llama.tgz
RUN cmake -B build -S . \
        -DCMAKE_BUILD_TYPE=Release \
        -DGGML_NATIVE=OFF \
        -DGGML_STATIC=ON \
        -DBUILD_SHARED_LIBS=OFF \
        -DLLAMA_CURL=OFF \
    && cmake --build build --target llama-cli -j"$(nproc)" \
    && mkdir -p /out \
    && cp build/bin/llama-cli /out/llama-cli

# ──────────────────────────────────────────────────────────────
# Stage F — dev-local (opt-in local LLM tier)
# Extends dev with the llama.cpp binary for LocalProvider inference.
# Models are lazy-pulled at runtime into the bollard_models volume.
#
# Build:  docker compose --profile local build dev-local
# Run:    docker compose --profile local run --rm dev-local <args>
#
# Activate in .bollard.yml:
#   llm:
#     agents:
#       patcher:
#         provider: local
#         model: qwen2.5-coder-1.5b-instruct-q4_k_m
# ──────────────────────────────────────────────────────────────
FROM dev AS dev-local
COPY --from=llamacpp-builder /out/llama-cli /usr/local/bin/llama-cli
RUN llama-cli --version
WORKDIR /app
ENTRYPOINT ["pnpm"]
```

Place `llamacpp-builder` **after** `dev-full` in the file so that `docker compose build dev` and `docker compose --profile full build dev-full` never trigger the llama.cpp cmake build — Docker only builds stages that are reachable from the requested target. With `llamacpp-builder` placed after `dev-full` and only referenced from `dev-local`, it is invisible to both default builds.

**Updated `dev` smoke-test line** (remove `llama-cli --version`):
```dockerfile
RUN bollard-extract-go --version && bollard-extract-rs --version && bollard-extract-java --version
```

---

### 2 — `compose.yaml`: add `dev-local` service behind `local` profile

**Current state:**
- `bollard_models` volume is mounted in both `dev` and `dev-full`
- `BOLLARD_MODEL_REGISTRY_URL` env var on both

**Target state:**
- Remove `bollard_models` volume mount from `dev` (it never uses local inference)
- Remove `bollard_models` volume mount from `dev-full` (same reason)
- Remove `BOLLARD_MODEL_REGISTRY_URL` from `dev` and `dev-full` environments
- Add a new `dev-local` service behind `profiles: ["local"]`:

```yaml
  dev-local:
    profiles: ["local"]
    build:
      context: .
      dockerfile: Dockerfile
      target: dev-local
    volumes:
      - .:/app
      - node_modules:/app/node_modules
      - engine_modules:/app/packages/engine/node_modules
      - llm_modules:/app/packages/llm/node_modules
      - cli_modules:/app/packages/cli/node_modules
      - agents_modules:/app/packages/agents/node_modules
      - verify_modules:/app/packages/verify/node_modules
      - blueprints_modules:/app/packages/blueprints/node_modules
      - detect_modules:/app/packages/detect/node_modules
      - mcp_modules:/app/packages/mcp/node_modules
      - observe_modules:/app/packages/observe/node_modules
      - /var/run/docker.sock:/var/run/docker.sock
      - bollard_models:/var/cache/bollard/models
    working_dir: /app
    env_file:
      - path: .env
        required: false
    environment:
      - NODE_OPTIONS=--disable-warning=DEP0040
      - BOLLARD_MODEL_REGISTRY_URL=${BOLLARD_MODEL_REGISTRY_URL:-}
    entrypoint: ["pnpm"]
```

- Keep `bollard_models:` in the `volumes:` section (it's needed by `dev-local`)
- Remove `bollard_models` from the `dev` and `dev-full` volume mounts only

The `dev-local` service reuses the same `node_modules` named volumes as `dev` so module installs are shared — no separate `node_modules_local` volumes needed.

---

### 3 — `packages/llm/src/providers/local.ts`: add `isBinaryAvailable()` helper

The existing `findBinary()` function throws `LOCAL_MODEL_NOT_AVAILABLE` when the binary is missing. Add a non-throwing probe so callers can check availability without try/catch:

```typescript
/** Returns true if a llama.cpp binary is found on PATH. Never throws. */
export async function isBinaryAvailable(): Promise<boolean> {
  try {
    await findBinary()
    return true
  } catch {
    return false
  }
}
```

Export it alongside `checkRamFloor`, `serializePrompt`, etc. This is the hook Phase 5 will use to decide whether to attempt local routing at all.

---

### 4 — `packages/cli/src/config.ts`: warn when `provider: local` is configured but binary is absent

In `resolveConfig`, after parsing `.bollard.yml`, if any agent in `config.llm.agents` has `provider: "local"`, check `isBinaryAvailable()` and emit a `sources` warning annotation if false:

```typescript
// After YAML parsing, before returning ResolvedConfig:
const localAgents = Object.entries(config.llm.agents ?? {})
  .filter(([, v]) => v.provider === "local")
  .map(([k]) => k)

if (localAgents.length > 0) {
  const available = await isBinaryAvailable()
  if (!available) {
    sources["localModels.binary"] = {
      value: false,
      source: "auto-detected",
      warning:
        "provider: local configured for agents [" +
        localAgents.join(", ") +
        "] but llama-cli binary not found on PATH. " +
        "Build the dev-local image: docker compose --profile local build dev-local",
    }
  }
}
```

The `AnnotatedValue` type may need a `warning?: string` field added if it doesn't already have one — check before adding. If adding it, update `config show` output to print warnings in yellow.

---

### 5 — `CLAUDE.md`: update "Two images" section and known limitations

**In the "Two images: dev and dev-full" section**, add `dev-local` as a third image:

```
- **`dev-local`** (opt-in, ~dev + llama.cpp binary; `bollard_models` volume for lazy model pull):
  extends `dev` with the llama.cpp CLI binary for `LocalProvider` inference. Models (~1 GB GGUF)
  are lazy-pulled into a named Docker volume on first use — the image itself does not include model
  weights. Required when `.bollard.yml` configures `provider: local` for any agent. Built by
  `docker compose --profile local build dev-local`. Run with
  `docker compose --profile local run --rm dev-local …`. Day-to-day contributors and CI never
  need this image unless they are working on Phase 2 (patcher) or Phase 5 (per-agent assignment).
```

**In the known limitations section**, update the local LLM entry to reflect opt-in status and add the activation instructions. Replace the existing "Local LLM provider / token economy work" DO NOT BUILD entry with a completed-but-opt-in entry under the Stage 5d Phase 4 section.

---

### 6 — `spec/stage5d-token-economy.md`: update Phase 4 to reflect opt-in model

In the Phase 4 implementation surface paragraph, replace the sentence about baking the binary into the `dev` image with:

> The llama.cpp binary is **not** included in the default `dev` image — contributors who only work on TS/agent/verify code never need it and should not pay the cmake build cost (~3–5 minutes). Instead, a `dev-local` image target extends `dev` with the binary (Stage F in the Dockerfile), activated via `docker compose --profile local`. The `dev` image retains the `LocalProvider` code and all `LOCAL_MODEL_*` error codes so the provider interface works correctly in tests and the YAML schema parses without error — the binary simply isn't present, causing `findBinary()` to throw `LOCAL_MODEL_NOT_AVAILABLE` gracefully if someone somehow invokes it without the right image.

---

### 7 — Tests: update `local.test.ts` for opt-in reality

The existing test for `LLMClient` resolving `"local"` should still pass — `LocalProvider` is instantiated fine without the binary present; it only fails at inference time. Verify the test does not call `findBinary()` or `resolveModelPath()` directly without mocking the filesystem. If it does, add the appropriate `vi.mock` or temp-dir stubs so it passes on `dev` (where llama-cli is absent after this change).

---

## Validation

```bash
# Default image must build fast (no cmake):
docker compose build dev

# Tests must pass on dev (llama-cli absent):
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test   # all existing tests pass; local.test.ts skips binary-dependent paths

# Opt-in image builds with llama.cpp (slow, first time only):
docker compose --profile local build dev-local

# Verify binary present in dev-local:
docker compose --profile local run --rm dev-local sh -c 'llama-cli --version'

# Verify binary absent in dev:
docker compose run --rm dev sh -c 'which llama-cli && echo FOUND || echo NOT_FOUND'
# Expected: NOT_FOUND
```

No Bollard-on-Bollard self-test for this change — it is infrastructure-only, no pipeline logic changes.

---

## Constraints

- **`dev` and `dev-full` build times must not increase.** The `llamacpp-builder` stage must be placed after `dev-full` in the Dockerfile so Docker's build graph never touches it during `docker compose build dev` or `docker compose --profile full build dev-full`.
- **No pipeline node may require `provider: local`.** `LocalProvider` is user-configurable; zero blueprint nodes call it directly. Phase 2 and Phase 5 will route to it when the user opts in via `.bollard.yml` — they are the only consumers, and they do not exist yet.
- **`LocalProvider` code stays in `@bollard/llm`** — the opt-in is at the image/binary level, not at the TypeScript level. Tests mock `findBinary` to avoid binary-on-PATH assumptions.
- **`bollard_models` volume stays declared** in `compose.yaml` — it is used by `dev-local` and referenced in documentation. Just remove it from `dev` and `dev-full` mounts.
