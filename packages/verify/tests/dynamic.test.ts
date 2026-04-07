import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { createTestRunNode, runTests } from "../src/dynamic.js"

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(THIS_DIR, "../../..")

describe("createTestRunNode", () => {
  it("returns a node with correct structure", () => {
    const node = createTestRunNode("/tmp/test")
    expect(node.id).toBe("run-tests")
    expect(node.name).toBe("Run Tests")
    expect(node.type).toBe("deterministic")
    expect(typeof node.execute).toBe("function")
  })
})

describe("runTests (integration)", () => {
  it("runs a specific test file and reports structured results", async () => {
    const result = await runTests("/app", ["packages/engine/tests/errors.test.ts"])
    expect(result.passed).toBeGreaterThanOrEqual(10)
    expect(result.failed).toBe(0)
    expect(result.total).toBeGreaterThanOrEqual(10)
    expect(result.duration_ms).toBeGreaterThan(0)
    expect(result.output).toBeTruthy()
  }, 60_000)

  it("runs .bollard contract paths with vitest.contract.config.ts", async () => {
    const relDir = `.bollard/tests/_dynamic_probe_${Date.now()}`
    const absDir = join(REPO_ROOT, relDir)
    await mkdir(absDir, { recursive: true })
    const relFile = join(relDir, "probe.contract.test.ts").replace(/\\/g, "/")
    const absFile = join(absDir, "probe.contract.test.ts")
    await writeFile(
      absFile,
      `import { it, expect } from "vitest"\nit("probe", () => { expect(1).toBe(1) })\n`,
      "utf-8",
    )
    try {
      const result = await runTests(REPO_ROOT, [relFile])
      expect(result.failed).toBe(0)
      expect(result.passed).toBeGreaterThanOrEqual(1)
    } finally {
      await rm(absDir, { recursive: true, force: true })
    }
  }, 60_000)
})
