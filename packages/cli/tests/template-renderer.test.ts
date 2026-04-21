import { defaultAdversarialConfig } from "@bollard/detect/src/concerns.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { describe, expect, it } from "vitest"
import { renderTemplate } from "../src/template-renderer.js"

function baseProfile(overrides: Partial<ToolchainProfile> = {}): ToolchainProfile {
  return {
    language: "typescript",
    packageManager: "pnpm",
    checks: {},
    sourcePatterns: ["**/*.ts"],
    testPatterns: ["**/*.test.ts"],
    ignorePatterns: [],
    allowedCommands: [],
    adversarial: defaultAdversarialConfig({ language: "typescript" }),
    ...overrides,
  }
}

describe("renderTemplate", () => {
  it("replaces {{language}} with capitalized language name", () => {
    const out = renderTemplate("Lang: {{language}}", baseProfile({ language: "python" }))
    expect(out).toBe("Lang: Python")
  })

  it("replaces {{languageId}} with raw language id", () => {
    const out = renderTemplate("id={{languageId}}", baseProfile({ language: "typescript" }))
    expect(out).toBe("id=typescript")
  })

  it("replaces {{packageManager}} with detected PM or none when absent", () => {
    expect(renderTemplate("pm={{packageManager}}", baseProfile())).toContain("pnpm")
    const noPm = renderTemplate("pm={{packageManager}}", baseProfile({ packageManager: undefined }))
    expect(noPm).toBe("pm=none")
  })

  it("replaces check labels (typecheck, linter, testFramework)", () => {
    const profile = baseProfile({
      checks: {
        typecheck: {
          label: "tsc",
          cmd: "pnpm",
          args: ["run", "typecheck"],
          source: "auto-detected",
        },
        lint: { label: "biome", cmd: "pnpm", args: ["run", "lint"], source: "auto-detected" },
        test: { label: "vitest", cmd: "pnpm", args: ["run", "test"], source: "auto-detected" },
      },
    })
    const t = "{{typecheck}} {{linter}} {{testFramework}}"
    expect(renderTemplate(t, profile)).toBe("tsc biome vitest")
  })

  it("replaces command strings (typecheckCmd, lintCmd, testCmd)", () => {
    const profile = baseProfile({
      checks: {
        typecheck: {
          label: "tsc",
          cmd: "pnpm",
          args: ["run", "typecheck"],
          source: "auto-detected",
        },
        lint: {
          label: "biome",
          cmd: "pnpm",
          args: ["exec", "biome", "check"],
          source: "auto-detected",
        },
        test: {
          label: "vitest",
          cmd: "pnpm",
          args: ["exec", "vitest", "run"],
          source: "auto-detected",
        },
      },
    })
    expect(renderTemplate("{{typecheckCmd}}", profile)).toBe("pnpm run typecheck")
    expect(renderTemplate("{{lintCmd}}", profile)).toBe("pnpm exec biome check")
    expect(renderTemplate("{{testCmd}}", profile)).toBe("pnpm exec vitest run")
  })

  it("includes {{#if isTypeScript}} block for TS profile", () => {
    const t = "{{#if isTypeScript}}TS{{/if}}{{#if isPython}}PY{{/if}}"
    expect(renderTemplate(t, baseProfile({ language: "typescript" }))).toBe("TS")
  })

  it("strips {{#if isPython}} block for TS profile", () => {
    const t = "{{#if isPython}}PY{{/if}}"
    expect(renderTemplate(t, baseProfile({ language: "typescript" }))).toBe("")
  })

  it("includes hasAudit when audit configured, strips when not", () => {
    const withAudit = baseProfile({
      checks: {
        audit: { label: "pnpm-audit", cmd: "pnpm", args: ["audit"], source: "auto-detected" },
      },
    })
    expect(renderTemplate("{{#if hasAudit}}yes{{/if}}", withAudit)).toBe("yes")
    expect(renderTemplate("{{#if hasAudit}}yes{{/if}}", baseProfile())).toBe("")
  })
})
