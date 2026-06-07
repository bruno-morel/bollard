import type { BollardConfig } from "@bollard/engine/src/context.js"
import { beforeEach, describe, expect, it, vi } from "vitest"

const runEvalsMock = vi.fn().mockResolvedValue([{ ok: true }])
const resolveConfigMock = vi.fn()

vi.mock("@bollard/engine/src/eval-runner.js", () => ({
  runEvals: (...args: unknown[]) => runEvalsMock(...args),
}))

vi.mock("./config.js", () => ({
  resolveConfig: (...args: unknown[]) => resolveConfigMock(...args),
}))

import { runAllAgentScores } from "../src/eval-baseline.js"

function stage5dDefaults(): BollardConfig {
  return {
    llm: {
      default: { provider: "mock", model: "claude-sonnet-4-6" },
      agents: {
        planner: { provider: "mock", model: "claude-haiku-4-5-20251001" },
        coder: { provider: "mock", model: "claude-sonnet-4-6" },
        "boundary-tester": { provider: "mock", model: "claude-haiku-4-5-20251001" },
        "contract-tester": { provider: "mock", model: "claude-haiku-4-5-20251001" },
        "behavioral-tester": { provider: "mock", model: "claude-haiku-4-5-20251001" },
      },
    },
    agent: { max_cost_usd: 50, max_duration_minutes: 30 },
  }
}

describe("runAllAgentScores", () => {
  beforeEach(() => {
    runEvalsMock.mockClear()
    resolveConfigMock.mockResolvedValue({
      config: stage5dDefaults(),
      profile: {} as never,
      sources: {},
    })
  })

  it("resolves each agent's production model via forAgent(role)", async () => {
    const { scores, model } = await runAllAgentScores("/app", undefined, 10)

    expect(model).toBe("claude-sonnet-4-6")
    expect(scores).toHaveLength(5)

    const byAgent = new Map(scores.map((s) => [s.agent, s]))
    expect(byAgent.get("planner")?.model).toBe("claude-haiku-4-5-20251001")
    expect(byAgent.get("coder")?.model).toBe("claude-sonnet-4-6")
    expect(byAgent.get("boundary-tester")?.model).toBe("claude-haiku-4-5-20251001")
    expect(byAgent.get("contract-tester")?.model).toBe("claude-haiku-4-5-20251001")
    expect(byAgent.get("behavioral-tester")?.model).toBe("claude-haiku-4-5-20251001")
  })

  it("passes per-agent model to runEvals", async () => {
    await runAllAgentScores("/app", undefined, 10)

    const modelsUsed = runEvalsMock.mock.calls.map((call) => (call[2] as { model: string }).model)
    expect(modelsUsed).toContain("claude-haiku-4-5-20251001")
    expect(modelsUsed).toContain("claude-sonnet-4-6")
    expect(modelsUsed.filter((m) => m === "claude-sonnet-4-6")).toHaveLength(1)
    expect(modelsUsed.filter((m) => m === "claude-haiku-4-5-20251001")).toHaveLength(4)
  })

  it("forces all agents onto --model override", async () => {
    const { scores, model } = await runAllAgentScores("/app", "custom-ab-model", 10)

    expect(model).toBe("custom-ab-model")
    for (const s of scores) {
      expect(s.model).toBe("custom-ab-model")
    }
    for (const call of runEvalsMock.mock.calls) {
      expect((call[2] as { model: string }).model).toBe("custom-ab-model")
    }
  })
})
