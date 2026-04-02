```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  deriveSourcePatterns,
  deriveTestPatterns,
  deriveIgnorePatterns,
  deriveAllowedCommands,
} from "../src/derive.js"
import { detectToolchain } from "../src/detect.js"
import { detect as detectFallback, buildManualProfile } from "../src/languages/fallback.js"
import { detect as detectGo } from "../src/languages/go.js"
import { detect as detectJavascript } from "../src/languages/javascript.js"
import { detect as detectPython } from "../src/languages/python.js"
import { detect as detectRust } from "../src/languages/rust.js"
import { detect as detectTypescript } from "../src/languages/typescript.js"
import type { LanguageId, PackageManagerId, MutationToolId, ConfigSource } from "../src/types.js"

const validLanguages: LanguageId[] = [
  "typescript", "javascript", "python", "go", "rust", "java", 
  "kotlin", "ruby", "csharp", "elixir", "unknown"
]

const validPackageManagers: PackageManagerId[] = [
  "pnpm", "npm", "yarn", "bun", "poetry", "pipenv", "uv", "pip",
  "go", "cargo", "bundler", "gradle", "maven"
]

const validMutationTools: MutationToolId[] = [
  "stryker", "mutmut", "go-mutesting", "cargo-mutants", "mutant"
]

const validConfigSources: ConfigSource[] = [
  "default", "auto-detected", "env", "file", "cli"
]

describe("Feature: derive functions handle all valid language IDs", () => {
  it("should return arrays for all valid languages", () => {
    validLanguages.forEach(lang => {
      expect(Array.isArray(deriveSourcePatterns(lang))).toBe(true)
      expect(Array.isArray(deriveTestPatterns(lang))).toBe(true)
      expect(Array.isArray(deriveIgnorePatterns(lang))).toBe(true)
      expect(Array.isArray(deriveAllowedCommands(lang))).toBe(true)
    })
  })

  it("should handle unknown language gracefully", () => {
    const sourcePatterns = deriveSourcePatterns("unknown")
    const testPatterns = deriveTestPatterns("unknown")
    const ignorePatterns = deriveIgnorePatterns("unknown")
    const allowedCommands = deriveAllowedCommands("unknown")

    expect(Array.isArray(sourcePatterns)).toBe(true)
    expect(Array.isArray(testPatterns)).toBe(true)
    expect(Array.isArray(ignorePatterns)).toBe(true)
    expect(Array.isArray(allowedCommands)).toBe(true)
  })
})

describe("Feature: derive functions handle optional parameters", () => {
  it("should work with package manager parameter", () => {
    validPackageManagers.forEach(pkgMgr => {
      const commands = deriveAllowedCommands("typescript", pkgMgr)
      expect(Array.isArray(commands)).toBe(true)
    })
  })

  it("should work with tools parameter", () => {
    const tools = ["eslint", "prettier", "jest"]
    const commands = deriveAllowedCommands("typescript", "npm", tools)
    expect(Array.isArray(commands)).toBe(true)
  })

  it("should work with both optional parameters", () => {
    const commands = deriveAllowedCommands("python", "pip", ["pytest", "black"])
    expect(Array.isArray(commands)).toBe(true)
  })

  it("should work with no optional parameters", () => {
    const commands = deriveAllowedCommands("go")
    expect(Array.isArray(commands)).toBe(true)
  })
})

describe("Feature: property-based testing for derive functions", () => {
  it("should always return arrays for any valid language", () => {
    fc.assert(fc.property(
      fc.constantFrom(...validLanguages),
      (lang) => {
        const sourcePatterns = deriveSourcePatterns(lang)
        const testPatterns = deriveTestPatterns(lang)
        const ignorePatterns = deriveIgnorePatterns(lang)
        const allowedCommands = deriveAllowedCommands(lang)

        expect(Array.isArray(sourcePatterns)).toBe(true)
        expect(Array.isArray(testPatterns)).toBe(true)
        expect(Array.isArray(ignorePatterns)).toBe(true)
        expect(Array.isArray(allowedCommands)).toBe(true)
      }
    ))
  })

  it("should handle any combination of valid parameters", () => {
    fc.assert(fc.property(
      fc.constantFrom(...validLanguages),
      fc.option(fc.constantFrom(...validPackageManagers)),
      fc.option(fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 10 })),
      (lang, pkgMgr, tools) => {
        const commands = deriveAllowedCommands(lang, pkgMgr, tools)
        expect(Array.isArray(commands)).toBe(true)
      }
    ))
  })
})

describe("Feature: detectToolchain handles filesystem operations", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bollard-detect-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("should return a ToolchainProfile for empty directory", async () => {
    const profile = await detectToolchain(tempDir)
    
    expect(typeof profile).toBe("object")
    expect(profile).not.toBeNull()
    expect(validLanguages).toContain(profile.language)
    expect(Array.isArray(profile.sourcePatterns)).toBe(true)
    expect(Array.isArray(profile.testPatterns)).toBe(true)
    expect(Array.isArray(profile.ignorePatterns)).toBe(true)
    expect(Array.isArray(profile.allowedCommands)).toBe(true)
    expect(typeof profile.checks).toBe("object")
    expect(typeof profile.adversarial).toBe("object")
    expect(["blackbox", "in-language", "both"]).toContain(profile.adversarial.mode)
  })

  it("should handle non-existent directory", async () => {
    const nonExistentDir = join(tempDir, "does-not-exist")
    await expect(detectToolchain(nonExistentDir)).rejects.toThrow()
  })

  it("should handle directory with package.json", async () => {
    await writeFile(join(tempDir, "package.json"), JSON.stringify({
      name: "test-project",
      version: "1.0.0"
    }))

    const profile = await detectToolchain(tempDir)
    expect(typeof profile).toBe("object")
    expect(validLanguages).toContain(profile.language)
  })

  it("should handle directory with go.mod", async () => {
    await writeFile(join(tempDir, "go.mod"), "module test\n\ngo 1.21\n")

    const profile = await detectToolchain(tempDir)
    expect(typeof profile).toBe("object")
    expect(validLanguages).toContain(profile.language)
  })

  it("should handle directory with Cargo.toml", async () => {
    await writeFile(join(tempDir, "Cargo.toml"), "[package]\nname = \"test\"\nversion = \"0.1.0\"\n")

    const profile = await detectToolchain(tempDir)
    expect(typeof profile).toBe("object")
    expect(validLanguages).toContain(profile.language)
  })

  it("should handle directory with pyproject.toml", async () => {
    await writeFile(join(tempDir, "pyproject.toml"), "[tool.poetry]\nname = \"test\"\nversion = \"0.1.0\"\n")

    const profile = await detectToolchain(tempDir)
    expect(typeof profile).toBe("object")
    expect(validLanguages).toContain(profile.language)
  })
})

describe("Feature: language-specific detectors handle filesystem operations", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bollard-detect-lang-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("should handle Go detection in empty directory", async () => {
    const result = await detectGo(tempDir)
    expect(result === null || typeof result === "object").toBe(true)
  })

  it("should handle JavaScript detection in empty directory", async () => {
    const result = await detectJavascript(tempDir)
    expect(result === null || typeof result === "object").toBe(true)
  })

  it("should handle Python detection in empty directory", async () => {
    const result = await detectPython(tempDir)
    expect(result === null || typeof result === "object").toBe(true)
  })

  it("should handle Rust detection in empty directory", async () => {
    const result = await detectRust(tempDir)
    expect(result === null || typeof result === "object").toBe(true)
  })

  it("should handle TypeScript detection in empty directory", async () => {
    const result = await detectTypescript(tempDir)
    expect(result === null || typeof result === "object").toBe(true)
  })

  it("should handle invalid directory paths", async () => {
    const invalidPath = "/this/path/should/not/exist/anywhere"
    
    await expect(detectGo(invalidPath)).rejects.toThrow()
    await expect(detectJavascript(invalidPath)).rejects.toThrow()
    await expect(detectPython(invalidPath)).rejects.toThrow()
    await expect(detectRust(invalidPath)).rejects.toThrow()
    await expect(detectTypescript(invalidPath)).rejects.toThrow()
  })
})

describe("Feature: fallback detector handles manual profile building", () => {
  it("should return null for detect function", async () => {
    const result = await detectFallback()
    expect(result).toBeNull()
  })

  it("should build manual profile with minimal parameters", () => {
    const profile = buildManualProfile("typescript", {})
    
    expect(typeof profile).toBe("object")
    expect(profile.language).toBe("typescript")
    expect(Array.isArray(profile.sourcePatterns)).toBe(true)
    expect(Array.isArray(profile.testPatterns)).toBe(true)
    expect(Array.isArray(profile.ignorePatterns)).toBe(true)
    expect(Array.isArray(profile.allowedCommands)).toBe(true)
    expect(typeof profile.checks).toBe("object")
    expect(typeof profile.adversarial).toBe("object")
  })

  it("should build manual profile with all parameters", () => {
    const profile = buildManualProfile("python", {
      packageManager: "poetry",
      testFramework: "pytest",
      linter: "ruff",
      typeChecker: "mypy"
    })
    
    expect(typeof profile).toBe("object")
    expect(profile.language).toBe("python")
    expect(validPackageManagers).toContain(profile.packageManager!)
  })

  it("should handle all valid languages in manual profile", () => {
    validLanguages.forEach(lang => {
      const profile = buildManualProfile(lang, {})
      expect(profile.language).toBe(lang)
      expect(typeof profile).toBe("object")
    })
  })
})

describe("Feature: boundary and negative cases", () => {
  it("should handle empty strings as directory paths", async () => {
    await expect(detectToolchain("")).rejects.toThrow()
  })

  it("should handle null/undefined-like paths", async () => {
    // @ts-expect-error Testing invalid input
    await expect(detectToolchain(null)).rejects.toThrow()
    // @ts-expect-error Testing invalid input
    await expect(detectToolchain(undefined)).rejects.toThrow()
  })

  it("should handle very long directory paths", async () => {
    const longPath = "/".repeat(1000)
    await expect(detectToolchain(longPath)).rejects.toThrow()
  })

  it("should handle special characters in directory paths", async () => {
    const specialPath = "/tmp/test with spaces & symbols!@#$%"
    await expect(detectToolchain(specialPath)).rejects.toThrow()
  })

  it("should handle buildManualProfile with empty answers object", () => {
    validLanguages.forEach(lang => {
      const profile = buildManualProfile(lang, {})
      expect(typeof profile).toBe("object")
      expect(profile.language).toBe(lang)
    })
  })

  it("should validate ToolchainProfile structure", async () => {
    let tempDir: string
    try {
      tempDir = await mkdtemp(join(tmpdir(), "bollard-profile-test-"))
      const profile = await detectToolchain(tempDir)
      
      // Validate required fields
      expect(typeof profile.language).toBe("string")
      expect(validLanguages).toContain(profile.language)
      expect(Array.isArray(profile.sourcePatterns)).toBe(true)
      expect(Array.isArray(profile.testPatterns)).toBe(true)
      expect(Array.isArray(profile.ignorePatterns)).toBe(true)
      expect(Array.isArray(profile.allowedCommands)).toBe(true)
      
      // Validate checks object structure
      expect(typeof profile.checks).toBe("object")
      if (profile.checks.typecheck) {
        expect(typeof profile.checks.typecheck.label).toBe("string")
        expect(typeof profile.checks.typecheck.cmd).toBe("string")
        expect(Array.isArray(profile.checks.typecheck.args)).toBe(true)
        expect(validConfigSources).toContain(profile.checks.typecheck.source)
      }
      
      // Validate adversarial object structure
      expect(typeof profile.adversarial).toBe("object")
      expect(["blackbox", "in-language", "both"]).toContain(profile.adversarial.mode)
      if (profile.adversarial.runtimeImage) {
        expect(typeof profile.adversarial.runtimeImage).toBe("string")
      }
      if (profile.adversarial.persist !== undefined) {
        expect(typeof profile.adversarial.persist).toBe("boolean")
      }
      
      // Validate optional packageManager
      if (profile.packageManager) {
        expect(validPackageManagers).toContain(profile.packageManager)
      }
      
      // Validate optional mutation
      if (profile.mutation) {
        expect(validMutationTools).toContain(profile.mutation.tool)
        expect(typeof profile.mutation.command).toBe("string")
        expect(typeof profile.mutation.changedFilesPlaceholder).toBe("string")
      }
    } finally {
      if (tempDir!) {
        await rm(tempDir, { recursive: true, force: true })
      }
    }
  })
})
```