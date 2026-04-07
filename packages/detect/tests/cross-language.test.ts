import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { detectToolchain } from "../src/detect.js"

const FIXTURES = resolve(fileURLToPath(import.meta.url), "../fixtures")
const TS_PROJECT = resolve(FIXTURES, "ts-project")
const PY_PROJECT = resolve(FIXTURES, "py-project")
const GO_PROJECT = resolve(FIXTURES, "go-project")
const RUST_PROJECT = resolve(FIXTURES, "rust-project")
const EMPTY_PROJECT = resolve(FIXTURES, "empty-project")

describe("Cross-language profile completeness", () => {
  it("TypeScript profile has all required checks and patterns", async () => {
    const p = await detectToolchain(TS_PROJECT)
    expect(p.language).toBe("typescript")
    expect(p.packageManager).toBe("pnpm")
    expect(p.checks.typecheck).toBeDefined()
    expect(p.checks.typecheck?.label).toBe("tsc")
    expect(p.checks.lint).toBeDefined()
    expect(p.checks.lint?.label).toBe("Biome")
    expect(p.checks.test).toBeDefined()
    expect(p.checks.test?.label).toBe("Vitest")
    expect(p.checks.audit).toBeDefined()
    expect(p.sourcePatterns.length).toBeGreaterThan(0)
    expect(p.testPatterns.length).toBeGreaterThan(0)
    expect(p.ignorePatterns.length).toBeGreaterThan(0)
    expect(p.allowedCommands.length).toBeGreaterThan(0)
    expect(p.adversarial.boundary.mode).toBe("in-language")
  })

  it("Python profile has typecheck + lint + test", async () => {
    const p = await detectToolchain(PY_PROJECT)
    expect(p.language).toBe("python")
    expect(p.packageManager).toBe("poetry")
    expect(p.checks.typecheck).toBeDefined()
    expect(p.checks.typecheck?.label).toBe("mypy")
    expect(p.checks.lint).toBeDefined()
    expect(p.checks.lint?.label).toBe("Ruff")
    expect(p.checks.test).toBeDefined()
    expect(p.checks.test?.label).toBe("pytest")
    expect(p.checks.audit).toBeDefined()
    expect(p.checks.audit?.label).toBe("pip-audit")
    expect(p.sourcePatterns).toContain("**/*.py")
    expect(p.testPatterns).toContain("**/test_*.py")
  })

  it("Go profile has typecheck + lint + test + audit", async () => {
    const p = await detectToolchain(GO_PROJECT)
    expect(p.language).toBe("go")
    expect(p.packageManager).toBe("go")
    expect(p.checks.typecheck).toBeDefined()
    expect(p.checks.typecheck?.label).toBe("go vet")
    expect(p.checks.lint).toBeDefined()
    expect(p.checks.lint?.label).toBe("golangci-lint")
    expect(p.checks.test).toBeDefined()
    expect(p.checks.test?.label).toBe("go test")
    expect(p.checks.audit).toBeDefined()
    expect(p.checks.audit?.label).toBe("govulncheck")
    expect(p.sourcePatterns).toContain("**/*.go")
    expect(p.testPatterns).toContain("**/*_test.go")
  })

  it("Rust profile has typecheck + lint + test + audit", async () => {
    const p = await detectToolchain(RUST_PROJECT)
    expect(p.language).toBe("rust")
    expect(p.packageManager).toBe("cargo")
    expect(p.checks.typecheck?.label).toBe("cargo check")
    expect(p.checks.lint?.label).toBe("cargo clippy")
    expect(p.checks.test?.label).toBe("cargo test")
    expect(p.checks.audit?.label).toBe("cargo audit")
    expect(p.sourcePatterns).toContain("**/*.rs")
  })

  it("empty project returns unknown with empty checks", async () => {
    const p = await detectToolchain(EMPTY_PROJECT)
    expect(p.language).toBe("unknown")
    expect(p.checks.typecheck).toBeUndefined()
    expect(p.checks.lint).toBeUndefined()
    expect(p.checks.test).toBeUndefined()
    expect(p.checks.audit).toBeUndefined()
    expect(p.allowedCommands).toContain("git")
  })
})

describe("Cross-language contamination checks", () => {
  it("Python profile does not include TypeScript-specific commands", async () => {
    const p = await detectToolchain(PY_PROJECT)
    expect(p.allowedCommands).not.toContain("tsc")
    expect(p.allowedCommands).not.toContain("biome")
    expect(p.allowedCommands).not.toContain("pnpm")
    expect(p.allowedCommands).not.toContain("npx")
    expect(p.allowedCommands).not.toContain("node")
  })

  it("Go profile does not include TypeScript-specific commands", async () => {
    const p = await detectToolchain(GO_PROJECT)
    expect(p.allowedCommands).not.toContain("tsc")
    expect(p.allowedCommands).not.toContain("biome")
    expect(p.allowedCommands).not.toContain("pnpm")
    expect(p.allowedCommands).not.toContain("node")
  })

  it("Rust profile does not include TypeScript-specific commands", async () => {
    const p = await detectToolchain(RUST_PROJECT)
    expect(p.allowedCommands).not.toContain("tsc")
    expect(p.allowedCommands).not.toContain("pnpm")
    expect(p.allowedCommands).not.toContain("node")
  })

  it("Python profile includes Python-specific commands", async () => {
    const p = await detectToolchain(PY_PROJECT)
    expect(p.allowedCommands).toContain("python")
    expect(p.allowedCommands).toContain("poetry")
    expect(p.allowedCommands).toContain("pytest")
    expect(p.allowedCommands).toContain("git")
  })

  it("Go profile includes go and git", async () => {
    const p = await detectToolchain(GO_PROJECT)
    expect(p.allowedCommands).toContain("go")
    expect(p.allowedCommands).toContain("git")
  })

  it("Rust profile includes cargo and git", async () => {
    const p = await detectToolchain(RUST_PROJECT)
    expect(p.allowedCommands).toContain("cargo")
    expect(p.allowedCommands).toContain("git")
  })

  it("all profiles have verification command source as auto-detected", async () => {
    for (const fixture of [TS_PROJECT, PY_PROJECT, GO_PROJECT, RUST_PROJECT]) {
      const p = await detectToolchain(fixture)
      for (const [, cmd] of Object.entries(p.checks)) {
        if (cmd) {
          expect(cmd.source).toBe("auto-detected")
        }
      }
    }
  })
})
