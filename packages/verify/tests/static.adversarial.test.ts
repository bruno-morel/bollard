import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultAdversarialConfig } from "@bollard/detect/src/concerns.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { runStaticChecks, createStaticCheckNode } from "../src/static.js"

function makeProfile(): ToolchainProfile {
  return {
    language: "typescript",
    checks: {
      typecheck: {
        label: "tsc",
        cmd: "node",
        args: ["-e", "0"],
        source: "auto-detected",
      },
    },
    sourcePatterns: ["**/*.ts"],
    testPatterns: ["**/*.test.ts"],
    ignorePatterns: [],
    allowedCommands: ["node"],
    adversarial: defaultAdversarialConfig({ language: "typescript" }),
  }
}

describe("runStaticChecks", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "static-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("returns results and allPassed", async () => {
    const result = await runStaticChecks(tempDir)
    expect(Array.isArray(result.results)).toBe(true)
    expect(typeof result.allPassed).toBe("boolean")
  })

  it("accepts ToolchainProfile", async () => {
    const result = await runStaticChecks(tempDir, makeProfile())
    expect(result.results.length).toBeGreaterThanOrEqual(1)
  })
})

describe("createStaticCheckNode", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "static-node-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("returns a blueprint-like node with execute", () => {
    const node = createStaticCheckNode(tempDir)
    expect(node.id).toBe("static-checks")
    expect(typeof node.execute).toBe("function")
  })

  it("execute returns NodeResult", async () => {
    const node = createStaticCheckNode(tempDir, makeProfile())
    const result = await node.execute()
    expect(result.status === "ok" || result.status === "fail").toBe(true)
  })
})

describe("runStaticChecks property tests", () => {
  it("durations are non-negative", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "static-prop-"))
    try {
      await writeFile(join(tempDir, "package.json"), JSON.stringify({ name: "x" }))
      const result = await runStaticChecks(tempDir)
      for (const r of result.results) {
        expect(r.durationMs).toBeGreaterThanOrEqual(0)
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it("handles arbitrary cwd strings without throwing", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 40 }), async (suffix) => {
        const d = await mkdtemp(join(tmpdir(), `st-${suffix.replace(/[^a-z0-9]/gi, "x")}-`))
        try {
          await writeFile(join(d, "package.json"), JSON.stringify({ name: "p" }))
          const result = await runStaticChecks(d)
          expect(typeof result.allPassed).toBe("boolean")
        } finally {
          await rm(d, { recursive: true, force: true })
        }
      }),
      { numRuns: 5 },
    )
  })
})
