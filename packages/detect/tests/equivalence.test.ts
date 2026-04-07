import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { detectToolchain } from "../src/detect.js"

const WORKSPACE_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..")

const DEFAULT_ALLOWED_COMMANDS = [
  "pnpm",
  "npx",
  "node",
  "tsc",
  "biome",
  "git",
  "cat",
  "head",
  "tail",
  "wc",
  "diff",
]

describe("Behavioral equivalence: detected profile vs hardcoded defaults", () => {
  it("detects the Bollard workspace as TypeScript with pnpm", async () => {
    const profile = await detectToolchain(WORKSPACE_ROOT)
    expect(profile.language).toBe("typescript")
    expect(profile.packageManager).toBe("pnpm")
  })

  it("typecheck command matches old hardcoded pnpm run typecheck", async () => {
    const profile = await detectToolchain(WORKSPACE_ROOT)
    expect(profile.checks.typecheck).toBeDefined()
    expect(profile.checks.typecheck?.cmd).toBe("pnpm")
    expect(profile.checks.typecheck?.args).toEqual(["run", "typecheck"])
  })

  it("lint command matches old hardcoded pnpm run lint", async () => {
    const profile = await detectToolchain(WORKSPACE_ROOT)
    expect(profile.checks.lint).toBeDefined()
    expect(profile.checks.lint?.cmd).toBe("pnpm")
    expect(profile.checks.lint?.args).toEqual(["run", "lint"])
  })

  it("test command matches expected vitest invocation via pnpm", async () => {
    const profile = await detectToolchain(WORKSPACE_ROOT)
    expect(profile.checks.test).toBeDefined()
    expect(profile.checks.test?.label).toBe("Vitest")
    expect(profile.checks.test?.cmd).toBe("pnpm")
    expect(profile.checks.test?.args).toEqual(["run", "test"])
  })

  it("audit command matches old hardcoded pnpm audit --audit-level=high", async () => {
    const profile = await detectToolchain(WORKSPACE_ROOT)
    expect(profile.checks.audit).toBeDefined()
    expect(profile.checks.audit?.cmd).toBe("pnpm")
    expect(profile.checks.audit?.args).toEqual(["audit", "--audit-level=high"])
  })

  it("allowedCommands includes all original DEFAULT_ALLOWED_COMMANDS", async () => {
    const profile = await detectToolchain(WORKSPACE_ROOT)
    for (const cmd of DEFAULT_ALLOWED_COMMANDS) {
      expect(profile.allowedCommands).toContain(cmd)
    }
  })

  it("sourcePatterns includes **/*.ts and has test exclusions", async () => {
    const profile = await detectToolchain(WORKSPACE_ROOT)
    expect(profile.sourcePatterns).toContain("**/*.ts")
    expect(profile.sourcePatterns).toContain("**/*.tsx")
    expect(profile.sourcePatterns).toContain("!**/*.test.ts")
    expect(profile.sourcePatterns).toContain("!**/*.spec.ts")
  })

  it("testPatterns includes standard TS test patterns", async () => {
    const profile = await detectToolchain(WORKSPACE_ROOT)
    expect(profile.testPatterns).toContain("**/*.test.ts")
    expect(profile.testPatterns).toContain("**/*.spec.ts")
  })

  it("ignorePatterns includes node_modules and dist", async () => {
    const profile = await detectToolchain(WORKSPACE_ROOT)
    expect(profile.ignorePatterns).toContain("node_modules")
    expect(profile.ignorePatterns).toContain("dist")
  })

  it("adversarial boundary mode defaults to in-language", async () => {
    const profile = await detectToolchain(WORKSPACE_ROOT)
    expect(profile.adversarial.boundary.mode).toBe("in-language")
  })
})
