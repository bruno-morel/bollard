import { detectToolchain } from "@bollard/detect/src/detect.js"
import { describe, expect, it } from "vitest"

describe("--profile flag functionality", () => {
  it("detectToolchain returns valid ToolchainProfile with all required fields", async () => {
    // Use the Bollard workspace root (should have pnpm-workspace.yaml, tsconfig.json, etc.)
    const workspaceRoot = process.cwd()

    const profile = await detectToolchain(workspaceRoot)

    // Verify all required fields are present
    expect(profile).toBeDefined()
    expect(typeof profile.language).toBe("string")
    expect(profile.language).not.toBe("")

    // packageManager is optional but should be defined for Bollard workspace
    expect(profile.packageManager).toBeDefined()
    expect(typeof profile.packageManager).toBe("string")

    // checks object should exist
    expect(profile.checks).toBeDefined()
    expect(typeof profile.checks).toBe("object")

    // Each check command should have the required structure if present
    const checkTypes = ["typecheck", "lint", "test", "audit", "secretScan"] as const
    for (const checkType of checkTypes) {
      const check = profile.checks[checkType]
      if (check) {
        expect(typeof check.label).toBe("string")
        expect(typeof check.cmd).toBe("string")
        expect(Array.isArray(check.args)).toBe(true)
        expect(typeof check.source).toBe("string")
      }
    }

    // Pattern arrays should exist and be arrays
    expect(Array.isArray(profile.sourcePatterns)).toBe(true)
    expect(Array.isArray(profile.testPatterns)).toBe(true)
    expect(Array.isArray(profile.ignorePatterns)).toBe(true)
    expect(Array.isArray(profile.allowedCommands)).toBe(true)

    // adversarial config should exist
    expect(profile.adversarial).toBeDefined()
    expect(typeof profile.adversarial.mode).toBe("string")
    expect(["blackbox", "in-language", "both"]).toContain(profile.adversarial.mode)

    // Verify JSON.stringify works (produces valid JSON)
    const jsonString = JSON.stringify(profile, null, 2)
    expect(typeof jsonString).toBe("string")
    expect(jsonString.length).toBeGreaterThan(0)

    // Verify it can be parsed back
    const parsed = JSON.parse(jsonString)
    expect(parsed).toEqual(profile)

    // Verify specific expected values for Bollard workspace
    expect(profile.language).toBe("typescript")
    expect(profile.packageManager).toBe("pnpm")
    expect(profile.checks.typecheck).toBeDefined()
    expect(profile.checks.typecheck?.label).toBe("tsc")
  })

  it("JSON output includes all ToolchainProfile fields", async () => {
    const workspaceRoot = process.cwd()
    const profile = await detectToolchain(workspaceRoot)

    const jsonString = JSON.stringify(profile, null, 2)
    const parsed = JSON.parse(jsonString)

    // Verify all top-level fields are present in JSON
    const requiredFields = [
      "language",
      "checks",
      "sourcePatterns",
      "testPatterns",
      "ignorePatterns",
      "allowedCommands",
      "adversarial",
    ]

    for (const field of requiredFields) {
      expect(parsed).toHaveProperty(field)
    }

    // packageManager is optional but should be present for Bollard
    expect(parsed).toHaveProperty("packageManager")

    // Verify nested structures
    expect(typeof parsed.checks).toBe("object")
    expect(typeof parsed.adversarial).toBe("object")
    expect(typeof parsed.adversarial.mode).toBe("string")
  })
})
