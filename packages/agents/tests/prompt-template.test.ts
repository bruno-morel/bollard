import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { describe, expect, it } from "vitest"
import { fillPromptTemplate } from "../src/prompt-template.js"

const TS_PROFILE: ToolchainProfile = {
  language: "typescript",
  packageManager: "pnpm",
  checks: {
    typecheck: { label: "tsc", cmd: "pnpm", args: ["run", "typecheck"], source: "auto-detected" },
    lint: { label: "Biome", cmd: "pnpm", args: ["run", "lint"], source: "auto-detected" },
    test: { label: "Vitest", cmd: "pnpm", args: ["run", "test"], source: "auto-detected" },
    audit: {
      label: "pnpm audit",
      cmd: "pnpm",
      args: ["audit", "--audit-level=high"],
      source: "auto-detected",
    },
  },
  sourcePatterns: ["**/*.ts", "**/*.tsx"],
  testPatterns: ["**/*.test.ts", "**/*.spec.ts"],
  ignorePatterns: ["node_modules", "dist"],
  allowedCommands: ["pnpm", "npx", "node", "tsc", "biome", "git"],
  adversarial: { mode: "blackbox" },
}

const PY_PROFILE: ToolchainProfile = {
  language: "python",
  packageManager: "poetry",
  checks: {
    typecheck: { label: "mypy", cmd: "mypy", args: ["."], source: "auto-detected" },
    lint: { label: "Ruff", cmd: "ruff", args: ["check", "."], source: "auto-detected" },
    test: {
      label: "pytest",
      cmd: "poetry",
      args: ["run", "pytest", "-v"],
      source: "auto-detected",
    },
  },
  sourcePatterns: ["**/*.py"],
  testPatterns: ["**/test_*.py"],
  ignorePatterns: ["__pycache__", ".venv"],
  allowedCommands: ["python", "poetry", "pytest", "mypy", "ruff", "git"],
  adversarial: { mode: "blackbox" },
}

describe("fillPromptTemplate", () => {
  it("replaces all placeholders with TypeScript profile values", () => {
    const template =
      "Language: {{language}}, PM: {{packageManager}}, TC: {{typecheck}}, Lint: {{linter}}, Test: {{testFramework}}, Audit: {{auditTool}}"
    const result = fillPromptTemplate(template, TS_PROFILE)
    expect(result).toBe(
      "Language: Typescript, PM: pnpm, TC: tsc, Lint: Biome, Test: Vitest, Audit: pnpm audit",
    )
  })

  it("replaces array placeholders", () => {
    const template =
      "Commands: {{allowedCommands}}\nSrc: {{sourcePatterns}}\nTests: {{testPatterns}}"
    const result = fillPromptTemplate(template, TS_PROFILE)
    expect(result).toContain("pnpm, npx, node, tsc, biome, git")
    expect(result).toContain("**/*.ts, **/*.tsx")
    expect(result).toContain("**/*.test.ts, **/*.spec.ts")
  })

  it("produces Python-specific output for Python profile", () => {
    const template =
      "{{language}} with {{packageManager}}: {{typecheck}}, {{linter}}, {{testFramework}}"
    const result = fillPromptTemplate(template, PY_PROFILE)
    expect(result).toBe("Python with poetry: mypy, Ruff, pytest")
  })

  it("replaces missing checks with 'none'", () => {
    const profile: ToolchainProfile = {
      language: "unknown",
      checks: {},
      sourcePatterns: [],
      testPatterns: [],
      ignorePatterns: [],
      allowedCommands: ["git"],
      adversarial: { mode: "blackbox" },
    }
    const template = "{{typecheck}}, {{linter}}, {{testFramework}}, {{auditTool}}"
    const result = fillPromptTemplate(template, profile)
    expect(result).toBe("none, none, none, none")
  })

  it("leaves non-placeholder text unchanged", () => {
    const template = "# Rules\n1. Follow patterns\n2. Use {{testFramework}}"
    const result = fillPromptTemplate(template, TS_PROFILE)
    expect(result).toBe("# Rules\n1. Follow patterns\n2. Use Vitest")
  })

  it("returns input unchanged when template has no placeholders", () => {
    const template = "This is a plain template with no variables."
    const result = fillPromptTemplate(template, TS_PROFILE)
    expect(result).toBe(template)
  })

  it("leaves unknown placeholders as-is", () => {
    const template = "Known: {{language}}, Unknown: {{unknownVar}}"
    const result = fillPromptTemplate(template, TS_PROFILE)
    expect(result).toContain("Known: Typescript")
    expect(result).toContain("Unknown: {{unknownVar}}")
  })

  it("handles template with only unknown placeholders", () => {
    const template = "{{foo}} and {{bar}} and {{baz}}"
    const result = fillPromptTemplate(template, TS_PROFILE)
    expect(result).toBe("{{foo}} and {{bar}} and {{baz}}")
  })

  it("replaces multiple occurrences of the same placeholder", () => {
    const template = "First: {{language}}, again: {{language}}"
    const result = fillPromptTemplate(template, TS_PROFILE)
    expect(result).toBe("First: Typescript, again: Typescript")
  })
})
