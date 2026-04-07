# Stage 2 — Docker Isolation, MCP Server, Multi-Provider, In-Language Adversarial Tests

> Paste this into Cursor's Composer. Read `CLAUDE.md` at the repo root for full context. Read `spec/06-toolchain-profiles.md` for the verification layer design and `spec/02-bootstrap.md` Stage 2 section for the build plan.

---

## Prompt

I'm building **Bollard**, an artifact integrity framework for AI-assisted software development. Read `CLAUDE.md` for full context.

We've completed Stage 2's agent infrastructure fixes (edit_file tool, deeper type extraction, write-tests node fixes, coder turn budget). This prompt builds the **second half of Stage 2**: Docker-isolated verification containers, LLM fallback signature extraction, in-language adversarial test generation, an MCP server, and OpenAI/Google LLM providers.

Here's what exists today:

- **7 packages:** engine, llm, agents, verify, blueprints, detect, cli
- **24 test files, 269 tests**, all passing
- **~5200 source LOC, ~3690 test LOC, ~238 prompt LOC**
- **30 adversarial test files** (separate Vitest config)
- **6 agent tools:** read_file, write_file, edit_file, list_dir, search, run_command
- **3 agents:** planner (read-only tools, 25 turns), coder (6 tools, 60 turns), tester (no tools, 5 turns)
- **Profile-driven verification** via `ToolchainProfile` threaded through all agents, static checks, dynamic tests
- **SignatureExtractor interface** with `TsCompilerExtractor` (working) and `LlmFallbackExtractor` (stub returning empty)

### What this prompt builds

1. **Docker-isolated verification containers** — `Dockerfile.verify`, language-specific images, `compose.verify.yml` generation
2. **LLM fallback signature extractor** — implement `LlmFallbackExtractor` for non-TypeScript languages
3. **In-language adversarial test generation** — tester agent generates tests in the project's own language/framework
4. **Adversarial test lifecycle** — ephemeral (default) + persistent-native (opt-in) modes
5. **MCP server** — expose Bollard as MCP tools for Claude Code / Cursor integration
6. **OpenAI + Google LLM providers** — extend `LLMClient` with `openai` and `google` provider implementations

### Build order

Complete each step fully before moving to the next. Run tests after each step.

---

### Step 1: Docker verification images

Create the Docker infrastructure for isolated adversarial test execution.

**1a: Create `docker/Dockerfile.verify`** — Bollard's black-box adversarial test container:

```dockerfile
FROM node:22-slim AS bollard-verify
WORKDIR /bollard

# Install test tooling
RUN corepack enable && corepack prepare pnpm@latest --activate

# Bollard's own test dependencies: vitest, fast-check, HTTP/CLI clients
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/engine/package.json packages/engine/package.json
COPY packages/llm/package.json packages/llm/package.json
COPY packages/verify/package.json packages/verify/package.json
COPY packages/detect/package.json packages/detect/package.json
COPY packages/agents/package.json packages/agents/package.json
COPY packages/blueprints/package.json packages/blueprints/package.json
COPY packages/cli/package.json packages/cli/package.json

RUN pnpm install --frozen-lockfile

COPY . .

# Default: run adversarial tests against mounted workspace
ENTRYPOINT ["pnpm", "exec", "vitest", "run"]
CMD ["--config", "vitest.adversarial.config.ts"]
```

This image is always Node.js — it runs Bollard's own TypeScript adversarial tests. It does NOT include Python/Go/Rust. Black-box tests written in TypeScript execute in this container against the project's public interfaces.

**1b: Create `docker/Dockerfile.verify-python`:**

```dockerfile
FROM node:22-slim AS base
WORKDIR /bollard
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/ packages/
RUN pnpm install --frozen-lockfile
COPY . .

FROM base AS verify-python
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/*
ARG PIP_PACKAGES="pytest mypy ruff pip-audit"
RUN pip install --break-system-packages ${PIP_PACKAGES}
ENTRYPOINT ["pnpm", "exec", "tsx"]
CMD ["packages/cli/src/index.ts", "verify"]
```

**1c: Create `docker/Dockerfile.verify-go`:**

```dockerfile
FROM node:22-slim AS base
WORKDIR /bollard
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/ packages/
RUN pnpm install --frozen-lockfile
COPY . .

FROM base AS verify-go
COPY --from=golang:1.22 /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}"
RUN go install golang.org/x/vuln/cmd/govulncheck@latest
ENTRYPOINT ["pnpm", "exec", "tsx"]
CMD ["packages/cli/src/index.ts", "verify"]
```

**1d: Create `docker/Dockerfile.verify-rust`:**

```dockerfile
FROM node:22-slim AS base
WORKDIR /bollard
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/ packages/
RUN pnpm install --frozen-lockfile
COPY . .

FROM base AS verify-rust
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl build-essential && rm -rf /var/lib/apt/lists/*
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"
RUN cargo install cargo-audit cargo-mutants
ENTRYPOINT ["pnpm", "exec", "tsx"]
CMD ["packages/cli/src/index.ts", "verify"]
```

**1e: Create `packages/verify/src/compose-generator.ts`** — generates a `compose.verify.yml` from the `ToolchainProfile`:

```typescript
import type { ToolchainProfile } from "@bollard/detect/src/types.js"

export interface VerifyComposeConfig {
  workDir: string
  profile: ToolchainProfile
  bollardImageTag?: string // default: "latest"
}

export interface GeneratedCompose {
  yaml: string
  services: string[] // names of services in the generated compose
}

export function generateVerifyCompose(config: VerifyComposeConfig): GeneratedCompose {
  // ...
}
```

The function generates YAML with these services:

1. **`project-verify`** — runs the project's own test suite using `profile.checks.test`. Image is `profile.adversarial.runtimeImage` (e.g., `python:3.12-slim`, `golang:1.22`, `rust:1.77`) or `node:22-slim` for TS/JS. Mounts `workDir` as `/workspace`.

2. **`verify-blackbox`** — always present. Runs Bollard's TypeScript adversarial tests in the `bollard/verify` image. Mounts `workDir` as `/workspace:ro`. Depends on `project-verify`.

3. **`verify-native`** — present only when `profile.adversarial.mode` is `"in-language"` or `"both"`. Uses the same image as `project-verify`. Mounts `workDir` as `/workspace:ro` and `.bollard/tests` as `/tests`. Runs the language-specific test command against the adversarial tests.

The generated YAML must be valid Docker Compose v3. Use string concatenation (no YAML library dependency — remember: minimize deps). Use proper indentation.

The function also derives the `runtimeImage` if not explicitly set in the profile — use a lookup:

```typescript
const DEFAULT_IMAGES: Partial<Record<LanguageId, string>> = {
  typescript: "node:22-slim",
  javascript: "node:22-slim",
  python: "python:3.12-slim",
  go: "golang:1.22",
  rust: "rust:1.77-slim",
}
```

**Write tests:**
- Generates valid YAML for a TypeScript profile (all 3 services use Node.js)
- Generates valid YAML for a Python profile (project + native use Python image, blackbox uses Bollard image)
- `verify-native` service absent when `adversarial.mode` is `"blackbox"`
- `verify-native` service present when mode is `"both"` or `"in-language"`
- Custom `runtimeImage` in profile overrides the default lookup
- Generated YAML includes correct volume mounts and environment variables

---

### Step 2: Implement `LlmFallbackExtractor`

The stub in `packages/verify/src/type-extractor.ts` currently returns empty. Implement it.

The `LlmFallbackExtractor` class needs access to an `LLMProvider` and model string. Update the constructor:

```typescript
export class LlmFallbackExtractor implements SignatureExtractor {
  constructor(
    private readonly provider: LLMProvider,
    private readonly model: string,
  ) {}

  async extract(files: string[], _profile?: ToolchainProfile): Promise<ExtractionResult> {
    // ...
  }
}
```

The implementation:
1. Read each file's contents
2. Send a structured prompt to the LLM asking it to extract:
   - Exported function signatures (no bodies)
   - Exported type/interface/enum definitions
   - Import statements
3. Parse the LLM's response into `ExtractedSignature[]` and `ExtractedTypeDefinition[]`
4. Return the combined `ExtractionResult`

The system prompt should be focused and deterministic:

```
You extract public API signatures from source code. You receive source files and output ONLY a JSON object with the extracted signatures.

For each file, extract:
1. All exported function/method signatures (replace bodies with "{ ... }")
2. All exported type definitions (interfaces, types, enums, constants with type annotations)
3. Import statements

Output format (strict JSON, no markdown fences):
{
  "signatures": [
    {
      "filePath": "path/to/file.py",
      "signatures": "def get_user(id: int) -> User: ...\ndef list_users(limit: int = 100) -> list[User]: ...",
      "types": "class User:\n    id: int\n    name: str\n    email: str",
      "imports": "from dataclasses import dataclass\nfrom typing import Optional"
    }
  ],
  "types": [
    {
      "name": "User",
      "kind": "interface",
      "definition": "class User:\n    id: int\n    name: str\n    email: str",
      "filePath": "path/to/file.py"
    }
  ]
}
```

Use `temperature: 0` for maximum determinism. Use `maxTokens: 4096` per file. If extraction fails (LLM error, parse error), log a warning and return empty for that file — don't throw.

**Update `getExtractor`:**

```typescript
export function getExtractor(lang: LanguageId, provider?: LLMProvider, model?: string): SignatureExtractor {
  if (lang === "typescript") {
    return new TsCompilerExtractor()
  }
  if (provider && model) {
    return new LlmFallbackExtractor(provider, model)
  }
  // No provider available — return empty extractor
  return new LlmFallbackExtractor(
    { name: "noop", chat: async () => ({ content: [], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0 }) },
    "noop",
  )
}
```

**Update the blueprint's `extract-signatures` node** to use `getExtractor` with the LLM provider for non-TS languages. The `createAgenticHandler` already has access to the `LLMClient` — thread the provider through to the extract-signatures node. One way: store the LLM client reference in `PipelineContext` or pass it via a closure.

**Important:** the `extract-signatures` node currently has an early return for non-TypeScript:

```typescript
if (profile && profile.language !== "typescript") {
  return { status: "ok", data: { filesExtracted: 0, signatures: [], types: [] } }
}
```

Replace this with the LLM fallback extractor call.

**Write tests:**
- `LlmFallbackExtractor` with a `MockProvider` returning structured JSON → correct `ExtractionResult`
- `LlmFallbackExtractor` with a `MockProvider` returning garbage → empty result, no throw
- `LlmFallbackExtractor` with a `MockProvider` returning empty → empty result
- `getExtractor("typescript")` returns `TsCompilerExtractor`
- `getExtractor("python", provider, model)` returns `LlmFallbackExtractor`
- `getExtractor("python")` without provider returns empty extractor

---

### Step 3: In-language adversarial test generation

The tester agent currently always generates TypeScript vitest tests. For non-TypeScript projects, it needs to generate tests in the project's own language and framework.

**3a: Update the tester prompt (`packages/agents/prompts/tester.md`).**

The tester prompt currently hardcodes vitest. Make the test framework template-driven. Replace Rule 6 and the Output Format section:

```markdown
6. **Use {{testFramework}}.** Import from the public API surface shown in the signatures. Don't import internal modules.
```

Update the Output Format section to be conditional on language:

```markdown
# Output Format

Output ONLY the test file content. No explanatory text. The output will be written directly to a test file.

{{#if isTypeScript}}
Start with imports, then describe blocks:

\`\`\`typescript
import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import { ... } from "../src/module.js"

describe("Feature: <acceptance criterion 1>", () => {
  it("should ...", () => { ... })
})
\`\`\`
{{else if isPython}}
Start with imports, then test classes or functions:

\`\`\`python
import pytest
from hypothesis import given, strategies as st
from module import ...

class TestFeatureCriterion1:
    def test_should_do_something(self):
        ...

    @given(st.integers())
    def test_property_invariant(self, n):
        ...
\`\`\`
{{else if isGo}}
Start with package declaration and imports:

\`\`\`go
package module_test

import (
    "testing"
    "github.com/stretchr/testify/assert"
)

func TestFeatureCriterion1(t *testing.T) {
    t.Run("should do something", func(t *testing.T) {
        ...
    })
}
\`\`\`
{{else if isRust}}
Start with use declarations:

\`\`\`rust
use super::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_feature_criterion_1() {
        ...
    }
}
\`\`\`
{{else}}
Use the test framework conventions appropriate for the language. Start with imports, then structured test cases.
{{/if}}
```

**Important:** The template system uses `fillPromptTemplate` from `packages/agents/src/prompt-template.ts`. The current implementation is a simple `replaceAll` loop over `{{variable}}` → value pairs. It does NOT support conditionals. You need to extend it to support:

- `{{#if varName}} ... {{else if varName2}} ... {{else}} ... {{/if}}` blocks
- The variables `isTypeScript`, `isPython`, `isGo`, `isRust` derived from `profile.language`

The current function signature is `fillPromptTemplate(template: string, profile: ToolchainProfile): string`. The current replacements map is:

```typescript
const replacements: Record<string, string> = {
  "{{language}}": capitalize(profile.language),
  "{{packageManager}}": profile.packageManager ?? "none",
  "{{typecheck}}": profile.checks.typecheck?.label ?? "none",
  "{{linter}}": profile.checks.lint?.label ?? "none",
  "{{testFramework}}": profile.checks.test?.label ?? "none",
  "{{auditTool}}": profile.checks.audit?.label ?? "none",
  "{{allowedCommands}}": profile.allowedCommands.join(", "),
  "{{sourcePatterns}}": profile.sourcePatterns.join(", "),
  "{{testPatterns}}": profile.testPatterns.join(", "),
}
```

Add the language booleans to this map (as truthy/falsy strings), then process `{{#if}}` blocks BEFORE the simple variable replacement pass. Keep the implementation simple — no dependency on Handlebars or Mustache. A regex-based approach works fine for this limited set of conditionals.

Process order: `{{#if}}` blocks first → `{{variable}}` replacements second.

**3b: Update `buildTesterMessage` in `agent-handler.ts`.**

Currently the instructions section says "Write a complete test file. Output ONLY the TypeScript test code." Make this language-aware:

```typescript
const lang = ctx.toolchainProfile?.language ?? "typescript"
const langLabel = lang === "typescript" ? "TypeScript" : lang === "python" ? "Python" : lang === "go" ? "Go" : lang === "rust" ? "Rust" : lang

sections.push(
  "# Instructions",
  `Write a complete test file in ${langLabel}. Output ONLY the ${langLabel} test code, no explanations.`,
)
```

**3c: Update `deriveAdversarialTestPath` in `packages/blueprints/src/write-tests-helpers.ts`.**

The current function signature is `deriveAdversarialTestPath(sourceFile: string): string`. It only handles TypeScript naming (`.adversarial.test.ts`). Add an optional `ToolchainProfile` parameter:

```typescript
export function deriveAdversarialTestPath(
  sourceFile: string,
  profile?: ToolchainProfile,
): string {
  const lang = profile?.language ?? "typescript"

  // Current behavior (TS/JS): uses .adversarial.test{ext} suffix, src/ → tests/ swap
  // Python: test_adversarial_{basename}.py, src/ → tests/ swap
  // Go: {basename}_adversarial_test.go (stays alongside source — Go convention)
  // Rust: {basename}_adversarial_test.rs, src/ → tests/ swap
}
```

Language-specific naming conventions:

| Language | Source | Test Path |
|----------|--------|-----------|
| TypeScript | `packages/cli/src/index.ts` | `packages/cli/tests/index.adversarial.test.ts` |
| Python | `src/auth.py` | `tests/test_adversarial_auth.py` |
| Go | `pkg/auth.go` | `pkg/auth_adversarial_test.go` (Go tests live alongside source) |
| Rust | `src/auth.rs` | `tests/auth_adversarial_test.rs` |

**Preserve backward compatibility:** calling `deriveAdversarialTestPath(file)` without a profile must produce the same result as before (TypeScript behavior). Update the call site in `implement-feature.ts` to pass `ctx.toolchainProfile`.

**3d: Update `stripMarkdownFences` to handle all language fences.**

Currently strips ` ```typescript `. Extend to strip ` ```python `, ` ```go `, ` ```rust `, ` ```js `, etc. The existing regex `^```\w*\n` should already handle this — verify it does.

**Write tests:**
- `fillPromptTemplate` handles `{{#if isTypeScript}}...{{/if}}` blocks correctly
- `fillPromptTemplate` handles `{{#if isPython}}...{{else}}...{{/if}}`
- `fillPromptTemplate` handles nested `{{else if}}` chains
- `deriveAdversarialTestPath` for Python: `src/auth.py` → `tests/test_adversarial_auth.py`
- `deriveAdversarialTestPath` for Go: `pkg/auth.go` → `pkg/auth_adversarial_test.go`
- `deriveAdversarialTestPath` for Rust: `src/auth.rs` → `tests/auth_adversarial_test.rs`
- `createTesterAgent` with Python profile produces a prompt mentioning pytest

---

### Step 4: Adversarial test lifecycle — ephemeral + persistent-native

**4a: Add `adversarial.persist` to the config schema.**

In `packages/detect/src/types.ts`, extend the `adversarial` field:

```typescript
adversarial: {
  mode: "blackbox" | "in-language" | "both"
  runtimeImage?: string
  persist?: boolean  // NEW: false = ephemeral (default), true = persistent-native
}
```

In `packages/cli/src/config.ts`, add `adversarial.persist` to the Zod schema for `.bollard.yml`.

**4b: Create `packages/verify/src/test-lifecycle.ts`:**

```typescript
import type { ToolchainProfile } from "@bollard/detect/src/types.js"

export type TestLifecycle = "ephemeral" | "persistent-native" | "persistent-isolated"

export interface AdversarialTestSet {
  featureSlug: string
  runId: string
  lifecycle: TestLifecycle
  testFiles: string[]    // relative paths
  language: string
  framework: string
  createdAt: string      // ISO 8601
}

/**
 * Determine where to write adversarial tests based on profile and lifecycle.
 * Ephemeral: .bollard/runs/{runId}/adversarial-native/ (or adversarial-blackbox/)
 * Persistent-native: .bollard/tests/{featureSlug}/
 */
export function resolveTestOutputDir(
  workDir: string,
  runId: string,
  featureSlug: string,
  lifecycle: TestLifecycle,
  mode: "blackbox" | "native",
): string { ... }

/**
 * Write the _bollard.json metadata file alongside adversarial tests.
 *
 * Fields (from spec/06-toolchain-profiles.md Section 13):
 *   blueprintId: string       — e.g., "implement-feature"
 *   runId: string             — e.g., "20260329-feat-auth-retry"
 *   task: string              — human-readable feature description
 *   featureSlug: string       — e.g., "auth-retry"
 *   generatedAt: string       — ISO 8601 timestamp
 *   agentModel: string        — e.g., "claude-sonnet-4-20250514"
 *   testFramework: string     — e.g., "pytest", "vitest"
 *   testCount: number         — count of generated tests
 *   replaces: string | null   — previous runId this set replaces
 */
export function writeTestMetadata(
  outputDir: string,
  testSet: AdversarialTestSet,
): Promise<void> { ... }

/**
 * For persistent-native mode, configure the project's test runner
 * to discover tests in .bollard/tests/.
 */
export function integrateWithTestRunner(
  workDir: string,
  profile: ToolchainProfile,
): Promise<{ integrated: boolean; method: string }> { ... }
```

The `integrateWithTestRunner` function:
- For **pytest**: Check if `pyproject.toml` exists. If so, ensure `testpaths` includes `.bollard/tests`. Alternatively, return a `--rootdir` flag that gets appended to the test command.
- For **vitest/jest**: Check `vitest.config.ts` or `jest.config.*`. Return include pattern `.bollard/tests/**/*.test.ts`.
- For **go test**: Go tests must be in the package directory. Return instructions noting that `.bollard/tests/` won't work for Go — fall back to persistent-isolated.
- For **cargo test**: Rust integration tests go in `tests/` at crate root. Can add a `[[test]]` target in `Cargo.toml`.

**Important:** `integrateWithTestRunner` must be NON-DESTRUCTIVE. It should only ADD configuration, never remove or overwrite existing test paths. If integration isn't possible (Go's constraint), return `{ integrated: false, method: "persistent-isolated fallback" }`.

**4c: Update the `write-tests` node in `implement-feature.ts`.**

The current node always writes to a single derived path. Update it to:
1. Check `ctx.toolchainProfile?.adversarial.persist` to determine lifecycle
2. Call `resolveTestOutputDir` to get the correct directory
3. Write test files there
4. Call `writeTestMetadata` to create `_bollard.json`
5. If persistent-native, call `integrateWithTestRunner`

**4d: Add `.bollard/` directory handling.**

The `.bollard/runs/` directory should be in `.gitignore`. The `.bollard/tests/` directory should NOT be gitignored (persistent tests are committed). Add a `.bollard/.gitignore`:

```
runs/
```

**4e: Add `promote-test` CLI command** (in `packages/cli/src/index.ts`):

```bash
bollard promote-test .bollard/tests/auth-edge-cases/test_auth.py
# or
bollard promote-test .bollard/runs/abc123/adversarial-native/test_auth.py
```

This command:
1. Copies the test file from `.bollard/` to the project's test directory
2. Strips any Bollard metadata comments
3. Verifies it runs under the project's test runner
4. Reports success

**Write tests:**
- `resolveTestOutputDir` returns correct path for ephemeral mode
- `resolveTestOutputDir` returns correct path for persistent-native mode
- `writeTestMetadata` creates valid `_bollard.json`
- `integrateWithTestRunner` for pytest adds testpaths to pyproject.toml (use temp dir fixture)
- `integrateWithTestRunner` for Go returns `integrated: false`
- Lifecycle determination: `persist: true` → `"persistent-native"`, `persist: false` → `"ephemeral"`, default → `"ephemeral"`

---

### Step 5: MCP server

Create `packages/mcp/` — a new workspace package that exposes Bollard as MCP tools.

**5a: Add the package.**

```
packages/mcp/
├── package.json
├── tsconfig.json
├── src/
│   ├── server.ts        # MCP server entry point
│   ├── tools.ts         # Tool definitions
│   └── transport.ts     # stdio transport
└── tests/
    └── tools.test.ts
```

`package.json`:
```json
{
  "name": "@bollard/mcp",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "start": "tsx src/server.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
}
```

**Add `@bollard/mcp` to `pnpm-workspace.yaml`** (it's already `packages/*` so it should be auto-discovered). Add the package.json to the Dockerfile COPY list. Update the compose.yaml volumes.

**5b: Implement the MCP tools in `packages/mcp/src/tools.ts`:**

Expose these MCP tools:

| Tool | Description | Maps to |
|------|-------------|---------|
| `bollard_verify` | Run static verification on the workspace | `runStaticChecks` |
| `bollard_plan` | Generate a plan for a task | Planner agent |
| `bollard_implement` | Run the full implement-feature pipeline | `runBlueprint(implementFeature)` |
| `bollard_eval` | Run agent eval sets | Eval runner |
| `bollard_config` | Show resolved configuration | Config show |
| `bollard_profile` | Show detected toolchain profile | `detectToolchain` |

Each tool:
- Validates input with Zod
- Calls the underlying Bollard function
- Returns structured JSON results
- Handles errors by returning BollardError details

**5c: Implement the transport in `packages/mcp/src/transport.ts`.**

Use the `@modelcontextprotocol/sdk` package for stdio transport. The server:
1. Reads JSON-RPC messages from stdin
2. Routes to the appropriate tool handler
3. Writes JSON-RPC responses to stdout
4. Logs to stderr (never stdout — that's the protocol channel)

**5d: Implement `packages/mcp/src/server.ts`:**

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { tools } from "./tools.js"

const server = new Server(
  { name: "bollard", version: "0.1.0" },
  { capabilities: { tools: {} } },
)

// Register tool handlers
for (const tool of tools) {
  server.setRequestHandler(/* ... */)
}

const transport = new StdioServerTransport()
await server.connect(transport)
```

**5e: Generate `.bollard/mcp.json` manifest** during `bollard init`:

```json
{
  "mcpServers": {
    "bollard": {
      "command": "pnpm",
      "args": ["--filter", "@bollard/mcp", "run", "start"],
      "env": {
        "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}"
      }
    }
  }
}
```

**Write tests:**
- Each MCP tool validates input schema and returns expected output format
- Invalid input returns structured error
- Tool registration covers all 6 tools
- Test against MockProvider (no real LLM calls)

**After adding the package, update the lockfile:**

```bash
docker run --rm -e CI=true -v "$(pwd):/app" -w /app node:22-slim \
  sh -c "corepack enable && corepack prepare pnpm@latest --activate && pnpm install --no-frozen-lockfile"
docker compose build dev
docker compose down -v
```

---

### Step 6: OpenAI + Google LLM providers

**6a: Install SDKs.**

```bash
docker compose run --rm dev add --filter @bollard/llm openai @google/generative-ai
docker compose build dev
```

**6b: Create `packages/llm/src/providers/openai.ts`:**

```typescript
import OpenAI from "openai"
import { BollardError } from "@bollard/engine/src/errors.js"
import type { LLMContentBlock, LLMProvider, LLMRequest, LLMResponse } from "../types.js"

const PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "o3-mini": { input: 1.1, output: 4.4 },
}

const DEFAULT_PRICING = { input: 2.5, output: 10 }

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai"
  private readonly client: OpenAI

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey })
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    // Map Bollard's LLMRequest to OpenAI's ChatCompletionCreateParams
    // Map tool_use content blocks to OpenAI function calling format
    // Map OpenAI's response back to Bollard's LLMResponse
    // Handle errors with BollardError codes (rate limit, auth, timeout, etc.)
  }
}
```

Key mapping differences from Anthropic:
- OpenAI uses `functions` / `tools` with `function` type, Anthropic uses `tools` directly
- OpenAI uses `finish_reason: "tool_calls"`, Anthropic uses `stop_reason: "tool_use"`
- OpenAI tool call format: `tool_calls[].function.name`, `tool_calls[].function.arguments` (JSON string)
- Bollard tool call format: `toolName`, `toolInput` (parsed object)
- OpenAI system message is a message with `role: "system"`, Anthropic has a separate `system` field
- OpenAI content blocks are structured differently (tool results use `role: "tool"`)

Map error types:
- `RateLimitError` → `LLM_RATE_LIMIT`
- `AuthenticationError` → `LLM_AUTH`
- `APIConnectionTimeoutError` → `LLM_TIMEOUT`
- All others → `LLM_PROVIDER_ERROR`

**6c: Create `packages/llm/src/providers/google.ts`:**

```typescript
import { GoogleGenerativeAI } from "@google/generative-ai"
import { BollardError } from "@bollard/engine/src/errors.js"
import type { LLMContentBlock, LLMProvider, LLMRequest, LLMResponse } from "../types.js"

const PRICING: Record<string, { input: number; output: number }> = {
  "gemini-2.0-flash": { input: 0.10, output: 0.40 },
  "gemini-2.5-pro-preview-05-06": { input: 1.25, output: 10 },
}

const DEFAULT_PRICING = { input: 0.10, output: 0.40 }

export class GoogleProvider implements LLMProvider {
  readonly name = "google"
  private readonly client: GoogleGenerativeAI

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey)
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    // Map Bollard's LLMRequest to Google's GenerateContentRequest
    // Map tool definitions to Google's FunctionDeclaration format
    // Map Google's response back to Bollard's LLMResponse
    // Handle errors with BollardError codes
  }
}
```

Key mapping differences:
- Google uses `functionDeclarations` for tools, structured as `{ name, description, parameters }` (OpenAPI-style)
- Google function call results use `functionResponse` parts
- Google system instruction is a separate field (`systemInstruction`)
- Token usage is in `response.usageMetadata` with `promptTokenCount` and `candidatesTokenCount`
- Google's tool call format uses `functionCall.name` and `functionCall.args` (already parsed object)

**6d: Register both providers in `LLMClient`:**

```typescript
// In packages/llm/src/client.ts, add to resolveProvider switch:
case "openai": {
  const apiKey = process.env["OPENAI_API_KEY"]
  if (!apiKey) {
    throw new BollardError({
      code: "CONFIG_INVALID",
      message: "OPENAI_API_KEY environment variable is not set",
    })
  }
  provider = new OpenAIProvider(apiKey)
  break
}
case "google": {
  const apiKey = process.env["GOOGLE_API_KEY"]
  if (!apiKey) {
    throw new BollardError({
      code: "CONFIG_INVALID",
      message: "GOOGLE_API_KEY environment variable is not set",
    })
  }
  provider = new GoogleProvider(apiKey)
  break
}
```

**6e: Add environment variables to Docker:**

In `compose.yaml`, add:
```yaml
environment:
  - OPENAI_API_KEY=${OPENAI_API_KEY:-}
  - GOOGLE_API_KEY=${GOOGLE_API_KEY:-}
```

**Write tests:**
- `OpenAIProvider` maps a simple text request/response correctly (mock the OpenAI SDK)
- `OpenAIProvider` maps tool_use correctly (function calling format)
- `OpenAIProvider` maps errors to correct BollardError codes
- `GoogleProvider` maps a simple text request/response correctly
- `GoogleProvider` maps tool_use correctly (functionCall format)
- `GoogleProvider` maps errors to correct BollardError codes
- `LLMClient.resolveProvider("openai")` returns `OpenAIProvider`
- `LLMClient.resolveProvider("google")` returns `GoogleProvider`
- Each provider has a live smoke test (skips if no key, like the existing Anthropic test)

---

### Step 7: Wire Docker isolation into the blueprint

Update the `implement-feature` blueprint to use Docker-isolated verification.

**7a: Add a new optional blueprint node `docker-verify`** after `run-tests`:

```typescript
{
  id: "docker-verify",
  name: "Docker-Isolated Verification",
  type: "deterministic",
  execute: async (ctx: PipelineContext): Promise<NodeResult> => {
    const profile = ctx.toolchainProfile
    if (!profile) {
      // No profile — skip Docker isolation
      return { status: "ok", data: { skipped: true, reason: "no toolchain profile" } }
    }

    // Generate compose.verify.yml
    const compose = generateVerifyCompose({ workDir, profile })

    // Write to .bollard/compose.verify.yml
    // Execute: docker compose -f .bollard/compose.verify.yml up --abort-on-container-exit
    // Parse exit codes
    // Return pass/fail
  }
}
```

**Important:** Docker-in-Docker is required. The `compose.yaml` dev service needs `docker.sock` mounted for this to work. Add to the dev service:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

**However**, for environments without Docker-in-Docker (CI without DinD, local without Docker), the `docker-verify` node should gracefully degrade:
- Check if `docker compose` is available
- If not, log a warning and return `{ status: "ok", data: { skipped: true, reason: "docker not available" } }`
- Don't fail the pipeline

**7b: Update the blueprint node list.** The new order:

```
1.  create-branch
2.  generate-plan
3.  approve-plan
4.  implement
5.  static-checks
6.  extract-signatures
7.  generate-tests
8.  write-tests
9.  run-tests           ← project tests (Layer 1)
10. docker-verify       ← adversarial tests in Docker (Layer 2) — NEW
11. generate-diff
12. approve-pr
```

**Write tests:**
- Blueprint now has 12 nodes
- `docker-verify` node is at position 10 (after run-tests)
- `docker-verify` skips gracefully when Docker is unavailable
- `docker-verify` skips when no profile is present

---

### Step 8: Update `bollard init` for adversarial lifecycle

Extend the `init` command to ask about adversarial test lifecycle:

After detecting the toolchain, prompt:

```
? Adversarial test lifecycle:
  > Ephemeral (recommended — generated fresh each run, results kept, tests discarded)
    Persistent (tests kept per feature, integrated with your test runner, visible in PRs)
```

Store the choice in `.bollard.yml` as `adversarial.persist: true | false`.

Also ask about adversarial mode:

```
? Adversarial test mode:
  > Black-box only (tests written in TypeScript, run against public interfaces)
    In-language (tests written in your project's language and framework)
    Both (black-box + in-language)
```

Store as `adversarial.mode: "blackbox" | "in-language" | "both"`.

**Write tests:**
- Init creates `.bollard.yml` with correct adversarial config
- Default lifecycle is ephemeral
- Default mode is blackbox

---

### Step 9: Verify everything end-to-end

Run the full suite:

```bash
docker compose build dev
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev run test
docker compose run --rm dev --filter @bollard/cli run start -- verify
```

All existing 269 tests must pass, plus all new tests from Steps 1–8.

Then run the retro-adversarial script to validate:

```bash
docker compose run --rm --entrypoint sh dev -c "pnpm exec tsx scripts/retro-adversarial.ts"
```

Record:
- Test count before and after
- Adversarial pass rate
- Any new failure patterns

---

### Step 10: Update CLAUDE.md

Update to reflect the completed Stage 2:

- **Packages:** 8 (add @bollard/mcp)
- **LLM providers:** Anthropic, OpenAI, Google
- **Agent tools:** 6 (unchanged)
- **Docker images:** `bollard/verify` (black-box), language-specific (Python, Go, Rust)
- **Adversarial test lifecycle:** ephemeral (default) + persistent-native (opt-in)
- **MCP server:** `@bollard/mcp` with 6 tools
- **Type extractor:** TS compiler + LLM fallback for all other languages
- **Blueprint:** 12 nodes (add docker-verify)
- **Scope control:** Mark ALL Stage 2 items as DONE. Update "DO NOT build yet" to reference Stage 3 only.
- **Test stats:** Update counts
- **Size section:** Update LOC counts
- **Known limitations:** Remove items now addressed. Add any new limitations discovered.

---

### Deferred Issues (Post-Stage 2, for Stage 3)

These are NOT addressed by this prompt:

- **Per-language mutation testing** (Stryker, mutmut, cargo-mutants) — Stage 3
- **Semantic review agent** — Stage 3
- **Production probes, drift detection, flag manager** — Stage 3
- **Git rollback on coder max-turns failure** — Stage 3
- **Verification summary batching** — Stage 3
- **Deterministic type extractors for Python/Go/Rust** (ast, go doc, cargo doc) — Stage 3 (LLM fallback covers these for now)
- **CI integration, run history, self-improvement** — Stage 4

---

### Important reminders

- **Read CLAUDE.md before starting.** It has the current state, all types, all conventions.
- **Steps are ordered by dependency.** Don't skip ahead.
- **Minimize new dependencies.** The MCP SDK is necessary. OpenAI and Google SDKs are necessary. No other new deps. Generate YAML by string concatenation, not a YAML library.
- **Preserve ALL existing behavior.** Every existing test must pass unchanged. Functions that work without profiles must continue to work.
- **The tester Rules 8–15 are sacrosanct.** Don't modify them (except Rule 6's `{{testFramework}}` placeholder which is already templated).
- **Test each step individually before moving to the next.** Run `docker compose run --rm dev run test` after each step.
- **Commit after each step** with message format: `Stage 2: <what>`.
- **Run everything through Docker Compose.** Never bare `pnpm` on the host.
- **Docker-in-Docker is optional.** The `docker-verify` node must degrade gracefully. Tests must pass even without Docker.
- **The LLM fallback extractor uses temperature 0.** Maximize determinism for signature extraction.
- **Provider pricing will go stale.** Use the pricing tables as starting points but add a comment noting they should be periodically updated.
