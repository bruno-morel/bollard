import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { deriveSourcePatterns } from "../src/derive.js"
import { detectToolchain } from "../src/detect.js"
import { detect as detectFallback } from "../src/languages/fallback.js"
import { buildManualProfile } from "../src/languages/fallback.js"
import { detect as detectGo, parseGoWorkUses } from "../src/languages/go.js"
import { detect as detectJavascript } from "../src/languages/javascript.js"
import { detect as detectPython } from "../src/languages/python.js"
import { detect as detectRust } from "../src/languages/rust.js"
import { detect as detectTypescript } from "../src/languages/typescript.js"

const FIXTURES = resolve(fileURLToPath(import.meta.url), "../fixtures")
const TS_PROJECT = resolve(FIXTURES, "ts-project")
const JS_PROJECT = resolve(FIXTURES, "js-project")
const PY_PROJECT = resolve(FIXTURES, "py-project")
const GO_PROJECT = resolve(FIXTURES, "go-project")
const GO_WORKSPACE = resolve(FIXTURES, "go-workspace")
const RUST_PROJECT = resolve(FIXTURES, "rust-project")
const EMPTY_PROJECT = resolve(FIXTURES, "empty-project")

describe("TypeScript detector", () => {
  it("detects a TypeScript project with pnpm, biome, vitest", async () => {
    const result = await detectTypescript(TS_PROJECT)
    expect(result).not.toBeNull()
    expect(result?.language).toBe("typescript")
    expect(result?.packageManager).toBe("pnpm")
    expect(result?.checks.typecheck?.label).toBe("tsc")
    expect(result?.checks.lint?.label).toBe("Biome")
    expect(result?.checks.test?.label).toBe("Vitest")
    expect(result?.checks.audit).toBeDefined()
    expect(result?.sourcePatterns).toContain("**/*.ts")
    expect(result?.allowedCommands).toContain("pnpm")
    expect(result?.allowedCommands).toContain("biome")
  })

  it("detects Stryker from devDependencies in package.json", async () => {
    const result = await detectTypescript(TS_PROJECT)
    expect(result).not.toBeNull()
    expect(result?.mutation).toBeDefined()
    expect(result?.mutation?.enabled).toBe(true)
    expect(result?.mutation?.tool).toBe("stryker")
    expect(result?.mutation?.threshold).toBe(80)
  })

  it("returns null for non-TypeScript projects", async () => {
    expect(await detectTypescript(JS_PROJECT)).toBeNull()
    expect(await detectTypescript(PY_PROJECT)).toBeNull()
    expect(await detectTypescript(GO_PROJECT)).toBeNull()
    expect(await detectTypescript(RUST_PROJECT)).toBeNull()
    expect(await detectTypescript(EMPTY_PROJECT)).toBeNull()
  })
})

describe("JavaScript detector", () => {
  it("detects a JavaScript project with npm, eslint, jest", async () => {
    const result = await detectJavascript(JS_PROJECT)
    expect(result).not.toBeNull()
    expect(result?.language).toBe("javascript")
    expect(result?.packageManager).toBe("npm")
    expect(result?.checks.lint?.label).toBe("ESLint")
    expect(result?.checks.test?.label).toBe("Jest")
    expect(result?.checks.audit).toBeDefined()
    expect(result?.sourcePatterns).toContain("**/*.js")
    expect(result?.sourcePatterns).toContain("**/*.mjs")
    expect(result?.sourcePatterns).toContain("**/*.cjs")
    expect(result?.testPatterns).toContain("**/*.test.js")
    expect(result?.testPatterns).toContain("**/*.spec.js")
    expect(result?.testPatterns).toContain("**/*.test.mjs")
    expect(result?.testPatterns).toContain("**/*.spec.mjs")
    expect(result?.allowedCommands).toContain("npm")
    expect(result?.allowedCommands).toContain("eslint")
  })

  it("returns null for TypeScript projects (TS takes priority)", async () => {
    expect(await detectJavascript(TS_PROJECT)).toBeNull()
  })

  it("returns null for non-JavaScript projects", async () => {
    expect(await detectJavascript(PY_PROJECT)).toBeNull()
    expect(await detectJavascript(GO_PROJECT)).toBeNull()
    expect(await detectJavascript(RUST_PROJECT)).toBeNull()
    expect(await detectJavascript(EMPTY_PROJECT)).toBeNull()
  })

  it("detects correct package manager from lock files", async () => {
    // Test with npm (our fixture uses package-lock.json)
    const result = await detectJavascript(JS_PROJECT)
    expect(result?.packageManager).toBe("npm")
  })

  it("detects correct linter from config files", async () => {
    // Test with ESLint (our fixture uses .eslintrc.json)
    const result = await detectJavascript(JS_PROJECT)
    expect(result?.checks.lint?.label).toBe("ESLint")
  })

  it("detects correct test framework from config files", async () => {
    // Test with Jest (our fixture uses jest.config.js)
    const result = await detectJavascript(JS_PROJECT)
    expect(result?.checks.test?.label).toBe("Jest")
  })

  it("has correct source and test patterns", async () => {
    const result = await detectJavascript(JS_PROJECT)
    expect(result?.sourcePatterns).toContain("**/*.js")
    expect(result?.sourcePatterns).toContain("**/*.mjs")
    expect(result?.sourcePatterns).toContain("**/*.cjs")
    expect(result?.sourcePatterns).toContain("!**/node_modules/**")
    expect(result?.testPatterns).toContain("**/*.test.js")
    expect(result?.testPatterns).toContain("**/*.spec.js")
    expect(result?.testPatterns).toContain("**/*.test.mjs")
    expect(result?.testPatterns).toContain("**/*.spec.mjs")
    expect(result?.ignorePatterns).toContain("node_modules")
    expect(result?.ignorePatterns).toContain("dist")
    expect(result?.ignorePatterns).toContain("coverage")
    expect(result?.ignorePatterns).toContain(".cache")
  })
})

describe("Python detector", () => {
  it("detects a Python project with poetry, ruff, mypy, pytest", async () => {
    const result = await detectPython(PY_PROJECT)
    expect(result).not.toBeNull()
    expect(result?.language).toBe("python")
    expect(result?.packageManager).toBe("poetry")
    expect(result?.checks.typecheck?.label).toBe("mypy")
    expect(result?.checks.lint?.label).toBe("Ruff")
    expect(result?.checks.test?.label).toBe("pytest")
    expect(result?.sourcePatterns).toContain("**/*.py")
  })

  it("all check commands appear in allowedCommands", async () => {
    const result = await detectPython(PY_PROJECT)
    expect(result).not.toBeNull()
    const checks = result?.checks ?? {}
    const allowed = result?.allowedCommands ?? []
    for (const check of Object.values(checks)) {
      expect(allowed).toContain(check.cmd)
    }
  })

  it("returns null for non-Python projects", async () => {
    expect(await detectPython(TS_PROJECT)).toBeNull()
    expect(await detectPython(JS_PROJECT)).toBeNull()
    expect(await detectPython(GO_PROJECT)).toBeNull()
    expect(await detectPython(RUST_PROJECT)).toBeNull()
    expect(await detectPython(EMPTY_PROJECT)).toBeNull()
  })
})

describe("Go detector", () => {
  it("detects a Go project with golangci-lint", async () => {
    const result = await detectGo(GO_PROJECT)
    expect(result).not.toBeNull()
    expect(result?.language).toBe("go")
    expect(result?.packageManager).toBe("go")
    expect(result?.checks.typecheck?.label).toBe("go vet")
    expect(result?.checks.lint?.label).toBe("golangci-lint")
    expect(result?.checks.test?.label).toBe("go test")
    expect(result?.checks.audit?.label).toBe("govulncheck")
  })

  it("returns null for non-Go projects", async () => {
    expect(await detectGo(TS_PROJECT)).toBeNull()
    expect(await detectGo(JS_PROJECT)).toBeNull()
    expect(await detectGo(PY_PROJECT)).toBeNull()
    expect(await detectGo(RUST_PROJECT)).toBeNull()
    expect(await detectGo(EMPTY_PROJECT)).toBeNull()
  })

  it("detects Go from go.work without root go.mod", async () => {
    const result = await detectGo(GO_WORKSPACE)
    expect(result).not.toBeNull()
    expect(result?.language).toBe("go")
    expect(result?.sourcePatterns).toContain("cmd/**/*.go")
    expect(result?.sourcePatterns).toContain("pkg/**/*.go")
  })

  it("uses standard go source patterns when root go.mod exists even if go.work is present", async () => {
    const result = await detectGo(GO_PROJECT)
    expect(result).not.toBeNull()
    expect(result?.sourcePatterns).toEqual(deriveSourcePatterns("go"))
  })

  it("parseGoWorkUses reads block and single-line use directives", () => {
    expect(
      parseGoWorkUses(`go 1.22

use (
	./cmd
	./pkg
)
`),
    ).toEqual(["cmd", "pkg"])
    expect(parseGoWorkUses("go 1.22\nuse ./solo\n")).toEqual(["solo"])
  })
})

describe("Rust detector", () => {
  it("detects a Rust project", async () => {
    const result = await detectRust(RUST_PROJECT)
    expect(result).not.toBeNull()
    expect(result?.language).toBe("rust")
    expect(result?.packageManager).toBe("cargo")
    expect(result?.checks.typecheck?.label).toBe("cargo check")
    expect(result?.checks.lint?.label).toBe("cargo clippy")
    expect(result?.checks.test?.label).toBe("cargo test")
    expect(result?.checks.audit?.label).toBe("cargo audit")
  })

  it("returns null for non-Rust projects", async () => {
    expect(await detectRust(TS_PROJECT)).toBeNull()
    expect(await detectRust(JS_PROJECT)).toBeNull()
    expect(await detectRust(PY_PROJECT)).toBeNull()
    expect(await detectRust(GO_PROJECT)).toBeNull()
    expect(await detectRust(EMPTY_PROJECT)).toBeNull()
  })
})

describe("fallback detector", () => {
  it("returns null for all fixtures", async () => {
    expect(await detectFallback()).toBeNull()
  })
})

describe("buildManualProfile", () => {
  it("builds a profile from manual answers", () => {
    const profile = buildManualProfile("python", {
      packageManager: "poetry",
      testFramework: "pytest",
      linter: "ruff",
      typeChecker: "mypy",
    })
    expect(profile.language).toBe("python")
    expect(profile.checks.typecheck?.label).toBe("mypy")
    expect(profile.checks.lint?.label).toBe("ruff")
    expect(profile.checks.test?.label).toBe("pytest")
    expect(profile.sourcePatterns).toContain("**/*.py")
  })
})

describe("detectToolchain orchestrator", () => {
  it("detects TypeScript project", async () => {
    const profile = await detectToolchain(TS_PROJECT)
    expect(profile.language).toBe("typescript")
    expect(profile.packageManager).toBe("pnpm")
    expect(profile.checks.typecheck?.label).toBe("tsc")
    expect(profile.checks.lint?.label).toBe("Biome")
    expect(profile.checks.test?.label).toBe("Vitest")
    expect(profile.checks.audit).toBeDefined()
  })

  it("detects JavaScript project", async () => {
    const profile = await detectToolchain(JS_PROJECT)
    expect(profile.language).toBe("javascript")
    expect(profile.packageManager).toBe("npm")
    expect(profile.checks.lint?.label).toBe("ESLint")
    expect(profile.checks.test?.label).toBe("Jest")
    expect(profile.checks.audit).toBeDefined()
  })

  it("TypeScript takes priority over JavaScript when both markers exist", async () => {
    // TS_PROJECT has both package.json and tsconfig.json
    const profile = await detectToolchain(TS_PROJECT)
    expect(profile.language).toBe("typescript")
  })

  it("detects Python project", async () => {
    const profile = await detectToolchain(PY_PROJECT)
    expect(profile.language).toBe("python")
    expect(profile.packageManager).toBe("poetry")
    expect(profile.checks.typecheck?.label).toBe("mypy")
  })

  it("detects Go project", async () => {
    const profile = await detectToolchain(GO_PROJECT)
    expect(profile.language).toBe("go")
    expect(profile.checks.lint?.label).toBe("golangci-lint")
  })

  it("detects Rust project", async () => {
    const profile = await detectToolchain(RUST_PROJECT)
    expect(profile.language).toBe("rust")
    expect(profile.checks.typecheck?.label).toBe("cargo check")
  })

  it("returns unknown for empty project", async () => {
    const profile = await detectToolchain(EMPTY_PROJECT)
    expect(profile.language).toBe("unknown")
    expect(profile.allowedCommands).toContain("git")
  })

  it("TypeScript profile produces commands matching current hardcoded behavior", async () => {
    const profile = await detectToolchain(TS_PROJECT)
    expect(profile.checks.typecheck?.cmd).toBe("pnpm")
    expect(profile.checks.typecheck?.args).toEqual(["run", "typecheck"])
    expect(profile.checks.lint?.cmd).toBe("pnpm")
    expect(profile.checks.lint?.args).toEqual(["run", "lint"])
    expect(profile.checks.audit?.cmd).toBe("pnpm")
    expect(profile.checks.audit?.args).toEqual(["audit", "--audit-level=high"])
  })

  it("JavaScript profile produces correct commands", async () => {
    const profile = await detectToolchain(JS_PROJECT)
    expect(profile.checks.lint?.cmd).toBe("npm")
    expect(profile.checks.lint?.args).toEqual(["run", "lint"])
    expect(profile.checks.test?.cmd).toBe("npm")
    expect(profile.checks.test?.args).toEqual(["run", "test"])
    expect(profile.checks.audit?.cmd).toBe("npm")
    expect(profile.checks.audit?.args).toEqual(["audit", "--audit-level=high"])
  })
})
