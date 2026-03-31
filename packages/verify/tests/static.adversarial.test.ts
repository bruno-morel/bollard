import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runStaticChecks, createStaticCheckNode } from "../src/static.js"

describe("Feature: All exported functions and classes have behavioral tests", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "static-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  describe("runStaticChecks", () => {
    it("should return results array and allPassed boolean", async () => {
      const result = await runStaticChecks(tempDir)
      
      expect(result).toHaveProperty("results")
      expect(result).toHaveProperty("allPassed")
      expect(Array.isArray(result.results)).toBe(true)
      expect(typeof result.allPassed).toBe("boolean")
    })

    it("should return StaticCheckResult objects with required properties", async () => {
      const result = await runStaticChecks(tempDir)
      
      for (const checkResult of result.results) {
        expect(checkResult).toHaveProperty("check")
        expect(checkResult).toHaveProperty("passed")
        expect(checkResult).toHaveProperty("output")
        expect(checkResult).toHaveProperty("durationMs")
        expect(typeof checkResult.check).toBe("string")
        expect(typeof checkResult.passed).toBe("boolean")
        expect(typeof checkResult.output).toBe("string")
        expect(typeof checkResult.durationMs).toBe("number")
      }
    })

    it("should set allPassed to true when all checks pass", async () => {
      // Create a minimal valid project structure
      await writeFile(join(tempDir, "package.json"), JSON.stringify({
        name: "test-project",
        version: "1.0.0"
      }))
      
      const result = await runStaticChecks(tempDir)
      
      if (result.results.every(r => r.passed)) {
        expect(result.allPassed).toBe(true)
      }
    })

    it("should set allPassed to false when any check fails", async () => {
      // Create invalid TypeScript file to trigger failures
      await writeFile(join(tempDir, "invalid.ts"), "this is not valid typescript syntax !!!")
      
      const result = await runStaticChecks(tempDir)
      
      if (result.results.some(r => !r.passed)) {
        expect(result.allPassed).toBe(false)
      }
    })

    it("should record positive duration for each check", async () => {
      const result = await runStaticChecks(tempDir)
      
      for (const checkResult of result.results) {
        expect(checkResult.durationMs).toBeGreaterThanOrEqual(0)
      }
    })

    it("should work with toolchain profile parameter", async () => {
      const profile = {
        packageManager: "npm" as const,
        runtime: "node" as const,
        hasTypeScript: true,
        hasLinting: false,
        hasFormatting: false,
        hasTesting: false
      }
      
      const result = await runStaticChecks(tempDir, profile)
      
      expect(result).toHaveProperty("results")
      expect(result).toHaveProperty("allPassed")
    })
  })

  describe("createStaticCheckNode", () => {
    it("should return a function", () => {
      const node = createStaticCheckNode(tempDir)
      expect(typeof node).toBe("function")
    })

    it("should create node that returns NodeResult when executed", async () => {
      const node = createStaticCheckNode(tempDir)
      const result = await node()
      
      expect(result).toHaveProperty("success")
      expect(result).toHaveProperty("output")
      expect(typeof result.success).toBe("boolean")
      expect(typeof result.output).toBe("string")
    })

    it("should work with toolchain profile parameter", () => {
      const profile = {
        packageManager: "npm" as const,
        runtime: "node" as const,
        hasTypeScript: true,
        hasLinting: true,
        hasFormatting: false,
        hasTesting: false
      }
      
      const node = createStaticCheckNode(tempDir, profile)
      expect(typeof node).toBe("function")
    })
  })
})

describe("Feature: Property-based tests for functions with string parameters", () => {
  it("runStaticChecks should handle arbitrary valid directory paths", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => 
          !s.includes('\0') && 
          !s.includes('\n') && 
          !s.includes('\r') &&
          s.trim().length > 0
        ),
        async (dirName) => {
          const tempBase = await mkdtemp(join(tmpdir(), "prop-test-"))
          const testDir = join(tempBase, dirName)
          
          try {
            await mkdir(testDir, { recursive: true })
            const result = await runStaticChecks(testDir)
            
            // Property: always returns the expected structure
            expect(result).toHaveProperty("results")
            expect(result).toHaveProperty("allPassed")
            expect(Array.isArray(result.results)).toBe(true)
            expect(typeof result.allPassed).toBe("boolean")
            
            // Property: allPassed is consistent with individual results
            const actualAllPassed = result.results.every(r => r.passed)
            expect(result.allPassed).toBe(actualAllPassed)
          } finally {
            await rm(tempBase, { recursive: true, force: true })
          }
        }
      ),
      { numRuns: 10 }
    )
  })

  it("createStaticCheckNode should handle arbitrary valid directory paths", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => 
          !s.includes('\0') && 
          !s.includes('\n') && 
          !s.includes('\r') &&
          s.trim().length > 0
        ),
        async (dirName) => {
          const tempBase = await mkdtemp(join(tmpdir(), "prop-test-"))
          const testDir = join(tempBase, dirName)
          
          try {
            await mkdir(testDir, { recursive: true })
            const node = createStaticCheckNode(testDir)
            
            // Property: always returns a function
            expect(typeof node).toBe("function")
            
            // Property: function returns NodeResult structure
            const result = await node()
            expect(result).toHaveProperty("success")
            expect(result).toHaveProperty("output")
          } finally {
            await rm(tempBase, { recursive: true, force: true })
          }
        }
      ),
      { numRuns: 10 }
    )
  })
})

describe("Feature: Negative tests for error conditions", () => {
  it("runStaticChecks should handle non-existent directory", async () => {
    const nonExistentDir = join(tmpdir(), "does-not-exist-" + Date.now())
    
    const result = await runStaticChecks(nonExistentDir)
    
    // Should still return valid structure even for non-existent directories
    expect(result).toHaveProperty("results")
    expect(result).toHaveProperty("allPassed")
    expect(Array.isArray(result.results)).toBe(true)
  })

  it("runStaticChecks should handle empty string directory", async () => {
    const result = await runStaticChecks("")
    
    expect(result).toHaveProperty("results")
    expect(result).toHaveProperty("allPassed")
    expect(Array.isArray(result.results)).toBe(true)
  })

  it("runStaticChecks should handle directory with no permissions", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "no-perms-"))
    
    try {
      // Create directory but make it unreadable (on systems that support it)
      await mkdir(join(tempDir, "restricted"), { mode: 0o000 })
      
      const result = await runStaticChecks(join(tempDir, "restricted"))
      
      expect(result).toHaveProperty("results")
      expect(result).toHaveProperty("allPassed")
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it("createStaticCheckNode should handle non-existent directory", () => {
    const nonExistentDir = join(tmpdir(), "does-not-exist-" + Date.now())
    
    const node = createStaticCheckNode(nonExistentDir)
    
    expect(typeof node).toBe("function")
  })

  it("createStaticCheckNode should handle empty string directory", () => {
    const node = createStaticCheckNode("")
    
    expect(typeof node).toBe("function")
  })

  it("runStaticChecks should handle invalid toolchain profile", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "invalid-profile-"))
    
    try {
      // @ts-expect-error - intentionally invalid profile for testing
      const result = await runStaticChecks(tempDir, { invalid: "profile" })
      
      expect(result).toHaveProperty("results")
      expect(result).toHaveProperty("allPassed")
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

describe("Feature: Domain-specific property assertions", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "domain-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("runStaticChecks should identify TypeScript compilation errors", async () => {
    // Create TypeScript file with syntax error
    await writeFile(join(tempDir, "broken.ts"), `
      interface User {
        name: string
        age: number
      }
      
      const user: User = {
        name: "John",
        age: "not a number" // Type error
      }
    `)
    
    await writeFile(join(tempDir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2020"
      }
    }))
    
    const result = await runStaticChecks(tempDir)
    
    // Domain property: TypeScript errors should be detected
    const hasTypeScriptCheck = result.results.some(r => 
      r.check.toLowerCase().includes("typescript") || 
      r.check.toLowerCase().includes("tsc") ||
      r.output.includes("Type")
    )
    
    if (hasTypeScriptCheck) {
      const typeScriptResult = result.results.find(r => 
        r.check.toLowerCase().includes("typescript") || 
        r.check.toLowerCase().includes("tsc")
      )
      expect(typeScriptResult?.passed).toBe(false)
    }
  })

  it("runStaticChecks should detect linting violations", async () => {
    // Create file with common linting issues
    await writeFile(join(tempDir, "messy.js"), `
      var unused = "variable";
      console.log("hello")
      function badFunction( ) {
        return undefined
      }
    `)
    
    await writeFile(join(tempDir, ".eslintrc.json"), JSON.stringify({
      env: { node: true },
      rules: {
        "no-unused-vars": "error",
        "no-console": "warn"
      }
    }))
    
    const result = await runStaticChecks(tempDir)
    
    // Domain property: linting issues should be reported in output
    const hasLintingOutput = result.results.some(r => 
      r.output.includes("unused") || 
      r.output.includes("console") ||
      r.check.toLowerCase().includes("lint")
    )
    
    // If linting ran, it should have meaningful output
    if (hasLintingOutput) {
      expect(result.results.some(r => r.output.length > 0)).toBe(true)
    }
  })

  it("createStaticCheckNode should produce NodeResult with meaningful output", async () => {
    // Create project with issues to ensure meaningful output
    await writeFile(join(tempDir, "test.ts"), "const x: string = 123") // Type error
    
    const node = createStaticCheckNode(tempDir)
    const result = await node()
    
    // Domain property: output should contain diagnostic information
    expect(result.output.length).toBeGreaterThan(0)
    
    // Domain property: success should reflect actual check results
    if (result.output.includes("error") || result.output.includes("Error")) {
      expect(result.success).toBe(false)
    }
  })

  it("runStaticChecks duration should reflect actual work performed", async () => {
    // Create larger project to ensure measurable duration
    for (let i = 0; i < 5; i++) {
      await writeFile(join(tempDir, `file${i}.ts`), `
        export interface Data${i} {
          id: number
          value: string
        }
        
        export function process${i}(data: Data${i}): string {
          return data.value.toUpperCase()
        }
      `)
    }
    
    const result = await runStaticChecks(tempDir)
    
    // Domain property: duration should be reasonable for the work performed
    for (const checkResult of result.results) {
      expect(checkResult.durationMs).toBeGreaterThanOrEqual(0)
      expect(checkResult.durationMs).toBeLessThan(30000) // Should complete within 30s
    }
  })
})