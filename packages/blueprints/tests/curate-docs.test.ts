import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { flattenBlueprintNodes } from "@bollard/engine/src/blueprint.js"
import type { BollardConfig } from "@bollard/engine/src/context.js"
import { afterEach, describe, expect, it } from "vitest"
import { assessDocsDriftForWorkDir, createCurateDocsBlueprint } from "../src/curate-docs.js"

const baseConfig: BollardConfig = {
  llm: { default: { provider: "anthropic", model: "claude-sonnet-4-6" } },
  agent: { max_cost_usd: 50, max_duration_minutes: 30 },
}

const expectedNodeIds = [
  "read-ownership-manifest",
  "detect-docs-conflicts",
  "assess-docs-drift",
  "generate-docs-edits",
  "verify-docs-grounding",
  "stage-docs-changes",
  "apply-docs-trust-gate",
  "apply-docs-changes",
  "verify-post-apply",
]

describe("createCurateDocsBlueprint", () => {
  it('returns blueprint with id "curate-docs"', () => {
    const bp = createCurateDocsBlueprint("/tmp", baseConfig)
    expect(bp.id).toBe("curate-docs")
  })

  it("has exactly 9 nodes", () => {
    const bp = createCurateDocsBlueprint("/tmp", baseConfig)
    expect(flattenBlueprintNodes(bp.nodes)).toHaveLength(9)
  })

  it("node ids match spec in order", () => {
    const bp = createCurateDocsBlueprint("/tmp", baseConfig)
    const ids = flattenBlueprintNodes(bp.nodes).map((n) => n.id)
    expect(ids).toEqual(expectedNodeIds)
  })

  it("node types match spec — agentic docs-curator and always human_gate on apply", () => {
    const bp = createCurateDocsBlueprint("/tmp", baseConfig)
    const nodes = flattenBlueprintNodes(bp.nodes)
    expect(nodes[3]?.type).toBe("agentic")
    expect(nodes[3]?.agent).toBe("docs-curator")
    expect(nodes[6]?.type).toBe("human_gate")
    expect(nodes[7]?.type).toBe("deterministic")
    expect(nodes[7]?.execute).toBeDefined()
  })

  it("uses human_gate even when trust is silent", () => {
    const config: BollardConfig = {
      ...baseConfig,
      takeover: {
        docs: { enabled: true, trust: "silent" },
      },
    }
    const bp = createCurateDocsBlueprint("/tmp", config)
    const nodes = flattenBlueprintNodes(bp.nodes)
    expect(nodes[6]?.type).toBe("human_gate")
  })
})

describe("assessDocsDriftForWorkDir", () => {
  let workDir: string

  afterEach(async () => {
    if (workDir !== undefined) {
      await rm(workDir, { recursive: true, force: true })
    }
  })

  it("returns detectOnlyDrift separate from curate candidates", async () => {
    workDir = await mkdtemp(join(tmpdir(), "curate-drift-assess-"))
    await writeFile(join(workDir, "README.md"), "# README\n", "utf-8")
    await writeFile(join(workDir, "CLAUDE.md"), "# Claude\n", "utf-8")
    await mkdir(join(workDir, "spec/adr"), { recursive: true })
    await writeFile(join(workDir, "spec/ROADMAP.md"), "# Roadmap\n", "utf-8")
    await mkdir(join(workDir, "packages/engine/src"), { recursive: true })
    await writeFile(
      join(workDir, "spec/stage5d-token-economy.md"),
      "# Stage 5d\n\nSee [engine](../packages/engine/src/index.ts)\n",
      "utf-8",
    )
    await writeFile(join(workDir, "packages/engine/src/index.ts"), "export {}\n", "utf-8")

    const result = await assessDocsDriftForWorkDir(workDir)
    expect(result.editable).toContain("README.md")
    expect(result.detectOnly).toContain("spec/stage5d-token-economy.md")
    expect(result.candidates.map((c) => c.path)).not.toContain("spec/stage5d-token-economy.md")
    expect(Array.isArray(result.detectOnlyDrift)).toBe(true)
  })
})
