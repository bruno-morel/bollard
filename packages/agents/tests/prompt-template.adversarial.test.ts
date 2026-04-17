import { defaultAdversarialConfig } from "@bollard/detect/src/concerns.js"
import type { LanguageId, ToolchainProfile } from "@bollard/detect/src/types.js"
import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import { fillPromptTemplate } from "../src/prompt-template.js"

const validProfile: ToolchainProfile = {
  language: "javascript",
  packageManager: "npm",
  checks: {
    typecheck: { label: "tsc", cmd: "npx", args: ["tsc"], source: "auto-detected" },
    lint: { label: "eslint", cmd: "npx", args: ["eslint"], source: "auto-detected" },
    test: { label: "vitest", cmd: "npm", args: ["test"], source: "auto-detected" },
    audit: { label: "npm audit", cmd: "npm", args: ["audit"], source: "auto-detected" },
  },
  sourcePatterns: ["**/*.js"],
  testPatterns: ["**/*.test.js"],
  ignorePatterns: [],
  allowedCommands: ["npm", "node"],
  adversarial: defaultAdversarialConfig({ language: "javascript" }),
}

describe("Feature: Template variable substitution", () => {
  it("should replace language placeholder (capitalized)", () => {
    const template = "Language: {{language}}"
    const result = fillPromptTemplate(template, validProfile)
    expect(result).toBe("Language: Javascript")
  })

  it("should replace multiple known placeholders", () => {
    const template = "PM: {{packageManager}}, Test: {{testFramework}}, Lint: {{linter}}"
    const result = fillPromptTemplate(template, validProfile)
    expect(result).toBe("PM: npm, Test: vitest, Lint: eslint")
  })

  it("should handle repeated variables", () => {
    const template = "{{language}} — {{language}}"
    const result = fillPromptTemplate(template, validProfile)
    expect(result).toBe("Javascript — Javascript")
  })

  it("should preserve text without variables", () => {
    const template = "This is plain text without any variables"
    const result = fillPromptTemplate(template, validProfile)
    expect(result).toBe("This is plain text without any variables")
  })
})

describe("Feature: Handle missing or invalid variables", () => {
  it("should preserve unknown variable placeholders", () => {
    const template = "Known: {{language}}, Unknown: {{unknownProperty}}"
    const result = fillPromptTemplate(template, validProfile)
    expect(result).toBe("Known: Javascript, Unknown: {{unknownProperty}}")
  })

  it("should handle nested braces", () => {
    const template = "Nested: {{{language}}}"
    const result = fillPromptTemplate(template, validProfile)
    expect(result).toBe("Nested: {Javascript}")
  })
})

describe("Feature: Edge cases and boundary conditions", () => {
  it("should handle empty template", () => {
    const result = fillPromptTemplate("", validProfile)
    expect(result).toBe("")
  })

  it("should handle template with only variables", () => {
    const template = "{{language}}{{packageManager}}"
    const result = fillPromptTemplate(template, validProfile)
    expect(result).toBe("Javascriptnpm")
  })

  it("should handle unknown language label", () => {
    const profile: ToolchainProfile = { ...validProfile, language: "unknown" }
    const template = "Language: {{language}}"
    const result = fillPromptTemplate(template, profile)
    expect(result).toBe("Language: Unknown")
  })

  it("capitalizes known LanguageId values consistently", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<LanguageId>("typescript", "python", "go", "rust", "kotlin", "unknown"),
        (lang) => {
          const profile: ToolchainProfile = { ...validProfile, language: lang }
          const result = fillPromptTemplate("{{language}}", profile)
          const cap = lang.charAt(0).toUpperCase() + lang.slice(1)
          expect(result).toBe(cap)
        },
      ),
    )
  })
})

describe("Property-based tests", () => {
  it("should always return a string", () => {
    fc.assert(
      fc.property(fc.string(), (template) => {
        const result = fillPromptTemplate(template, validProfile)
        expect(typeof result).toBe("string")
      }),
    )
  })

  it("should preserve template length when no variables present", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !s.includes("{{")),
        (template) => {
          const result = fillPromptTemplate(template, validProfile)
          expect(result.length).toBe(template.length)
          expect(result).toBe(template)
        },
      ),
    )
  })

})

describe("Negative tests", () => {
  it("should throw on null profile", () => {
    expect(() => fillPromptTemplate("{{language}}", null as unknown as ToolchainProfile)).toThrow()
  })

  it("should throw on undefined profile", () => {
    expect(() => fillPromptTemplate("{{language}}", undefined as unknown as ToolchainProfile)).toThrow()
  })

  it("should handle extremely long templates", () => {
    const longTemplate = "{{language}}".repeat(1000)
    const result = fillPromptTemplate(longTemplate, validProfile)
    expect(result).toBe("Javascript".repeat(1000))
  })
})
