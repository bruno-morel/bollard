# Cursor Prompt: Rewrite Legacy Adversarial Tests

## Task

Rewrite all 24 legacy `*.adversarial.test.ts` files to use the current Bollard API shapes. After this task, the adversarial suite whitelist in `vitest.adversarial.config.ts` should include ALL `*.adversarial.test.ts` files, and `vitest run --config vitest.adversarial.config.ts` should pass 100%.

**This is a mechanical rewrite, NOT new test creation.** Each file already has valid test logic (fast-check property tests, edge-case assertions). The problem is that they use outdated type shapes — wrong field names, wrong constructors, missing required fields. Fix the shapes; preserve the test intent.

---

## The API Mapping (OLD -> CURRENT)

### 1. `Blueprint` (`packages/engine/src/blueprint.ts`)

**Current shape:**
```typescript
interface Blueprint {
  id: string           // REQUIRED — was missing in legacy
  name: string
  nodes: BlueprintNode[]
  maxCostUsd: number          // REQUIRED — was missing in legacy
  maxDurationMinutes: number  // REQUIRED — was missing in legacy
}
```

**Legacy had:**
```typescript
// WRONG:
{ name: "test", description: "...", nodes: [...] }

// CORRECT:
{ id: "test", name: "test", nodes: [...], maxCostUsd: 10, maxDurationMinutes: 30 }
```

- Remove `description` (does not exist)
- Add `id` (required string)
- Add `maxCostUsd` (use 10 for test defaults)
- Add `maxDurationMinutes` (use 30 for test defaults)

### 2. `BlueprintNode` (`packages/engine/src/blueprint.ts`)

**Current shape:**
```typescript
interface BlueprintNode {
  id: string
  name: string
  type: NodeType  // "deterministic" | "agentic" | "risk_gate" | "human_gate"
  execute?: (ctx: PipelineContext) => Promise<NodeResult>
  agent?: string  // string ID, NOT an object
  postconditions?: ((ctx: PipelineContext) => boolean)[]
  onFailure?: "stop" | "retry" | "skip" | "hand_to_human"
  maxRetries?: number
}
```

**Legacy had:**
```typescript
// WRONG:
{
  id: "node1", name: "Test Node", type: "agentic",
  agent: { role: "agent1", goal: "goal1", backstory: "backstory1" },
  tools: [],
  dependencies: []
}

// CORRECT:
{
  id: "node1", name: "Test Node", type: "agentic",
  agent: "test-agent"
}
```

- `agent` must be a `string`, not an object
- Remove `tools` (does not exist on node)
- Remove `dependencies` (does not exist — Bollard uses sequential ordering)
- Remove `message` (does not exist on node)

### 3. `NodeResult` (`packages/engine/src/blueprint.ts`)

**Current shape:**
```typescript
interface NodeResult {
  status: "ok" | "fail" | "block"
  data?: unknown
  cost_usd?: number    // underscore, not camelCase
  duration_ms?: number // underscore, not camelCase
  error?: NodeResultError
  probes?: ProbeDefinition[]
}
```

**Legacy had:**
```typescript
// WRONG:
{ status: "ok", output: "...", costUsd: 0.01, durationMs: 100 }

// CORRECT:
{ status: "ok", data: "...", cost_usd: 0.01, duration_ms: 100 }
```

- `output` -> `data`
- `costUsd` -> `cost_usd`
- `durationMs` -> `duration_ms`

### 4. `BollardConfig` (`packages/engine/src/context.ts`)

**Current shape:**
```typescript
interface BollardConfig {
  llm: {
    default: { provider: string; model: string }
    agents?: Record<string, { provider: string; model: string }>
  }
  agent: {
    max_cost_usd: number
    max_duration_minutes: number
  }
}
```

**Legacy had:**
```typescript
// WRONG:
{ llm: { default: { provider: "openai", model: "gpt-4" } } }

// CORRECT:
{
  llm: { default: { provider: "openai", model: "gpt-4" } },
  agent: { max_cost_usd: 10, max_duration_minutes: 30 }
}
```

- Add `agent` block (REQUIRED — `createContext` accesses `config.agent.max_cost_usd`)

### 5. `AgentDefinition` (`packages/agents/src/types.ts`)

**Current shape:**
```typescript
interface AgentDefinition {
  role: string
  systemPrompt: string
  tools: AgentTool[]
  maxTurns: number
  temperature: number
  maxTokens?: number
}
```

**Legacy had:**
```typescript
// WRONG:
{ name: "test-agent", role: "assistant", instructions: "You are a test agent", tools: [] }

// CORRECT:
{
  role: "test-agent",
  systemPrompt: "You are a test agent",
  tools: [],
  maxTurns: 10,
  temperature: 0.3
}
```

- `name` -> REMOVED. `role` IS the identifier.
- `instructions` -> `systemPrompt`
- Add `maxTurns` (REQUIRED positive integer)
- Add `temperature` (REQUIRED number)
- `tools` must be `AgentTool[]` (with `execute` method), not bare `{ name, description, inputSchema }`

### 6. `AgentContext` (`packages/agents/src/types.ts`)

**Current shape:**
```typescript
interface AgentContext {
  pipelineCtx: PipelineContext
  workDir: string
  allowedCommands?: string[]
  progress?: AgentProgressCallback
}
```

**Legacy had:**
```typescript
// WRONG:
{ messages: [], variables: new Map() }

// CORRECT (for tests, use createContext):
import { createContext } from "@bollard/engine/src/context.js"

const config: BollardConfig = {
  llm: { default: { provider: "test", model: "test" } },
  agent: { max_cost_usd: 10, max_duration_minutes: 30 }
}
const pipelineCtx = createContext("test task", "test-blueprint", config)
const ctx: AgentContext = { pipelineCtx, workDir: "/tmp/test" }
```

### 7. `AgentResult` (`packages/agents/src/types.ts`)

**Current shape:**
```typescript
interface AgentResult {
  response: string
  data?: Record<string, unknown>
  totalCostUsd: number
  totalDurationMs: number
  turns: number
  toolCalls: { tool: string; input: Record<string, unknown>; output: string }[]
}
```

**Legacy had:**
```typescript
// WRONG assertions:
expect(result).toHaveProperty("content")   // -> "response"
expect(result).toHaveProperty("usage")     // -> "totalCostUsd" / "totalDurationMs"
expect(result).toHaveProperty("messages")  // REMOVED
expect(result.messages).toBeArray()        // REMOVED

// CORRECT assertions:
expect(result).toHaveProperty("response")
expect(result).toHaveProperty("totalCostUsd")
expect(result).toHaveProperty("totalDurationMs")
expect(result).toHaveProperty("turns")
expect(result).toHaveProperty("toolCalls")
```

### 8. `LLMResponse` (`packages/llm/src/types.ts`)

**Current shape:**
```typescript
interface LLMResponse {
  content: LLMContentBlock[]
  stopReason: "end_turn" | "tool_use" | "max_tokens"
  usage: { inputTokens: number; outputTokens: number }
  costUsd: number
}
```

**Legacy had:**
```typescript
// WRONG:
{ content: [...], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }

// CORRECT:
{
  content: [{ type: "text", text: "response" }],
  stopReason: "end_turn",
  usage: { inputTokens: 10, outputTokens: 5 },
  costUsd: 0.001
}
```

- `promptTokens` -> `inputTokens`
- `completionTokens` -> `outputTokens`
- Remove `totalTokens`
- Add `stopReason` (REQUIRED)
- Add `costUsd` (REQUIRED)

### 9. `CostTracker` (`packages/engine/src/cost-tracker.ts`)

- `addCost()` -> `add()`
- `getTotalCost()` -> `total()`
- `getCostLimit()` -> `limit` (getter property)
- Constructor: `new CostTracker(maxCost: number)`

### 10. `runBlueprint` Signature

**Current:**
```typescript
function runBlueprint(
  blueprint: Blueprint,
  task: string,
  config: BollardConfig,
  agenticHandler?: AgenticHandler,
  humanGateHandler?: HumanGateHandler,
  onProgress?: ProgressCallback,
  toolchainProfile?: ToolchainProfile
): Promise<RunResult>
```

**RunResult:**
```typescript
interface RunResult {
  status: "success" | "failure" | "handed_to_human"
  runId: string
  totalCostUsd: number
  totalDurationMs: number
  nodeResults: Record<string, NodeResult>
}
```

### 11. `AgentTool` (for tests that create tools)

**Current:**
```typescript
interface AgentTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute(input: Record<string, unknown>, ctx: AgentContext): Promise<string>
}
```

Legacy tools are missing the `execute` method. If a test creates tool objects, add a mock execute:
```typescript
execute: async () => "mock result"
```

---

## Files to Rewrite (24 files)

### Priority 1: engine package (4 files)
- `packages/engine/tests/runner.adversarial.test.ts`
- `packages/engine/tests/context.adversarial.test.ts`
- `packages/engine/tests/errors.adversarial.test.ts`
- `packages/engine/tests/cost-tracker.adversarial.test.ts`

### Priority 2: agents package (11 files)
- `packages/agents/tests/executor.adversarial.test.ts`
- `packages/agents/tests/planner.adversarial.test.ts`
- `packages/agents/tests/coder.adversarial.test.ts`
- `packages/agents/tests/prompt-template.adversarial.test.ts`
- `packages/agents/tests/eval-loader.adversarial.test.ts`
- `packages/agents/tests/tools/edit-file.adversarial.test.ts` (in tools/ subdir — check if this is different from the whitelisted one at tests/ level)
- `packages/agents/tests/tools/list-dir.adversarial.test.ts`
- `packages/agents/tests/tools/read-file.adversarial.test.ts`
- `packages/agents/tests/tools/run-command.adversarial.test.ts`
- `packages/agents/tests/tools/search.adversarial.test.ts`
- `packages/agents/tests/tools/write-file.adversarial.test.ts`

### Priority 3: cli package (4 files)
- `packages/cli/tests/config.adversarial.test.ts`
- `packages/cli/tests/diff.adversarial.test.ts`
- `packages/cli/tests/human-gate.adversarial.test.ts`
- `packages/cli/tests/agent-handler.adversarial.test.ts`

### Priority 4: llm package (2 files)
- `packages/llm/tests/mock.adversarial.test.ts`
- `packages/llm/tests/providers/anthropic.adversarial.test.ts`

### Priority 5: blueprints package (1 file)
- `packages/blueprints/tests/implement-feature.adversarial.test.ts`

### Priority 6: verify package (2 files)
- `packages/verify/tests/dynamic.adversarial.test.ts`
- `packages/verify/tests/static.adversarial.test.ts`

---

## Special Cases

### Tests that test non-existent features — DELETE test cases, not files

Some runner tests test circular dependency detection and missing dependency resolution. These features don't exist in Bollard (nodes are sequential). **Delete those specific `describe` blocks** but keep the rest of the file.

### The `compactOlderTurns` tests in `executor.adversarial.test.ts`

These are already correct (they test the function directly with message arrays). The broken part is the `executeAgent` tests below them. Fix only the `executeAgent` section.

### Tool tests (`packages/agents/tests/tools/*.adversarial.test.ts`)

These test individual agent tools (`read_file`, `write_file`, `edit_file`, `list_dir`, `search`, `run_command`). Each tool's `execute` function takes `(input, ctx: AgentContext)`. The `AgentContext` must be updated to the current shape. These tests also create temp directories for testing — that pattern is correct, just fix the `AgentContext`.

### CLI tests

`config.adversarial.test.ts` — tests `resolveConfig()`. The return shape may have changed. Read `packages/cli/src/config.ts` to verify.

`agent-handler.adversarial.test.ts` — tests `createAgenticHandler()`. Read `packages/cli/src/agent-handler.ts` to verify the current signature.

---

## After Rewriting All Files

1. **Update `vitest.adversarial.config.ts`**: Replace the whitelist with `include: ["packages/*/tests/**/*.adversarial.test.ts"]` (the original glob pattern, no whitelist needed).

2. **Run verification:**
```bash
docker compose run --rm dev run typecheck
docker compose run --rm dev run lint
docker compose run --rm dev exec vitest run --config vitest.adversarial.config.ts
```

3. **Update `CLAUDE.md`**: Update the adversarial test count and note that all files are now active.

---

## Commit Guidance

Single commit: `Stage 4c: rewrite legacy adversarial tests to current API shapes`

---

## Important: Read Before Rewriting

For each file, **read the corresponding source file first** to understand the current API:

- Before fixing `runner.adversarial.test.ts`, read `packages/engine/src/runner.ts`
- Before fixing `executor.adversarial.test.ts`, read `packages/agents/src/executor.ts`
- Before fixing `config.adversarial.test.ts`, read `packages/cli/src/config.ts`
- Before fixing `agent-handler.adversarial.test.ts`, read `packages/cli/src/agent-handler.ts`
- etc.

The mapping above covers 90% of cases. For edge cases, the source file is the ground truth.
