```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  generateVerifyCompose,
  type VerifyComposeConfig,
  type GeneratedCompose
} from "../src/compose-generator.js"
import {
  runTests,
  createTestRunNode,
  type TestRunResult
} from "../src/dynamic.js"
import {
  runStaticChecks,
  createStaticCheckNode,
  type StaticCheckResult
} from "../src/static.js"
import {
  resolveLifecycle,
  resolveTestOutputDir,
  writeTestMetadata,
  integrateWithTestRunner,
  type TestLifecycle,
  type AdversarialTestSet,
  type TestMetadata
} from "../src/test-lifecycle.js"
import {
  extractSignatures,
  extractTypeDefinitions,
  resolveReferencedTypes,
  extractSignaturesFromFiles,
  TsCompilerExtractor,
  LlmFallbackExtractor,
  getExtractor,
  extractPrivateIdentifiers,
  type ExtractedSignature,
  type ExtractedTypeDefinition,
  type ExtractionResult,
  type SignatureExtractor
} from "../src/type-extractor.js"

describe("Feature: Compose Generator API", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "verify-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("should generate compose with required fields", () => {
    const config: VerifyComposeConfig = {
      workDir: tempDir,
      profile: { language: "typescript", framework: "vitest" }
    }
    
    const result = generateVerifyCompose(config)
    
    expect(typeof result.yaml).toBe("string")
    expect(Array.isArray(result.services)).toBe(true)
    expect(result.yaml.length).toBeGreaterThan(0)
  })

  it("should handle optional bollardImageTag", () => {
    const config: VerifyComposeConfig = {
      workDir: tempDir,
      profile: { language: "python", framework: "pytest" },
      bollardImageTag: "v1.2.3"
    }
    
    const result = generateVerifyCompose(config)
    
    expect(typeof result.yaml).toBe("string")
    expect(Array.isArray(result.services)).toBe(true)
  })

  it("should handle empty workDir", () => {
    const config: VerifyComposeConfig = {
      workDir: "",
      profile: { language: "javascript", framework: "jest" }
    }
    
    const result = generateVerifyCompose(config)
    
    expect(typeof result.yaml).toBe("string")
    expect(Array.isArray(result.services)).toBe(true)
  })

  it("should handle special characters in workDir", () => {
    const config: VerifyComposeConfig = {
      workDir: "/path/with spaces/and-dashes_underscores",
      profile: { language: "go", framework: "testing" }
    }
    
    const result = generateVerifyCompose(config)
    
    expect(typeof result.yaml).toBe("string")
    expect(Array.isArray(result.services)).toBe(true)
  })
})

describe("Feature: Property-based Compose Generation", () => {
  it("should always return valid structure", () => {
    fc.assert(fc.property(
      fc.record({
        workDir: fc.string(),
        profile: fc.record({
          language: fc.constantFrom("typescript", "javascript", "python", "go", "rust"),
          framework: fc.string()
        }),
        bollardImageTag: fc.option(fc.string())
      }),
      (config) => {
        const result = generateVerifyCompose(config)
        expect(typeof result.yaml).toBe("string")
        expect(Array.isArray(result.services)).toBe(true)
        expect(result.services.every(s => typeof s === "string")).toBe(true)
      }
    ))
  })
})

describe("Feature: Dynamic Test Execution API", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "verify-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("should run tests with minimal parameters", async () => {
    const result = await runTests(tempDir)
    
    expect(typeof result.passed).toBe("number")
    expect(typeof result.failed).toBe("number")
    expect(typeof result.total).toBe("number")
    expect(typeof result.duration_ms).toBe("number")
    expect(typeof result.output).toBe("string")
    expect(Array.isArray(result.failedTests)).toBe(true)
    expect(result.failedTests.every(t => typeof t === "string")).toBe(true)
    expect(result.total).toBe(result.passed + result.failed)
  })

  it("should run tests with specific test files", async () => {
    const testFiles = ["test1.spec.js", "test2.spec.js"]
    const result = await runTests(tempDir, testFiles)
    
    expect(typeof result.passed).toBe("number")
    expect(typeof result.failed).toBe("number")
    expect(typeof result.total).toBe("number")
    expect(typeof result.duration_ms).toBe("number")
    expect(typeof result.output).toBe("string")
    expect(Array.isArray(result.failedTests)).toBe(true)
  })

  it("should run tests with profile", async () => {
    const profile = { language: "typescript" as const, framework: "vitest" }
    const result = await runTests(tempDir, undefined, profile)
    
    expect(typeof result.passed).toBe("number")
    expect(typeof result.failed).toBe("number")
    expect(typeof result.total).toBe("number")
    expect(typeof result.duration_ms).toBe("number")
    expect(typeof result.output).toBe("string")
    expect(Array.isArray(result.failedTests)).toBe(true)
  })

  it("should handle empty test files array", async () => {
    const result = await runTests(tempDir, [])
    
    expect(typeof result.passed).toBe("number")
    expect(typeof result.failed).toBe("number")
    expect(typeof result.total).toBe("number")
    expect(typeof result.duration_ms).toBe("number")
    expect(typeof result.output).toBe("string")
    expect(Array.isArray(result.failedTests)).toBe(true)
  })

  it("should create test run node", () => {
    const node = createTestRunNode(tempDir)
    expect(node).toBeDefined()
  })

  it("should create test run node with parameters", () => {
    const testFiles = ["test.spec.js"]
    const profile = { language: "javascript" as const, framework: "jest" }
    const node = createTestRunNode(tempDir, testFiles, profile)
    expect(node).toBeDefined()
  })
})

describe("Feature: Static Check Execution API", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "verify-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("should run static checks with minimal parameters", async () => {
    const result = await runStaticChecks(tempDir)
    
    expect(Array.isArray(result.results)).toBe(true)
    expect(typeof result.allPassed).toBe("boolean")
    
    result.results.forEach(check => {
      expect(typeof check.check).toBe("string")
      expect(typeof check.passed).toBe("boolean")
      expect(typeof check.output).toBe("string")
      expect(typeof check.durationMs).toBe("number")
      expect(check.durationMs).toBeGreaterThanOrEqual(0)
    })
  })

  it("should run static checks with profile", async () => {
    const profile = { language: "typescript" as const, framework: "vitest" }
    const result = await runStaticChecks(tempDir, profile)
    
    expect(Array.isArray(result.results)).toBe(true)
    expect(typeof result.allPassed).toBe("boolean")
  })

  it("should create static check node", () => {
    const node = createStaticCheckNode(tempDir)
    expect(node).toBeDefined()
  })

  it("should create static check node with profile", () => {
    const profile = { language: "python" as const, framework: "pytest" }
    const node = createStaticCheckNode(tempDir, profile)
    expect(node).toBeDefined()
  })
})

describe("Feature: Test Lifecycle Management", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "verify-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("should resolve lifecycle without profile", () => {
    const lifecycle = resolveLifecycle()
    expect(["ephemeral", "persistent-native", "persistent-isolated"]).toContain(lifecycle)
  })

  it("should resolve lifecycle with profile", () => {
    const profile = { language: "typescript" as const, framework: "vitest" }
    const lifecycle = resolveLifecycle(profile)
    expect(["ephemeral", "persistent-native", "persistent-isolated"]).toContain(lifecycle)
  })

  it("should resolve test output directory", () => {
    const outputDir = resolveTestOutputDir(
      tempDir,
      "run-123",
      "feature-abc",
      "ephemeral",
      "blackbox"
    )
    expect(typeof outputDir).toBe("string")
    expect(outputDir.length).toBeGreaterThan(0)
  })

  it("should resolve test output directory for native mode", () => {
    const outputDir = resolveTestOutputDir(
      tempDir,
      "run-456",
      "feature-def",
      "persistent-native",
      "native"
    )
    expect(typeof outputDir).toBe("string")
    expect(outputDir.length).toBeGreaterThan(0)
  })

  it("should write test metadata", async () => {
    const outputDir = join(tempDir, "output")
    await mkdir(outputDir, { recursive: true })
    
    const metadata: TestMetadata = {
      blueprintId: "bp-123",
      runId: "run-456",
      task: "test task",
      featureSlug: "feature-abc",
      generatedAt: "2024-01-01T00:00:00Z",
      agentModel: "gpt-4",
      testFramework: "vitest",
      testCount: 5,
      replaces: null
    }
    
    await writeTestMetadata(outputDir, metadata)
    // No assertion on file content since we can't read implementation
  })

  it("should write test metadata with replaces", async () => {
    const outputDir = join(tempDir, "output")
    await mkdir(outputDir, { recursive: true })
    
    const metadata: TestMetadata = {
      blueprintId: "bp-789",
      runId: "run-012",
      task: "another task",
      featureSlug: "feature-xyz",
      generatedAt: "2024-01-02T00:00:00Z",
      agentModel: "claude-3",
      testFramework: "jest",
      testCount: 10,
      replaces: "old-run-345"
    }
    
    await writeTestMetadata(outputDir, metadata)
  })

  it("should integrate with test runner", async () => {
    const profile = { language: "typescript" as const, framework: "vitest" }
    const result = await integrateWithTestRunner(tempDir, profile)
    
    expect(typeof result.integrated).toBe("boolean")
    expect(typeof result.method).toBe("string")
  })
})

describe("Feature: Property-based Test Lifecycle", () => {
  it("should handle arbitrary lifecycle values", () => {
    fc.assert(fc.property(
      fc.constantFrom("ephemeral", "persistent-native", "persistent-isolated"),
      fc.string(),
      fc.string(),
      fc.string(),
      fc.constantFrom("blackbox", "native"),
      (lifecycle, workDir, runId, featureSlug, mode) => {
        const outputDir = resolveTestOutputDir(workDir, runId, featureSlug, lifecycle, mode)
        expect(typeof outputDir).toBe("string")
      }
    ))
  })
})

describe("Feature: Type Extraction API", () => {
  it("should extract signatures from file path and source", () => {
    const filePath = "/path/to/file.ts"
    const sourceText = "export function test() {}"
    
    const result = extractSignatures(filePath, sourceText)
    
    expect(typeof result.filePath).toBe("string")
    expect(typeof result.signatures).toBe("string")
    expect(typeof result.types).toBe("string")
    expect(typeof result.imports).toBe("string")
    expect(result.filePath).toBe(filePath)
  })

  it("should extract type definitions", () => {
    const filePath = "/path/to/types.ts"
    const sourceText = "export interface Test { name: string }"
    
    const result = extractTypeDefinitions(filePath, sourceText)
    
    expect(Array.isArray(result)).toBe(true)
    result.forEach(def => {
      expect(typeof def.name).toBe("string")
      expect(["interface", "type", "enum", "const"]).toContain(def.kind)
      expect(typeof def.definition).toBe("string")
      expect(typeof def.filePath).toBe("string")
    })
  })

  it("should resolve referenced types", () => {
    const signatures: ExtractedSignature[] = [{
      filePath: "/test.ts",
      signatures: "function test(): TestType",
      types: "",
      imports: ""
    }]
    
    const allTypes: ExtractedTypeDefinition[] = [{
      name: "TestType",
      kind: "interface",
      definition: "interface TestType { value: string }",
      filePath: "/types.ts"
    }]
    
    const result = resolveReferencedTypes(signatures, allTypes)
    
    expect(Array.isArray(result)).toBe(true)
    result.forEach(def => {
      expect(typeof def.name).toBe("string")
      expect(["interface", "type", "enum", "const"]).toContain(def.kind)
      expect(typeof def.definition).toBe("string")
      expect(typeof def.filePath).toBe("string")
    })
  })

  it("should extract signatures from files", async () => {
    const filePaths = ["/path/to/file1.ts", "/path/to/file2.ts"]
    
    const result = await extractSignaturesFromFiles(filePaths)
    
    expect(Array.isArray(result.signatures)).toBe(true)
    expect(Array.isArray(result.types)).toBe(true)
    
    result.signatures.forEach(sig => {
      expect(typeof sig.filePath).toBe("string")
      expect(typeof sig.signatures).toBe("string")
      expect(typeof sig.types).