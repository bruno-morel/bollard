import { defaultAdversarialConfig } from "@bollard/detect/src/concerns.js"
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
  adversarial: defaultAdversarialConfig({ language: "typescript" }),
}

const JAVA_PROFILE: ToolchainProfile = {
  language: "java",
  packageManager: "maven",
  checks: {
    typecheck: { label: "mvn compile", cmd: "mvn", args: ["compile"], source: "auto-detected" },
    lint: { label: "checkstyle", cmd: "mvn", args: ["checkstyle:check"], source: "auto-detected" },
    test: { label: "mvn test", cmd: "mvn", args: ["test"], source: "auto-detected" },
    audit: { label: "owasp", cmd: "mvn", args: ["verify"], source: "auto-detected" },
  },
  sourcePatterns: ["**/*.java"],
  testPatterns: ["**/test/**/*.java"],
  ignorePatterns: ["target"],
  allowedCommands: ["mvn", "java", "javac", "git"],
  adversarial: defaultAdversarialConfig({ language: "java" }),
}

const KOTLIN_PROFILE: ToolchainProfile = {
  language: "kotlin",
  packageManager: "gradle",
  checks: {
    typecheck: {
      label: "compile",
      cmd: "./gradlew",
      args: ["compileKotlin"],
      source: "auto-detected",
    },
    lint: { label: "detekt", cmd: "./gradlew", args: ["detekt"], source: "auto-detected" },
    test: { label: "test", cmd: "./gradlew", args: ["test"], source: "auto-detected" },
    audit: {
      label: "audit",
      cmd: "./gradlew",
      args: ["dependencyCheckAnalyze"],
      source: "auto-detected",
    },
  },
  sourcePatterns: ["**/*.kt"],
  testPatterns: ["**/test/**/*.kt"],
  ignorePatterns: ["build"],
  allowedCommands: ["./gradlew", "gradle", "java", "git"],
  adversarial: defaultAdversarialConfig({ language: "kotlin" }),
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
  adversarial: defaultAdversarialConfig({ language: "python" }),
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
      adversarial: defaultAdversarialConfig({ language: "unknown" }),
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

  it("handles {{#if isTypeScript}}...{{/if}} blocks", () => {
    const template = "Before {{#if isTypeScript}}TS content{{/if}} after"
    const result = fillPromptTemplate(template, TS_PROFILE)
    expect(result).toBe("Before TS content after")
  })

  it("removes {{#if isTypeScript}} block for non-TS profile", () => {
    const template = "Before {{#if isTypeScript}}TS content{{/if}} after"
    const result = fillPromptTemplate(template, PY_PROFILE)
    expect(result).toBe("Before  after")
  })

  it("handles {{#if isPython}}...{{else}}...{{/if}}", () => {
    const template = "{{#if isPython}}Python path{{else}}Other path{{/if}}"
    const pyResult = fillPromptTemplate(template, PY_PROFILE)
    expect(pyResult).toBe("Python path")
    const tsResult = fillPromptTemplate(template, TS_PROFILE)
    expect(tsResult).toBe("Other path")
  })

  it("handles {{else if}} chains", () => {
    const template =
      "{{#if isTypeScript}}TS{{else if isPython}}PY{{else if isGo}}GO{{else}}OTHER{{/if}}"
    expect(fillPromptTemplate(template, TS_PROFILE)).toBe("TS")
    expect(fillPromptTemplate(template, PY_PROFILE)).toBe("PY")

    const goProfile: ToolchainProfile = {
      ...TS_PROFILE,
      language: "go",
      packageManager: "go",
    }
    expect(fillPromptTemplate(template, goProfile)).toBe("GO")

    const unknownProfile: ToolchainProfile = {
      ...TS_PROFILE,
      language: "ruby",
    }
    expect(fillPromptTemplate(template, unknownProfile)).toBe("OTHER")
  })

  it("processes conditionals before variable replacement", () => {
    const template = "{{#if isTypeScript}}Framework: {{testFramework}}{{/if}}"
    const result = fillPromptTemplate(template, TS_PROFILE)
    expect(result).toBe("Framework: Vitest")
  })

  it("handles multiline conditional blocks", () => {
    const template = [
      "{{#if isPython}}",
      "import pytest",
      "def test_something():",
      "    pass",
      "{{/if}}",
    ].join("\n")
    const result = fillPromptTemplate(template, PY_PROFILE)
    expect(result).toContain("import pytest")
    expect(result).toContain("def test_something():")
  })

  const allHigh: import("@bollard/detect/src/types.js").ConcernConfig = {
    correctness: "high",
    security: "high",
    performance: "high",
    resilience: "high",
  }

  it("renders all concern weights HIGH when scopeConcerns all high", () => {
    const t =
      "### A [{{concerns.correctness.weight}}]\n{{#concern correctness}}C{{/concern}}\n### B [{{concerns.security.weight}}]"
    const r = fillPromptTemplate(t, TS_PROFILE, allHigh)
    expect(r).toContain("[HIGH]")
    expect(r).toContain("C")
    expect(r).not.toContain("{{#concern")
  })

  it("omits concern block when weight off", () => {
    const concerns: import("@bollard/detect/src/types.js").ConcernConfig = {
      correctness: "high",
      security: "off",
      performance: "medium",
      resilience: "off",
    }
    const t =
      "### Correctness [{{concerns.correctness.weight}}]\n{{#concern correctness}}X{{/concern}}\n### Security [{{concerns.security.weight}}]\n{{#concern security}}Y{{/concern}}"
    const r = fillPromptTemplate(t, TS_PROFILE, concerns)
    expect(r).toContain("### Correctness [HIGH]")
    expect(r).toContain("X")
    expect(r).not.toContain("Security")
    expect(r).not.toContain("Y")
  })

  it("strips all concern syntax when scopeConcerns omitted", () => {
    const t = "### C [{{concerns.correctness.weight}}]\n{{#concern correctness}}Z{{/concern}}"
    const r = fillPromptTemplate(t, TS_PROFILE)
    expect(r).not.toContain("{{")
    expect(r).not.toContain("Z")
  })

  it("renders isJava block for Java profile", () => {
    const t = "{{#if isJava}}JVM{{/if}}{{#if isKotlin}}Kotlin{{/if}}"
    expect(fillPromptTemplate(t, JAVA_PROFILE)).toBe("JVM")
    expect(fillPromptTemplate(t, KOTLIN_PROFILE)).toBe("Kotlin")
    expect(fillPromptTemplate(t, TS_PROFILE)).toBe("")
  })

  it("JVM profiles include java and build tools in allowed commands string", () => {
    const t = "{{allowedCommands}}"
    expect(fillPromptTemplate(t, JAVA_PROFILE)).toContain("mvn")
    expect(fillPromptTemplate(t, JAVA_PROFILE)).toContain("java")
    expect(fillPromptTemplate(t, KOTLIN_PROFILE)).toContain("gradle")
  })
})
