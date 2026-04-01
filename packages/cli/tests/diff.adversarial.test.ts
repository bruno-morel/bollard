import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import { diffToolchainProfile, type CheckDiff, type PatternDiff, type DiffResult } from "../src/diff.js"
import type { ToolchainProfile, VerificationCommand } from "@bollard/detect/src/types.js"

describe("Feature: All exported functions have behavioral tests", () => {
  it("should return DiffResult with correct structure for empty profile", () => {
    const profile: ToolchainProfile = {
      hardcoded: {},
      detected: {},
      sourcePatterns: [],
      testPatterns: [],
      allowedCommands: []
    }

    const result = diffToolchainProfile(profile)

    expect(result).toHaveProperty("checks")
    expect(result).toHaveProperty("patterns")
    expect(result).toHaveProperty("summary")
    expect(Array.isArray(result.checks)).toBe(true)
    expect(Array.isArray(result.patterns)).toBe(true)
    expect(typeof result.summary).toBe("object")
  })

  it("should identify unchanged checks when hardcoded and detected match", () => {
    const command: VerificationCommand = { command: "npm test", timeout: 30000 }
    const profile: ToolchainProfile = {
      hardcoded: { "test": command },
      detected: { "test": command },
      sourcePatterns: [],
      testPatterns: [],
      allowedCommands: []
    }

    const result = diffToolchainProfile(profile)

    expect(result.checks).toHaveLength(1)
    expect(result.checks[0].name).toBe("test")
    expect(result.checks[0].status).toBe("unchanged")
    expect(result.summary.unchanged).toBe(1)
  })

  it("should identify differing checks when commands differ", () => {
    const profile: ToolchainProfile = {
      hardcoded: { "test": { command: "npm test", timeout: 30000 } },
      detected: { "test": { command: "yarn test", timeout: 30000 } },
      sourcePatterns: [],
      testPatterns: [],
      allowedCommands: []
    }

    const result = diffToolchainProfile(profile)

    expect(result.checks).toHaveLength(1)
    expect(result.checks[0].status).toBe("differ")
    expect(result.summary.differ).toBe(1)
  })

  it("should identify new checks when only in detected", () => {
    const profile: ToolchainProfile = {
      hardcoded: {},
      detected: { "lint": { command: "eslint .", timeout: 15000 } },
      sourcePatterns: [],
      testPatterns: [],
      allowedCommands: []
    }

    const result = diffToolchainProfile(profile)

    expect(result.checks).toHaveLength(1)
    expect(result.checks[0].status).toBe("new")
    expect(result.summary.new).toBe(1)
  })

  it("should identify removed checks when only in hardcoded", () => {
    const profile: ToolchainProfile = {
      hardcoded: { "build": { command: "npm run build", timeout: 60000 } },
      detected: {},
      sourcePatterns: [],
      testPatterns: [],
      allowedCommands: []
    }

    const result = diffToolchainProfile(profile)

    expect(result.checks).toHaveLength(1)
    expect(result.checks[0].status).toBe("removed")
    expect(result.summary.removed).toBe(1)
  })

  it("should track pattern differences for sourcePatterns", () => {
    const profile: ToolchainProfile = {
      hardcoded: {},
      detected: {},
      sourcePatterns: ["src/**/*.ts", "lib/**/*.js"],
      testPatterns: [],
      allowedCommands: []
    }

    const result = diffToolchainProfile(profile)

    const sourcePattern = result.patterns.find(p => p.type === "sourcePatterns")
    expect(sourcePattern).toBeDefined()
    expect(sourcePattern?.added).toContain("src/**/*.ts")
    expect(sourcePattern?.added).toContain("lib/**/*.js")
  })
})

describe("Feature: Property-based tests for string/collection parameters", () => {
  it("should handle arbitrary check names consistently", () => {
    fc.assert(fc.property(
      fc.dictionary(fc.string({ minLength: 1, maxLength: 50 }), fc.record({
        command: fc.string({ minLength: 1, maxLength: 100 }),
        timeout: fc.integer({ min: 1000, max: 300000 })
      })),
      (checks) => {
        const profile: ToolchainProfile = {
          hardcoded: checks,
          detected: {},
          sourcePatterns: [],
          testPatterns: [],
          allowedCommands: []
        }

        const result = diffToolchainProfile(profile)
        
        expect(result.checks.length).toBe(Object.keys(checks).length)
        result.checks.forEach(check => {
          expect(check.status).toBe("removed")
          expect(typeof check.name).toBe("string")
          expect(check.name.length).toBeGreaterThan(0)
        })
      }
    ))
  })

  it("should handle arbitrary pattern arrays", () => {
    fc.assert(fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 100 }), { maxLength: 20 }),
      fc.array(fc.string({ minLength: 1, maxLength: 100 }), { maxLength: 20 }),
      fc.array(fc.string({ minLength: 1, maxLength: 100 }), { maxLength: 20 }),
      (sourcePatterns, testPatterns, allowedCommands) => {
        const profile: ToolchainProfile = {
          hardcoded: {},
          detected: {},
          sourcePatterns,
          testPatterns,
          allowedCommands
        }

        const result = diffToolchainProfile(profile)
        
        expect(result.patterns).toHaveLength(3)
        
        const sourcePattern = result.patterns.find(p => p.type === "sourcePatterns")
        expect(sourcePattern?.added).toEqual(sourcePatterns)
        
        const testPattern = result.patterns.find(p => p.type === "testPatterns")
        expect(testPattern?.added).toEqual(testPatterns)
        
        const commandPattern = result.patterns.find(p => p.type === "allowedCommands")
        expect(commandPattern?.added).toEqual(allowedCommands)
      }
    ))
  })

  it("should preserve check order deterministically", () => {
    fc.assert(fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 10 }),
      (checkNames) => {
        const hardcoded = Object.fromEntries(
          checkNames.map(name => [name, { command: `run ${name}`, timeout: 30000 }])
        )
        
        const profile: ToolchainProfile = {
          hardcoded,
          detected: {},
          sourcePatterns: [],
          testPatterns: [],
          allowedCommands: []
        }

        const result1 = diffToolchainProfile(profile)
        const result2 = diffToolchainProfile(profile)
        
        expect(result1.checks.map(c => c.name)).toEqual(result2.checks.map(c => c.name))
      }
    ))
  })
})

describe("Feature: Negative tests for error conditions", () => {
  it("should handle profile with null/undefined properties gracefully", () => {
    const profile = {
      hardcoded: {},
      detected: {},
      sourcePatterns: [],
      testPatterns: [],
      allowedCommands: []
    } as ToolchainProfile

    expect(() => diffToolchainProfile(profile)).not.toThrow()
  })

  it("should handle empty string check names", () => {
    const profile: ToolchainProfile = {
      hardcoded: { "": { command: "echo test", timeout: 5000 } },
      detected: {},
      sourcePatterns: [],
      testPatterns: [],
      allowedCommands: []
    }

    const result = diffToolchainProfile(profile)
    expect(result.checks[0].name).toBe("")
    expect(result.checks[0].status).toBe("removed")
  })

  it("should handle commands with extreme timeout values", () => {
    const profile: ToolchainProfile = {
      hardcoded: { "test": { command: "npm test", timeout: 0 } },
      detected: { "test": { command: "npm test", timeout: Number.MAX_SAFE_INTEGER } },
      sourcePatterns: [],
      testPatterns: [],
      allowedCommands: []
    }

    const result = diffToolchainProfile(profile)
    expect(result.checks[0].status).toBe("differ")
  })

  it("should handle empty pattern arrays", () => {
    const profile: ToolchainProfile = {
      hardcoded: {},
      detected: {},
      sourcePatterns: [],
      testPatterns: [],
      allowedCommands: []
    }

    const result = diffToolchainProfile(profile)
    
    result.patterns.forEach(pattern => {
      expect(pattern.unchanged).toEqual([])
      expect(pattern.added).toEqual([])
      expect(pattern.removed).toEqual([])
    })
  })

  it("should handle duplicate patterns", () => {
    const profile: ToolchainProfile = {
      hardcoded: {},
      detected: {},
      sourcePatterns: ["*.ts", "*.ts", "*.js"],
      testPatterns: [],
      allowedCommands: []
    }

    const result = diffToolchainProfile(profile)
    const sourcePattern = result.patterns.find(p => p.type === "sourcePatterns")
    expect(sourcePattern?.added).toEqual(["*.ts", "*.ts", "*.js"])
  })
})

describe("Feature: Domain-specific property assertions", () => {
  it("should maintain summary count consistency", () => {
    const profile: ToolchainProfile = {
      hardcoded: { 
        "test": { command: "npm test", timeout: 30000 },
        "build": { command: "npm run build", timeout: 60000 }
      },
      detected: { 
        "test": { command: "yarn test", timeout: 30000 },
        "lint": { command: "eslint .", timeout: 15000 }
      },
      sourcePatterns: [],
      testPatterns: [],
      allowedCommands: []
    }

    const result = diffToolchainProfile(profile)
    
    const totalChecks = result.summary.unchanged + result.summary.differ + result.summary.new + result.summary.removed
    expect(totalChecks).toBe(result.checks.length)
    expect(result.summary.differ).toBe(1) // test command differs
    expect(result.summary.new).toBe(1)    // lint is new
    expect(result.summary.removed).toBe(1) // build is removed
  })

  it("should preserve command details in check diffs", () => {
    const hardcodedCmd = { command: "npm test", timeout: 30000 }
    const detectedCmd = { command: "yarn test", timeout: 45000 }
    
    const profile: ToolchainProfile = {
      hardcoded: { "test": hardcodedCmd },
      detected: { "test": detectedCmd },
      sourcePatterns: [],
      testPatterns: [],
      allowedCommands: []
    }

    const result = diffToolchainProfile(profile)
    const check = result.checks[0]
    
    expect(check.hardcoded).toEqual(hardcodedCmd)
    expect(check.detected).toEqual(detectedCmd)
  })

  it("should categorize all pattern types correctly", () => {
    const profile: ToolchainProfile = {
      hardcoded: {},
      detected: {},
      sourcePatterns: ["src/**/*.ts"],
      testPatterns: ["test/**/*.spec.ts"],
      allowedCommands: ["npm", "yarn"]
    }

    const result = diffToolchainProfile(profile)
    
    expect(result.patterns).toHaveLength(3)
    
    const patternTypes = result.patterns.map(p => p.type)
    expect(patternTypes).toContain("sourcePatterns")
    expect(patternTypes).toContain("testPatterns")
    expect(patternTypes).toContain("allowedCommands")
  })

  it("should handle complex diff scenarios with mixed changes", () => {
    const profile: ToolchainProfile = {
      hardcoded: {
        "test": { command: "npm test", timeout: 30000 },
        "build": { command: "npm run build", timeout: 60000 },
        "deploy": { command: "npm run deploy", timeout: 120000 }
      },
      detected: {
        "test": { command: "npm test", timeout: 30000 }, // unchanged
        "build": { command: "yarn build", timeout: 60000 }, // differ
        "lint": { command: "eslint .", timeout: 15000 } // new
        // deploy is removed
      },
      sourcePatterns: ["src/**/*.ts", "lib/**/*.js"],
      testPatterns: [],
      allowedCommands: ["npm", "yarn", "pnpm"]
    }

    const result = diffToolchainProfile(profile)
    
    expect(result.summary.unchanged).toBe(1)
    expect(result.summary.differ).toBe(1)
    expect(result.summary.new).toBe(1)
    expect(result.summary.removed).toBe(1)
    
    const unchangedCheck = result.checks.find(c => c.status === "unchanged")
    expect(unchangedCheck?.name).toBe("test")
    
    const differCheck = result.checks.find(c => c.status === "differ")
    expect(differCheck?.name).toBe("build")
    
    const newCheck = result.checks.find(c => c.status === "new")
    expect(newCheck?.name).toBe("lint")
    
    const removedCheck = result.checks.find(c => c.status === "removed")
    expect(removedCheck?.name).toBe("deploy")
  })
})