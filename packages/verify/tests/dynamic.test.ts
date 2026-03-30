import { describe, expect, it } from "vitest"
import { createTestRunNode, runTests } from "../src/dynamic.js"

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
})
