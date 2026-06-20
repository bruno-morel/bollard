import { executeAgent } from "@bollard/agents/src/executor.js"
import type { ExecutorOptions } from "@bollard/agents/src/types.js"
import { defaultAdversarialConfig } from "@bollard/detect/src/concerns.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import type { BlueprintNode } from "@bollard/engine/src/blueprint.js"
import type { BollardConfig, PipelineContext } from "@bollard/engine/src/context.js"
import { createContext } from "@bollard/engine/src/context.js"
import { CostTracker } from "@bollard/engine/src/cost-tracker.js"
import { beforeEach, describe, expect, it, vi } from "vitest"

const readFileMock = vi.hoisted(() => vi.fn().mockResolvedValue("preloaded"))

const { mockAgentResolved } = vi.hoisted(() => ({
  mockAgentResolved: {
    role: "mock",
    systemPrompt: "x",
    tools: [],
    maxTurns: 5,
    temperature: 0.3,
  },
}))

vi.mock("@bollard/agents/src/executor.js", () => ({
  executeAgent: vi.fn().mockResolvedValue({
    response: "Mock response",
    totalCostUsd: 0.01,
    totalDurationMs: 1000,
    turns: 1,
    toolCalls: [],
  }),
}))

vi.mock("@bollard/agents/src/planner.js", () => ({
  createPlannerAgent: vi.fn().mockResolvedValue(mockAgentResolved),
}))

vi.mock("@bollard/agents/src/coder.js", () => ({
  createCoderAgent: vi.fn().mockResolvedValue(mockAgentResolved),
}))

vi.mock("@bollard/agents/src/boundary-tester.js", () => ({
  createBoundaryTesterAgent: vi.fn().mockResolvedValue(mockAgentResolved),
}))

vi.mock("@bollard/agents/src/contract-tester.js", () => ({
  createContractTesterAgent: vi.fn().mockResolvedValue(mockAgentResolved),
}))

vi.mock("@bollard/agents/src/behavioral-tester.js", () => ({
  createBehavioralTesterAgent: vi.fn().mockResolvedValue(mockAgentResolved),
}))

vi.mock("@bollard/agents/src/semantic-reviewer.js", () => ({
  createSemanticReviewerAgent: vi.fn().mockResolvedValue(mockAgentResolved),
}))

vi.mock("@bollard/agents/src/test-curator.js", () => ({
  createTestCuratorAgent: vi.fn().mockResolvedValue(mockAgentResolved),
}))

vi.mock("@bollard/agents/src/docs-curator.js", () => ({
  createDocsCuratorAgent: vi.fn().mockResolvedValue(mockAgentResolved),
}))

vi.mock("@bollard/llm/src/client.js", () => ({
  LLMClient: class MockLLMClient {
    forAgent() {
      return {
        provider: {
          chat: vi.fn().mockResolvedValue({
            content: [{ type: "text" as const, text: "ok" }],
            stopReason: "end_turn" as const,
            usage: { inputTokens: 1, outputTokens: 1 },
            costUsd: 0,
          }),
        },
        model: "mock-model",
      }
    }
  },
}))

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const act = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...act,
    readFile: readFileMock,
    readdir: vi.fn().mockResolvedValue(["file1.ts"]),
  }
})

import { createAgenticHandler, preloadAffectedFiles } from "../src/agent-handler.js"

function makeCtx(plan: unknown, results: PipelineContext["results"] = {}): PipelineContext {
  const config: BollardConfig = {
    llm: { default: { provider: "mock", model: "m" } },
    agent: { max_cost_usd: 10, max_duration_minutes: 30 },
  }
  return {
    runId: "r",
    task: "t",
    blueprintId: "implement-feature",
    config,
    results,
    changedFiles: [],
    costTracker: new CostTracker(10),
    startedAt: 0,
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    upgradeRunId: vi.fn(),
    plan,
  }
}

function makeProfile(): ToolchainProfile {
  return {
    language: "typescript",
    packageManager: "pnpm",
    checks: {},
    sourcePatterns: ["**/*.ts"],
    testPatterns: ["**/*.test.ts"],
    ignorePatterns: [],
    allowedCommands: ["pnpm"],
    adversarial: defaultAdversarialConfig({ language: "typescript" }),
  }
}

function lastExecutorOptions(): ExecutorOptions | undefined {
  return vi.mocked(executeAgent).mock.calls.at(-1)?.[5]
}

describe("preloadAffectedFiles", () => {
  const workDir = "/proj"

  beforeEach(() => {
    readFileMock.mockClear()
    readFileMock.mockResolvedValue("preloaded")
  })

  it("prefers expand-affected-files expanded list over plan modify", async () => {
    const ctx = makeCtx(
      { affected_files: { modify: ["legacy.ts"] } },
      {
        "expand-affected-files": {
          status: "ok",
          data: {
            expanded: {
              files: ["a.ts", "b.ts"],
              fanInScores: {},
              source: "import-graph",
            },
          },
        },
      },
    )
    const out = await preloadAffectedFiles(ctx, workDir)
    expect(out).toContain("a.ts")
    expect(out).toContain("b.ts")
    expect(out).not.toContain("legacy.ts")
    expect(readFileMock).toHaveBeenCalled()
  })

  it("falls back to plan.affected_files.modify when expand is absent", async () => {
    const ctx = makeCtx({ affected_files: { modify: ["only.ts"] } }, {})
    const out = await preloadAffectedFiles(ctx, workDir)
    expect(out).toContain("only.ts")
  })

  it("falls back when expanded.files is empty", async () => {
    const ctx = makeCtx(
      { affected_files: { modify: ["p.ts"] } },
      {
        "expand-affected-files": {
          status: "ok",
          data: { expanded: { files: [], fanInScores: {}, source: "passthrough" } },
        },
      },
    )
    const out = await preloadAffectedFiles(ctx, workDir)
    expect(out).toContain("p.ts")
  })
})

describe("createAgenticHandler agentBudgets", () => {
  const workDir = "/tmp/w"
  const profile = makeProfile()

  const plannerNode: BlueprintNode = {
    id: "generate-plan",
    name: "Plan",
    type: "agentic",
    agent: "planner",
  }

  const coderNode: BlueprintNode = {
    id: "implement",
    name: "Implement",
    type: "agentic",
    agent: "coder",
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("coder uses agentBudgets.coder when set", async () => {
    const config: BollardConfig = {
      llm: {
        default: { provider: "mock", model: "m" },
        agentBudgets: { coder: 1.5 },
      },
      agent: { max_cost_usd: 10, max_duration_minutes: 30 },
    }
    const ctx = createContext("task", "implement-feature", config)
    ctx.plan = { summary: "x", affected_files: { modify: [] } }

    const { handler } = await createAgenticHandler(config, workDir, profile)
    await handler(coderNode, ctx)

    expect(lastExecutorOptions()?.maxCostUsd).toBe(1.5)
  })

  it("coder falls back to max_cost_usd / 2 when agentBudgets.coder is not set", async () => {
    const config: BollardConfig = {
      llm: { default: { provider: "mock", model: "m" } },
      agent: { max_cost_usd: 10, max_duration_minutes: 30 },
    }
    const ctx = createContext("task", "implement-feature", config)
    ctx.plan = { summary: "x", affected_files: { modify: [] } }

    const { handler } = await createAgenticHandler(config, workDir, profile)
    await handler(coderNode, ctx)

    expect(lastExecutorOptions()?.maxCostUsd).toBe(5)
  })

  it("planner uses agentBudgets.planner when set", async () => {
    const config: BollardConfig = {
      llm: {
        default: { provider: "mock", model: "m" },
        agentBudgets: { planner: 0.25 },
      },
      agent: { max_cost_usd: 10, max_duration_minutes: 30 },
    }
    const ctx = createContext("task", "implement-feature", config)

    const { handler } = await createAgenticHandler(config, workDir, profile)
    await handler(plannerNode, ctx)

    expect(lastExecutorOptions()?.maxCostUsd).toBe(0.25)
  })

  it("planner has no maxCostUsd when agentBudgets is not configured", async () => {
    const config: BollardConfig = {
      llm: { default: { provider: "mock", model: "m" } },
      agent: { max_cost_usd: 10, max_duration_minutes: 30 },
    }
    const ctx = createContext("task", "implement-feature", config)

    const { handler } = await createAgenticHandler(config, workDir, profile)
    await handler(plannerNode, ctx)

    expect(lastExecutorOptions()?.maxCostUsd).toBeUndefined()
  })

  it("planner has no maxCostUsd when agentBudgets omits planner role", async () => {
    const config: BollardConfig = {
      llm: {
        default: { provider: "mock", model: "m" },
        agentBudgets: { coder: 1.5 },
      },
      agent: { max_cost_usd: 10, max_duration_minutes: 30 },
    }
    const ctx = createContext("task", "implement-feature", config)

    const { handler } = await createAgenticHandler(config, workDir, profile)
    await handler(plannerNode, ctx)

    expect(lastExecutorOptions()?.maxCostUsd).toBeUndefined()
  })
})

describe("createAgenticHandler docs-curator", () => {
  const workDir = "/tmp/w"
  const profile = makeProfile()

  const docsCuratorNode: BlueprintNode = {
    id: "generate-docs-edits",
    name: "Generate Docs Edits",
    type: "agentic",
    agent: "docs-curator",
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("skips LLM when assess-docs-drift has empty candidatePaths", async () => {
    const config: BollardConfig = {
      llm: { default: { provider: "mock", model: "m" } },
      agent: { max_cost_usd: 10, max_duration_minutes: 30 },
    }
    const ctx = createContext("curate docs", "curate-docs", config)
    ctx.results = {
      "assess-docs-drift": {
        status: "ok",
        data: {
          candidatePaths: [],
          corpus: "x",
          fileContents: {},
          auditFailures: [],
        },
      },
    }

    const { handler } = await createAgenticHandler(config, workDir, profile)
    const result = await handler(docsCuratorNode, ctx)

    expect(executeAgent).not.toHaveBeenCalled()
    expect(result.status).toBe("ok")
    expect(result.data).toEqual({ skipped: true, code: "CURATION_NO_PROGRESS" })
    expect(result.cost_usd).toBe(0)
  })
})
