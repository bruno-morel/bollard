import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { createTestRunNode, parseSummary, runTests } from "../src/dynamic.js"

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

describe("parseSummary — polyglot", () => {
  describe("vitest", () => {
    it("parses pass + fail output", () => {
      const output = "Tests  2 failed | 8 passed (10)"
      const result = parseSummary(output)
      expect(result).toEqual({ passed: 8, failed: 2, total: 10, failedTests: [] })
    })

    it("parses pass-only output", () => {
      const output = "Tests  10 passed (10)"
      const result = parseSummary(output)
      expect(result).toEqual({ passed: 10, failed: 0, total: 10, failedTests: [] })
    })
  })

  describe("pytest", () => {
    it("parses pass + fail output", () => {
      const output = [
        "FAILED tests/test_foo.py::test_bar - AssertionError",
        "FAILED tests/test_foo.py::test_baz - ValueError",
        "===== 5 passed, 2 failed in 0.42s =====",
      ].join("\n")
      const result = parseSummary(output)
      expect(result.passed).toBe(5)
      expect(result.failed).toBe(2)
      expect(result.total).toBe(7)
      expect(result.failedTests).toEqual([
        "tests/test_foo.py::test_bar",
        "tests/test_foo.py::test_baz",
      ])
    })

    it("parses pass-only output", () => {
      const output = "===== 12 passed in 1.03s ====="
      const result = parseSummary(output)
      expect(result).toEqual({ passed: 12, failed: 0, total: 12, failedTests: [] })
    })
  })

  describe("go test", () => {
    it("parses all-pass multi-package output", () => {
      const output = [
        "--- PASS: TestA (0.00s)",
        "--- PASS: TestB (0.00s)",
        "ok  \tgithub.com/user/proj/pkg1\t0.1s",
        "ok  \tgithub.com/user/proj/pkg2\t0.2s",
      ].join("\n")
      const result = parseSummary(output)
      expect(result.passed).toBeGreaterThanOrEqual(2)
      expect(result.failed).toBe(0)
      expect(result.failedTests).toEqual([])
    })

    it("parses mixed pass/fail output with individual test names", () => {
      const output = [
        "--- PASS: TestGood (0.00s)",
        "--- FAIL: TestBroken (0.00s)",
        "FAIL\tgithub.com/user/proj/pkg1\t0.1s",
        "ok  \tgithub.com/user/proj/pkg2\t0.2s",
      ].join("\n")
      const result = parseSummary(output)
      expect(result.failed).toBeGreaterThanOrEqual(1)
      expect(result.failedTests).toContain("TestBroken")
    })
  })

  describe("cargo test", () => {
    it("parses all-pass output", () => {
      const output =
        "test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.42s"
      const result = parseSummary(output)
      expect(result).toEqual({ passed: 5, failed: 0, total: 5, failedTests: [] })
    })

    it("parses fail output with named failures", () => {
      const output = [
        "test my_mod::test_thing ... FAILED",
        "test my_mod::test_other ... FAILED",
        "test result: FAILED. 3 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out",
      ].join("\n")
      const result = parseSummary(output)
      expect(result.passed).toBe(3)
      expect(result.failed).toBe(2)
      expect(result.total).toBe(5)
      expect(result.failedTests).toEqual(["my_mod::test_thing", "my_mod::test_other"])
    })
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
