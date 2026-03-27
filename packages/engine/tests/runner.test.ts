import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Blueprint, BlueprintNode, NodeResult } from "../src/blueprint.js"
import type { BollardConfig } from "../src/context.js"
import { BollardError } from "../src/errors.js"
import { runBlueprint } from "../src/runner.js"

const TEST_CONFIG: BollardConfig = {
  llm: { default: { provider: "mock", model: "test" } },
  agent: { max_cost_usd: 10, max_duration_minutes: 30 },
}

function makeBlueprint(nodes: BlueprintNode[], overrides?: Partial<Blueprint>): Blueprint {
  return {
    id: "test-bp",
    name: "Test Blueprint",
    nodes,
    maxCostUsd: 10,
    maxDurationMinutes: 30,
    ...overrides,
  }
}

function okNode(id: string, data?: unknown): BlueprintNode {
  return {
    id,
    name: id,
    type: "deterministic",
    execute: async () => ({ status: "ok", data: data ?? `${id}-done` }),
  }
}

function failNode(id: string, overrides?: Partial<BlueprintNode>): BlueprintNode {
  return {
    id,
    name: id,
    type: "deterministic",
    execute: async () => ({ status: "fail", error: `${id} failed` }),
    ...overrides,
  }
}

beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  vi.spyOn(process.stderr, "write").mockImplementation(() => true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("runBlueprint", () => {
  it("succeeds with two deterministic nodes", async () => {
    const bp = makeBlueprint([okNode("a"), okNode("b")])
    const result = await runBlueprint(bp, "test task", TEST_CONFIG)

    expect(result.status).toBe("success")
    expect(result.nodeResults["a"]?.status).toBe("ok")
    expect(result.nodeResults["b"]?.status).toBe("ok")
    expect(result.error).toBeUndefined()
  })

  it("executes nodes in sequential order", async () => {
    const order: string[] = []
    const bp = makeBlueprint([
      {
        id: "first",
        name: "first",
        type: "deterministic",
        execute: async () => {
          order.push("first")
          return { status: "ok" }
        },
      },
      {
        id: "second",
        name: "second",
        type: "deterministic",
        execute: async () => {
          order.push("second")
          return { status: "ok" }
        },
      },
    ])

    await runBlueprint(bp, "task", TEST_CONFIG)
    expect(order).toEqual(["first", "second"])
  })

  it("enforces time limit", async () => {
    const bp = makeBlueprint([okNode("a")], { maxDurationMinutes: 0 })
    const start = Date.now()
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(start)
      .mockReturnValue(start + 1)

    const result = await runBlueprint(bp, "task", TEST_CONFIG)

    expect(result.status).toBe("failure")
    expect(result.error?.code).toBe("TIME_LIMIT_EXCEEDED")
  })

  it("enforces cost limit", async () => {
    const config: BollardConfig = {
      ...TEST_CONFIG,
      agent: { max_cost_usd: 0.01, max_duration_minutes: 30 },
    }
    const expensiveNode: BlueprintNode = {
      id: "expensive",
      name: "expensive",
      type: "deterministic",
      execute: async () => ({ status: "ok", cost_usd: 0.05 }),
    }
    const bp = makeBlueprint([expensiveNode, okNode("after")])
    const result = await runBlueprint(bp, "task", config)

    expect(result.status).toBe("failure")
    expect(result.error?.code).toBe("COST_LIMIT_EXCEEDED")
  })

  it("retries and succeeds on second attempt", async () => {
    let calls = 0
    const flakyNode: BlueprintNode = {
      id: "flaky",
      name: "flaky",
      type: "deterministic",
      maxRetries: 1,
      execute: async () => {
        calls++
        if (calls === 1) return { status: "fail", error: "first try" }
        return { status: "ok", data: "recovered" }
      },
    }
    const bp = makeBlueprint([flakyNode])
    const result = await runBlueprint(bp, "task", TEST_CONFIG)

    expect(result.status).toBe("success")
    expect(result.nodeResults["flaky"]?.status).toBe("ok")
    expect(calls).toBe(2)
  })

  it("stops on retry exhaustion with default onFailure", async () => {
    const bp = makeBlueprint([failNode("always-fails", { maxRetries: 2 })])
    const result = await runBlueprint(bp, "task", TEST_CONFIG)

    expect(result.status).toBe("failure")
    expect(result.error?.code).toBe("NODE_EXECUTION_FAILED")
  })

  it("skips failing node when onFailure is skip", async () => {
    const bp = makeBlueprint([failNode("skip-me", { onFailure: "skip" }), okNode("after")])
    const result = await runBlueprint(bp, "task", TEST_CONFIG)

    expect(result.status).toBe("success")
    expect(result.nodeResults["skip-me"]?.status).toBe("fail")
    expect(result.nodeResults["after"]?.status).toBe("ok")
  })

  it("hands to human when onFailure is hand_to_human", async () => {
    const bp = makeBlueprint([
      failNode("needs-human", { onFailure: "hand_to_human" }),
      okNode("should-not-run"),
    ])
    const result = await runBlueprint(bp, "task", TEST_CONFIG)

    expect(result.status).toBe("handed_to_human")
    expect(result.nodeResults["needs-human"]?.status).toBe("fail")
    expect(result.nodeResults["should-not-run"]).toBeUndefined()
  })

  it("passes when postcondition returns true", async () => {
    const bp = makeBlueprint([
      {
        ...okNode("checked"),
        postconditions: [() => true],
      },
    ])
    const result = await runBlueprint(bp, "task", TEST_CONFIG)

    expect(result.status).toBe("success")
  })

  it("fails when postcondition returns false", async () => {
    const bp = makeBlueprint([
      {
        ...okNode("bad-post"),
        postconditions: [() => false],
      },
    ])
    const result = await runBlueprint(bp, "task", TEST_CONFIG)

    expect(result.status).toBe("failure")
    expect(result.error?.code).toBe("POSTCONDITION_FAILED")
  })

  it("handles agentic node with placeholder response", async () => {
    const bp = makeBlueprint([
      { id: "agent-node", name: "agent", type: "agentic" as const, agent: "default" },
    ])
    const result = await runBlueprint(bp, "task", TEST_CONFIG)

    expect(result.status).toBe("success")
    expect(result.nodeResults["agent-node"]?.status).toBe("ok")
    expect(result.nodeResults["agent-node"]?.data).toBe("agentic node placeholder")
  })

  it("returns immediate success for empty blueprint", async () => {
    const bp = makeBlueprint([])
    const result = await runBlueprint(bp, "task", TEST_CONFIG)

    expect(result.status).toBe("success")
    expect(Object.keys(result.nodeResults)).toHaveLength(0)
    expect(result.error).toBeUndefined()
  })
})
