import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import { buildProjectTree, createAgenticHandler } from "../src/agent-handler.js"
import { createContext } from "@bollard/engine/src/context.js"
import type { BollardConfig } from "@bollard/engine/src/context.js"
import type { BlueprintNode } from "@bollard/engine/src/blueprint.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { defaultAdversarialConfig } from "@bollard/detect/src/concerns.js"
import { executeAgent } from "@bollard/agents/src/executor.js"

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

vi.mock("@bollard/llm/src/client.js", () => ({
  LLMClient: vi.fn().mockImplementation(() => ({
    forAgent: vi.fn().mockReturnValue({
      provider: {
        chat: vi.fn().mockResolvedValue({
          content: [{ type: "text" as const, text: "ok" }],
          stopReason: "end_turn" as const,
          usage: { inputTokens: 1, outputTokens: 1 },
          costUsd: 0,
        }),
      },
      model: "mock-model",
    }),
  })),
}))

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue("mock file content"),
  readdir: vi.fn().mockResolvedValue(["file1.js", "file2.ts"]),
}))

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}))

const baseConfig: BollardConfig = {
  llm: { default: { provider: "mock", model: "m" } },
  agent: { max_cost_usd: 10, max_duration_minutes: 30 },
}

function makeProfile(overrides?: Partial<ToolchainProfile>): ToolchainProfile {
  return {
    language: "typescript",
    packageManager: "pnpm",
    checks: {},
    sourcePatterns: ["**/*.ts"],
    testPatterns: ["**/*.test.ts"],
    ignorePatterns: [],
    allowedCommands: ["pnpm"],
    adversarial: defaultAdversarialConfig({ language: "typescript" }),
    ...overrides,
  }
}

describe("buildProjectTree", () => {
  it("returns a string tree", async () => {
    const result = await buildProjectTree("/test/dir")
    expect(typeof result).toBe("string")
  })

  it("accepts optional toolchain profile", async () => {
    const result = await buildProjectTree("/test/dir", makeProfile())
    expect(typeof result).toBe("string")
  })

  it("does not throw on paths with null bytes (returns empty on failure)", async () => {
    const result = await buildProjectTree("/test\0/dir")
    expect(typeof result).toBe("string")
  })

  it("property: paths yield strings", () => {
    return fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 80 }).filter((s) => !s.includes("\0")),
        async (workDir) => {
          const result = await buildProjectTree(workDir)
          expect(typeof result).toBe("string")
        },
      ),
    )
  })
})

describe("createAgenticHandler", () => {
  let ctx: ReturnType<typeof createContext>

  beforeEach(() => {
    vi.clearAllMocks()
    ctx = createContext("task", "implement-feature", baseConfig)
    ctx.toolchainProfile = makeProfile()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("returns handler function and llm config", async () => {
    const { handler, llmConfig } = await createAgenticHandler(baseConfig, "/tmp/w", makeProfile())
    expect(typeof handler).toBe("function")
    expect(llmConfig).toHaveProperty("provider")
    expect(llmConfig).toHaveProperty("model")
  })

  it("runs planner node with agent string", async () => {
    const { handler } = await createAgenticHandler(baseConfig, "/tmp/w", makeProfile())
    const node: BlueprintNode = {
      id: "generate-plan",
      name: "Plan",
      type: "agentic",
      agent: "planner",
    }
    const r = await handler(node, ctx)
    expect(r.status).toBe("ok")
    expect(executeAgent).toHaveBeenCalled()
  })

  it("contract-tester skips when risk gate requests skip", async () => {
    const profile = makeProfile()
    const { handler } = await createAgenticHandler(baseConfig, "/tmp/w", profile)
    ctx.results = {
      "assess-contract-risk": {
        status: "ok",
        data: { skipContract: true },
      },
    }
    const node: BlueprintNode = {
      id: "generate-contract-tests",
      name: "Contract tests",
      type: "agentic",
      agent: "contract-tester",
    }
    const r = await handler(node, ctx)
    expect(r).toEqual({ status: "ok", data: "", cost_usd: 0, duration_ms: 0 })
    expect(executeAgent).not.toHaveBeenCalled()
  })
})
