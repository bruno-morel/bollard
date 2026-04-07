import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defaultAdversarialConfig } from "@bollard/detect/src/concerns.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { describe, expect, it } from "vitest"
import { buildContractContext } from "../src/contract-extractor.js"

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(THIS_DIR, "../../..")

const tsProfile: ToolchainProfile = {
  language: "typescript",
  packageManager: "pnpm",
  checks: {
    test: {
      label: "Vitest",
      cmd: "pnpm",
      args: ["run", "test"],
      source: "auto-detected",
    },
  },
  sourcePatterns: ["**/*.ts"],
  testPatterns: ["**/*.test.ts"],
  ignorePatterns: [],
  allowedCommands: ["pnpm"],
  adversarial: defaultAdversarialConfig({ language: "typescript" }),
}

describe("buildContractContext", () => {
  it("returns empty graph for non-TypeScript profile", async () => {
    const py: ToolchainProfile = {
      ...tsProfile,
      language: "python",
      adversarial: defaultAdversarialConfig({ language: "python" }),
    }
    const ctx = await buildContractContext([], py, REPO_ROOT)
    expect(ctx.modules).toHaveLength(0)
    expect(ctx.edges).toHaveLength(0)
  })

  it("builds a bounded workspace graph for the Bollard monorepo", async () => {
    const ctx = await buildContractContext([], tsProfile, REPO_ROOT)
    expect(ctx.modules.length).toBeGreaterThan(0)
    expect(ctx.modules.length).toBeLessThanOrEqual(50)
    expect(ctx.edges.length).toBeGreaterThan(0)
    expect(ctx.edges.length).toBeLessThanOrEqual(200)
  })

  it("narrows affectedEdges when affected files touch specific packages", async () => {
    const ctx = await buildContractContext(["packages/engine/src/errors.ts"], tsProfile, REPO_ROOT)
    expect(ctx.affectedEdges.length).toBeLessThanOrEqual(ctx.edges.length)
  })

  it("does not leak private CostTracker fields into serialized context", async () => {
    const sourcePath = "packages/engine/src/cost-tracker.ts"
    const raw = await readFile(resolve(REPO_ROOT, sourcePath), "utf-8")
    expect(raw).toContain("_total")

    const ctx = await buildContractContext([sourcePath], tsProfile, REPO_ROOT)
    const blob = JSON.stringify(ctx)
    expect(blob).not.toContain("_total")
    expect(blob).not.toContain("_limit")
  })

  it("does not leak internal implementation identifiers into serialized contract context", async () => {
    const ctx = await buildContractContext([], tsProfile, REPO_ROOT)
    const blob = JSON.stringify(ctx)
    expect(blob).not.toContain("compactOlderTurns")
    expect(blob).not.toContain("skipVerificationAfterTurn")
    expect(blob).not.toContain("processConcernBlocks")
    expect(blob).not.toContain("extractClassSignature")
  })
})
