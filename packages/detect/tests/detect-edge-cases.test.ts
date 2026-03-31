import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { detectToolchain } from "../src/detect.js"

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bollard-detect-adv-"))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("Multi-language project priority", () => {
  it("TypeScript wins when both tsconfig.json and pyproject.toml exist", async () => {
    writeFileSync(join(tmpDir, "tsconfig.json"), "{}")
    writeFileSync(join(tmpDir, "pyproject.toml"), "[project]\nname = 'dual'")
    const profile = await detectToolchain(tmpDir)
    expect(profile.language).toBe("typescript")
  })
})

describe("Missing lock files", () => {
  it("defaults to npm when tsconfig.json exists but no lock file", async () => {
    writeFileSync(join(tmpDir, "tsconfig.json"), "{}")
    const profile = await detectToolchain(tmpDir)
    expect(profile.language).toBe("typescript")
    expect(profile.packageManager).toBe("npm")
  })
})

describe("Broken pyproject.toml", () => {
  it("Python detector handles invalid TOML content without crashing", async () => {
    writeFileSync(join(tmpDir, "pyproject.toml"), "this is not valid toml {{{{ garbage ]]]]")
    const profile = await detectToolchain(tmpDir)
    expect(profile.language).toBe("python")
    expect(profile.packageManager).toBe("pip")
  })

  it("regex section detection returns false for garbled content", async () => {
    writeFileSync(
      join(tmpDir, "pyproject.toml"),
      "not valid toml at all\n[broken\nno closing bracket",
    )
    const profile = await detectToolchain(tmpDir)
    expect(profile.language).toBe("python")
    expect(profile.checks.typecheck).toBeUndefined()
    expect(profile.checks.lint).toBeUndefined()
    expect(profile.checks.test).toBeUndefined()
  })
})

describe("Path traversal in detection", () => {
  it("detectToolchain with ../.. in path still works for the resolved directory", async () => {
    const nested = join(tmpDir, "a", "b")
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(tmpDir, "tsconfig.json"), "{}")

    const traversalPath = join(nested, "../..")
    const profile = await detectToolchain(traversalPath)
    expect(profile.language).toBe("typescript")
    expect(resolve(traversalPath)).toBe(tmpDir)
  })
})

describe("Unknown language fallback", () => {
  it("returns all empty fields for unrecognized project", async () => {
    writeFileSync(join(tmpDir, "README.md"), "# hello")
    const profile = await detectToolchain(tmpDir)
    expect(profile.language).toBe("unknown")
    expect(profile.checks).toEqual({})
    expect(profile.sourcePatterns).toEqual([])
    expect(profile.testPatterns).toEqual([])
    expect(profile.ignorePatterns).toEqual([])
    expect(profile.allowedCommands).toContain("git")
    expect(profile.adversarial.mode).toBe("blackbox")
  })
})

describe("Package manager detection edge cases", () => {
  it("detects yarn when yarn.lock present", async () => {
    writeFileSync(join(tmpDir, "tsconfig.json"), "{}")
    writeFileSync(join(tmpDir, "yarn.lock"), "")
    const profile = await detectToolchain(tmpDir)
    expect(profile.packageManager).toBe("yarn")
    expect(profile.checks.typecheck?.cmd).toBe("yarn")
    expect(profile.checks.lint).toBeUndefined()
  })

  it("detects bun when bun.lockb present", async () => {
    writeFileSync(join(tmpDir, "tsconfig.json"), "{}")
    writeFileSync(join(tmpDir, "bun.lockb"), "")
    const profile = await detectToolchain(tmpDir)
    expect(profile.packageManager).toBe("bun")
    expect(profile.checks.typecheck?.cmd).toBe("bun")
  })

  it("Python defaults to pip when no lock file present", async () => {
    writeFileSync(join(tmpDir, "requirements.txt"), "flask==2.0")
    const profile = await detectToolchain(tmpDir)
    expect(profile.language).toBe("python")
    expect(profile.packageManager).toBe("pip")
  })

  it("Python detects pipenv when Pipfile.lock present", async () => {
    writeFileSync(join(tmpDir, "pyproject.toml"), "[project]\nname = 'test'")
    writeFileSync(join(tmpDir, "Pipfile.lock"), "{}")
    const profile = await detectToolchain(tmpDir)
    expect(profile.language).toBe("python")
    expect(profile.packageManager).toBe("pipenv")
  })
})
