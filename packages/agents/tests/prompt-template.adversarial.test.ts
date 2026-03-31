import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import { fillPromptTemplate } from "../src/prompt-template.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"

const validProfile: ToolchainProfile = {
  name: "test-profile",
  language: "javascript",
  framework: "react",
  packageManager: "npm",
  buildTool: "vite",
  testFramework: "vitest",
  linter: "eslint",
  formatter: "prettier"
}

describe("Feature: Template variable substitution", () => {
  it("should replace single variable with profile property", () => {
    const template = "Language: {{language}}"
    const result = fillPromptTemplate(template, validProfile)
    expect(result).toBe("Language: javascript")
  })

  it("should replace multiple variables with corresponding profile properties", () => {
    const template = "Using {{language}} with {{framework}} and {{testFramework}}"
    const result = fillPromptTemplate(template, validProfile)
    expect(result).toBe("Using javascript with react and vitest")
  })

  it("should handle repeated variables", () => {
    const template = "{{language}} is great, {{language}} is awesome"
    const result = fillPromptTemplate(template, validProfile)
    expect(result).toBe("javascript is great, javascript is awesome")
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
    expect(result).toBe("Known: javascript, Unknown: {{unknownProperty}}")
  })

  it("should handle malformed variable syntax", () => {
    const template = "Incomplete: {{language, Missing close: {{framework"
    const result = fillPromptTemplate(template, validProfile)
    expect(result).toContain("{{language")
    expect(result).toContain("{{framework")
  })

  it("should handle nested braces", () => {
    const template = "Nested: {{{language}}}"
    const result = fillPromptTemplate(template, validProfile)
    expect(result).toBe("Nested: {javascript}")
  })
})

describe("Feature: Edge cases and boundary conditions", () => {
  it("should handle empty template", () => {
    const result = fillPromptTemplate("", validProfile)
    expect(result).toBe("")
  })

  it("should handle template with only variables", () => {
    const template = "{{language}}{{framework}}"
    const result = fillPromptTemplate(template, validProfile)
    expect(result).toBe("javascriptreact")
  })

  it("should handle profile with empty string values", () => {
    const profileWithEmpty = { ...validProfile, language: "" }
    const template = "Language: {{language}}"
    const result = fillPromptTemplate(template, profileWithEmpty)
    expect(result).toBe("Language: ")
  })

  it("should handle whitespace in variable names", () => {
    const template = "{{ language }} and {{framework }}"
    const result = fillPromptTemplate(template, validProfile)
    expect(result).toContain("{{ language }}")
    expect(result).toContain("{{framework }")
  })
})

describe("Property-based tests", () => {
  it("should always return a string", () => {
    fc.assert(fc.property(
      fc.string(),
      fc.record({
        name: fc.string(),
        language: fc.string(),
        framework: fc.string(),
        packageManager: fc.string(),
        buildTool: fc.string(),
        testFramework: fc.string(),
        linter: fc.string(),
        formatter: fc.string()
      }),
      (template, profile) => {
        const result = fillPromptTemplate(template, profile)
        expect(typeof result).toBe("string")
      }
    ))
  })

  it("should preserve template length when no variables present", () => {
    fc.assert(fc.property(
      fc.string().filter(s => !s.includes("{{")),
      (template) => {
        const result = fillPromptTemplate(template, validProfile)
        expect(result.length).toBe(template.length)
        expect(result).toBe(template)
      }
    ))
  })

  it("should handle all valid profile property names", () => {
    const propertyNames = ["name", "language", "framework", "packageManager", "buildTool", "testFramework", "linter", "formatter"]
    
    fc.assert(fc.property(
      fc.constantFrom(...propertyNames),
      fc.string(),
      (propName, propValue) => {
        const profile = { ...validProfile, [propName]: propValue }
        const template = `{{${propName}}}`
        const result = fillPromptTemplate(template, profile)
        expect(result).toBe(propValue)
      }
    ))
  })

  it("should maintain character count invariant for simple substitutions", () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1, maxLength: 20 }),
      (value) => {
        const profile = { ...validProfile, language: value }
        const template = "{{language}}"
        const result = fillPromptTemplate(template, profile)
        expect(result.length).toBe(value.length)
      }
    ))
  })
})

describe("Negative tests", () => {
  it("should handle null profile gracefully", () => {
    expect(() => fillPromptTemplate("{{language}}", null as any)).toThrow()
  })

  it("should handle undefined profile gracefully", () => {
    expect(() => fillPromptTemplate("{{language}}", undefined as any)).toThrow()
  })

  it("should handle profile missing required properties", () => {
    const incompleteProfile = { name: "test" } as any
    const template = "{{language}}"
    const result = fillPromptTemplate(template, incompleteProfile)
    expect(result).toBe("{{language}}")
  })

  it("should handle extremely long templates", () => {
    const longTemplate = "{{language}}".repeat(10000)
    const result = fillPromptTemplate(longTemplate, validProfile)
    expect(result).toBe("javascript".repeat(10000))
    expect(result.length).toBe(100000)
  })

  it("should handle special characters in profile values", () => {
    const specialProfile = {
      ...validProfile,
      language: "C++",
      framework: "React.js",
      buildTool: "webpack@5"
    }
    const template = "{{language}} {{framework}} {{buildTool}}"
    const result = fillPromptTemplate(template, specialProfile)
    expect(result).toBe("C++ React.js webpack@5")
  })
})