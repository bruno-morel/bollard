import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultAdversarialConfig } from "@bollard/detect/src/concerns.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { runTests, createTestRunNode } from "../src/dynamic.js"

function makeProfile(overrides: Partial<ToolchainProfile> = {}): ToolchainProfile {
  return {
    language: "typescript",
    checks: {
      test: {
        label: "echo",
        cmd: "echo",
        args: ["vitest", "ok"],
        source: "auto-detected",
      },
    },
    sourcePatterns: ["**/*.ts"],
    testPatterns: ["**/*.test.ts"],
    ignorePatterns: [],
    allowedCommands: ["echo"],
    adversarial: defaultAdversarialConfig({ language: "typescript" }),
    ...overrides,
  }
}

describe("runTests", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bollard-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("returns TestRunResult shape", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({ name: "test-project", scripts: { test: "echo ok" } }),
    )
    const result = await runTests(tempDir)
    expect(result).toMatchObject({
      passed: expect.any(Number),
      failed: expect.any(Number),
      total: expect.any(Number),
      duration_ms: expect.any(Number),
      output: expect.any(String),
      failedTests: expect.any(Array),
    })
    expect(result.total).toBe(result.passed + result.failed)
  })

  it("uses profile.checks.test when provided", async () => {
    const result = await runTests(tempDir, undefined, makeProfile())
    expect(typeof result.output).toBe("string")
  })
})

describe("createTestRunNode", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bollard-node-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("returns NodeResult from execute", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({ name: "p", scripts: { test: "echo run" } }),
    )
    const node = createTestRunNode(tempDir)
    const result = await node.execute()
    expect(result.status === "ok" || result.status === "fail").toBe(true)
    expect(result).toHaveProperty("data")
  })
})

describe("runTests property tests", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bollard-prop-test-"))
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({ name: "prop-test-project", scripts: { test: "echo 'property test'" } }),
    )
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("maintains numeric invariants", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 3 }), async (files) => {
        const result = await runTests(tempDir, files)
        expect(result.total).toBe(result.passed + result.failed)
        expect(result.passed).toBeGreaterThanOrEqual(0)
        expect(result.failed).toBeGreaterThanOrEqual(0)
      }),
      { numRuns: 8 },
    )
  })
})

describe("runTests error paths", () => {
  it("returns failed run for missing cwd", async () => {
    const result = await runTests("/nonexistent/path/that/should/not/exist")
    expect(result.failed).toBeGreaterThan(0)
  })
})
