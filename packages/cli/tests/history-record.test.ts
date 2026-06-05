import type { Blueprint } from "@bollard/engine/src/blueprint.js"
import { describe, expect, it } from "vitest"
import { extractNodeSummaries } from "../src/history-record.js"

const minimalBlueprint: Blueprint = {
  id: "implement-feature",
  name: "Implement Feature",
  nodes: [
    {
      id: "implement",
      name: "Implement Code",
      type: "agentic",
      agent: "coder",
    },
  ],
  maxCostUsd: 15,
  maxDurationMinutes: 30,
}

describe("extractNodeSummaries", () => {
  it("wires model into NodeSummary when present on NodeResult", () => {
    const nodes = extractNodeSummaries(minimalBlueprint, {
      implement: {
        status: "ok",
        cost_usd: 1.02,
        duration_ms: 115_000,
        turns: 16,
        model: "claude-sonnet-4-6",
      },
    })
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.model).toBe("claude-sonnet-4-6")
    expect(nodes[0]?.turns).toBe(16)
  })

  it("omits model from NodeSummary when absent on NodeResult", () => {
    const nodes = extractNodeSummaries(minimalBlueprint, {
      implement: {
        status: "ok",
        cost_usd: 1.02,
        duration_ms: 115_000,
        turns: 16,
      },
    })
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.turns).toBe(16)
    expect(nodes[0]?.model).toBeUndefined()
  })
})
