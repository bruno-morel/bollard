import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runTests, createTestRunNode, type TestRunResult } from "../src/dynamic.js"

describe("Feature: runTests executes test files and returns structured results", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bollard-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("should return TestRunResult with correct structure for valid test directory", async () => {
    await writeFile(join(tempDir, "package.json"), JSON.stringify({
      name: "test-project",
      scripts: { test: "echo 'test output'" }
    }))

    const result = await runTests(tempDir)

    expect(result).toMatchObject({
      passed: expect.any(Number),
      failed: expect.any(Number),
      total: expect.any(Number),
      duration_ms: expect.any(Number),
      output: expect.any(String),
      failedTests: expect.any(Array)
    })
    expect(result.total).toBe(result.passed + result.failed)
    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it("should handle specific test files when provided", async () => {
    await writeFile(join(tempDir, "package.json"), JSON.stringify({
      name: "test-project",
      scripts: { test: "echo 'specific test'" }
    }))
    await writeFile(join(tempDir, "test1.js"), "// test file")
    await writeFile(join(tempDir, "test2.js"), "// another test file")

    const result = await runTests(tempDir, ["test1.js", "test2.js"])

    expect(typeof result.output).toBe("string")
    expect(Array.isArray(result.failedTests)).toBe(true)
  })

  it("should handle toolchain profile configuration", async () => {
    await writeFile(join(tempDir, "package.json"), JSON.stringify({
      name: "test-project"
    }))

    const profile = {
      packageManager: "npm" as const,
      testRunner: "jest" as const,
      buildTool: "webpack" as const
    }

    const result = await runTests(tempDir, undefined, profile)

    expect(result).toMatchObject({
      passed: expect.any(Number),
      failed: expect.any(Number),
      total: expect.any(Number),
      duration_ms: expect.any(Number),
      output: expect.any(String),
      failedTests: expect.any(Array)
    })
  })

  it("should track failed tests in failedTests array", async () => {
    await writeFile(join(tempDir, "package.json"), JSON.stringify({
      name: "test-project",
      scripts: { test: "exit 1" }
    }))

    const result = await runTests(tempDir)

    if (result.failed > 0) {
      expect(result.failedTests.length).toBeGreaterThan(0)
      expect(result.failedTests.every(test => typeof test === "string")).toBe(true)
    }
  })
})

describe("Feature: createTestRunNode creates executable blueprint node", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bollard-node-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("should return node with execute function", () => {
    const node = createTestRunNode(tempDir)

    expect(node).toHaveProperty("execute")
    expect(typeof node.execute).toBe("function")
  })

  it("should create node that executes and returns NodeResult", async () => {
    await writeFile(join(tempDir, "package.json"), JSON.stringify({
      name: "test-project",
      scripts: { test: "echo 'node test'" }
    }))

    const node = createTestRunNode(tempDir)
    const result = await node.execute()

    expect(result).toMatchObject({
      success: expect.any(Boolean),
      output: expect.any(String)
    })
  })

  it("should create node with test files configuration", async () => {
    await writeFile(join(tempDir, "package.json"), JSON.stringify({
      name: "test-project"
    }))
    await writeFile(join(tempDir, "spec.js"), "// spec file")

    const node = createTestRunNode(tempDir, ["spec.js"])
    const result = await node.execute()

    expect(result).toHaveProperty("success")
    expect(result).toHaveProperty("output")
  })

  it("should create node with profile configuration", () => {
    const profile = {
      packageManager: "yarn" as const,
      testRunner: "vitest" as const,
      buildTool: "vite" as const
    }

    const node = createTestRunNode(tempDir, undefined, profile)

    expect(node).toHaveProperty("execute")
    expect(typeof node.execute).toBe("function")
  })
})

describe("Property-based tests", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bollard-prop-test-"))
    await writeFile(join(tempDir, "package.json"), JSON.stringify({
      name: "prop-test-project",
      scripts: { test: "echo 'property test'" }
    }))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("should handle arbitrary test file arrays", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes('\0'))),
      async (testFiles) => {
        const result = await runTests(tempDir, testFiles)
        
        expect(result.passed).toBeGreaterThanOrEqual(0)
        expect(result.failed).toBeGreaterThanOrEqual(0)
        expect(result.total).toBe(result.passed + result.failed)
        expect(result.duration_ms).toBeGreaterThanOrEqual(0)
        expect(typeof result.output).toBe("string")
        expect(Array.isArray(result.failedTests)).toBe(true)
      }
    ), { numRuns: 10 })
  })

  it("should maintain result structure invariants", async () => {
    await fc.assert(fc.asyncProperty(
      fc.record({
        packageManager: fc.constantFrom("npm", "yarn", "pnpm"),
        testRunner: fc.constantFrom("jest", "vitest", "mocha"),
        buildTool: fc.constantFrom("webpack", "vite", "rollup")
      }),
      async (profile) => {
        const result = await runTests(tempDir, undefined, profile)
        
        // Invariant: total equals sum of passed and failed
        expect(result.total).toBe(result.passed + result.failed)
        
        // Invariant: counts are non-negative
        expect(result.passed).toBeGreaterThanOrEqual(0)
        expect(result.failed).toBeGreaterThanOrEqual(0)
        expect(result.duration_ms).toBeGreaterThanOrEqual(0)
        
        // Invariant: failed tests array length matches failed count
        if (result.failed === 0) {
          expect(result.failedTests).toHaveLength(0)
        }
      }
    ), { numRuns: 5 })
  })
})

describe("Negative tests: error conditions", () => {
  it("should handle non-existent work directory", async () => {
    const nonExistentDir = "/path/that/does/not/exist/anywhere"
    
    const result = await runTests(nonExistentDir)
    
    expect(result.failed).toBeGreaterThan(0)
    expect(result.output).toContain("error")
  })

  it("should handle directory without package.json", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bollard-no-pkg-"))
    
    try {
      const result = await runTests(tempDir)
      
      expect(result.failed).toBeGreaterThan(0)
      expect(result.total).toBeGreaterThan(0)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it("should handle empty test files array", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bollard-empty-"))
    await writeFile(join(tempDir, "package.json"), JSON.stringify({
      name: "empty-test"
    }))
    
    try {
      const result = await runTests(tempDir, [])
      
      expect(result).toMatchObject({
        passed: expect.any(Number),
        failed: expect.any(Number),
        total: expect.any(Number),
        duration_ms: expect.any(Number),
        output: expect.any(String),
        failedTests: expect.any(Array)
      })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it("should handle malformed package.json", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bollard-malformed-"))
    await writeFile(join(tempDir, "package.json"), "{ invalid json")
    
    try {
      const result = await runTests(tempDir)
      
      expect(result.failed).toBeGreaterThan(0)
      expect(result.output).toBeTruthy()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it("should handle test files with special characters", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bollard-special-"))
    await writeFile(join(tempDir, "package.json"), JSON.stringify({
      name: "special-test"
    }))
    
    try {
      const specialFiles = ["test with spaces.js", "test-with-unicode-🚀.js", "test.with.dots.js"]
      const result = await runTests(tempDir, specialFiles)
      
      expect(result).toMatchObject({
        passed: expect.any(Number),
        failed: expect.any(Number),
        total: expect.any(Number),
        duration_ms: expect.any(Number),
        output: expect.any(String),
        failedTests: expect.any(Array)
      })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it("should create node that handles execution errors gracefully", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bollard-error-node-"))
    await writeFile(join(tempDir, "package.json"), JSON.stringify({
      name: "error-test",
      scripts: { test: "exit 42" }
    }))
    
    try {
      const node = createTestRunNode(tempDir)
      const result = await node.execute()
      
      expect(result).toHaveProperty("success")
      expect(result).toHaveProperty("output")
      expect(typeof result.success).toBe("boolean")
      expect(typeof result.output).toBe("string")
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})