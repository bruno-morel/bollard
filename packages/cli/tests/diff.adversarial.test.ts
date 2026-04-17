import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import { diffToolchainProfile } from "../src/diff.js"
import { defaultAdversarialConfig } from "@bollard/detect/src/concerns.js"
import type { ToolchainProfile, VerificationCommand } from "@bollard/detect/src/types.js"

const defaultTest: VerificationCommand = {
  label: "test",
  cmd: "pnpm",
  args: ["exec", "vitest", "run"],
  source: "default",
}

const defaultTypecheck: VerificationCommand = {
  label: "typecheck",
  cmd: "pnpm",
  args: ["run", "typecheck"],
  source: "default",
}

const defaultLint: VerificationCommand = {
  label: "lint",
  cmd: "pnpm",
  args: ["run", "lint"],
  source: "default",
}

const defaultAudit: VerificationCommand = {
  label: "audit",
  cmd: "pnpm",
  args: ["audit", "--audit-level=high"],
  source: "default",
}

function base(overrides: Partial<ToolchainProfile> = {}): ToolchainProfile {
  return {
    language: "typescript",
    checks: {},
    sourcePatterns: [],
    testPatterns: [],
    ignorePatterns: [],
    allowedCommands: [],
    adversarial: defaultAdversarialConfig({ language: "typescript" }),
    ...overrides,
  }
}

describe("diffToolchainProfile structure", () => {
  it("returns DiffResult with checks, patterns, adversarial, summary", () => {
    const result = diffToolchainProfile(base())
    expect(Array.isArray(result.checks)).toBe(true)
    expect(Array.isArray(result.patterns)).toBe(true)
    expect(result).toHaveProperty("adversarial")
    expect(result.summary).toMatchObject({
      unchanged: expect.any(Number),
      differ: expect.any(Number),
      new: expect.any(Number),
      removed: expect.any(Number),
    })
  })

  it("marks missing default checks as removed when profile has empty checks", () => {
    const result = diffToolchainProfile(base({ checks: {} }))
    expect(result.summary.removed).toBeGreaterThanOrEqual(4)
    const names = new Set(result.checks.map((c) => c.name))
    expect(names.has("typecheck")).toBe(true)
    expect(names.has("test")).toBe(true)
  })

  it("marks test as unchanged when identical to hardcoded default", () => {
    const result = diffToolchainProfile(
      base({
        checks: {
          test: { ...defaultTest, source: "auto-detected" },
        },
      }),
    )
    const testDiff = result.checks.find((c) => c.name === "test")
    expect(testDiff?.status).toBe("unchanged")
  })

  it("marks test as differ when command differs", () => {
    const result = diffToolchainProfile(
      base({
        checks: {
          test: {
            label: "test",
            cmd: "npm",
            args: ["test"],
            source: "auto-detected",
          },
        },
      }),
    )
    const testDiff = result.checks.find((c) => c.name === "test")
    expect(testDiff?.status).toBe("differ")
  })

  it("reports new checks only present in profile", () => {
    const extra: VerificationCommand = {
      label: "custom",
      cmd: "echo",
      args: ["ok"],
      source: "auto-detected",
    }
    const result = diffToolchainProfile(
      base({
        checks: {
          typecheck: { ...defaultTypecheck, source: "auto-detected" },
          lint: { ...defaultLint, source: "auto-detected" },
          audit: { ...defaultAudit, source: "auto-detected" },
          test: { ...defaultTest, source: "auto-detected" },
          secretScan: extra,
        },
      }),
    )
    expect(result.checks.some((c) => c.name === "secretScan" && c.status === "new")).toBe(true)
  })

  it("diffs source patterns vs defaults", () => {
    const result = diffToolchainProfile(
      base({
        sourcePatterns: ["src/**/*.ts"],
      }),
    )
    const p = result.patterns.find((x) => x.type === "sourcePatterns")
    expect(p?.added).toContain("src/**/*.ts")
  })
})

describe("diffToolchainProfile property tests", () => {
  it("summary counts sum to checks length", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 12 }), { minLength: 0, maxLength: 6 }),
        (extraPatterns) => {
          const result = diffToolchainProfile(
            base({
              sourcePatterns: extraPatterns,
            }),
          )
          const s = result.summary
          const sum = s.unchanged + s.differ + s.new + s.removed
          expect(sum).toBe(result.checks.length)
        },
      ),
    )
  })
})
