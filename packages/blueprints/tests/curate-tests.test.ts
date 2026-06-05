import { flattenBlueprintNodes } from "@bollard/engine/src/blueprint.js"
import type { BollardConfig } from "@bollard/engine/src/context.js"
import { describe, expect, it } from "vitest"
import { createCurateTestsBlueprint } from "../src/curate-tests.js"

const baseConfig: BollardConfig = {
  llm: { default: { provider: "anthropic", model: "claude-sonnet-4-6" } },
  agent: { max_cost_usd: 50, max_duration_minutes: 30 },
}

const expectedNodeIds = [
  "read-ownership-manifest",
  "detect-test-conflicts",
  "assess-test-quality",
  "generate-curation-candidates",
  "verify-curation-grounding",
  "stage-curation-changes",
  "run-staged-tests",
  "apply-curation-trust-gate",
  "update-ownership-manifest",
]

describe("createCurateTestsBlueprint", () => {
  it('returns blueprint with id "curate-tests"', () => {
    const bp = createCurateTestsBlueprint("/tmp", baseConfig)
    expect(bp.id).toBe("curate-tests")
  })

  it("has exactly 9 nodes", () => {
    const bp = createCurateTestsBlueprint("/tmp", baseConfig)
    expect(flattenBlueprintNodes(bp.nodes)).toHaveLength(9)
  })

  it("node ids match spec in order", () => {
    const bp = createCurateTestsBlueprint("/tmp", baseConfig)
    const ids = flattenBlueprintNodes(bp.nodes).map((n) => n.id)
    expect(ids).toEqual(expectedNodeIds)
  })

  it("node types match spec for review trust (human_gate on apply)", () => {
    const bp = createCurateTestsBlueprint("/tmp", baseConfig)
    const nodes = flattenBlueprintNodes(bp.nodes)
    expect(nodes[0]?.type).toBe("deterministic")
    expect(nodes[3]?.type).toBe("agentic")
    expect(nodes[3]?.agent).toBe("test-curator")
    expect(nodes[7]?.type).toBe("human_gate")
    expect(nodes[8]?.type).toBe("deterministic")
  })

  it("node types match spec for silent trust (deterministic apply)", () => {
    const config: BollardConfig = {
      ...baseConfig,
      takeover: {
        tests: { enabled: true, trust: "silent" },
      },
    }
    const bp = createCurateTestsBlueprint("/tmp", config)
    const nodes = flattenBlueprintNodes(bp.nodes)
    expect(nodes[7]?.type).toBe("deterministic")
    expect(nodes[7]?.execute).toBeDefined()
  })
})
