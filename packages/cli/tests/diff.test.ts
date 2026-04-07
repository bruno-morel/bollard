import { defaultAdversarialConfig } from "@bollard/detect/src/concerns.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { describe, expect, it } from "vitest"
import { diffToolchainProfile } from "../src/diff.js"

describe("diffToolchainProfile", () => {
  it("should show all checks as unchanged for Bollard workspace profile", () => {
    // This profile represents what the Bollard workspace should detect
    // Based on Stage 1.5 equivalence proof, these should match hardcoded defaults
    const bollardProfile: ToolchainProfile = {
      language: "typescript",
      packageManager: "pnpm",
      checks: {
        typecheck: {
          label: "typecheck",
          cmd: "pnpm",
          args: ["run", "typecheck"],
          source: "auto-detected",
        },
        lint: {
          label: "lint",
          cmd: "pnpm",
          args: ["run", "lint"],
          source: "auto-detected",
        },
        audit: {
          label: "audit",
          cmd: "pnpm",
          args: ["audit", "--audit-level=high"],
          source: "auto-detected",
        },
        test: {
          label: "test",
          cmd: "pnpm",
          args: ["exec", "vitest", "run"],
          source: "auto-detected",
        },
      },
      sourcePatterns: [
        "**/*.ts",
        "**/*.tsx",
        "!**/*.test.ts",
        "!**/*.spec.ts",
        "!**/node_modules/**",
        "!**/dist/**",
      ],
      testPatterns: ["**/*.test.ts", "**/*.spec.ts"],
      ignorePatterns: ["**/node_modules/**", "**/dist/**"],
      allowedCommands: ["npm", "npx", "node", "tsc", "git", "cat", "head", "tail", "wc", "diff"],
      adversarial: defaultAdversarialConfig({ language: "typescript" }),
    }

    const diff = diffToolchainProfile(bollardProfile)

    // All checks should be unchanged
    expect(diff.summary.unchanged).toBe(4)
    expect(diff.summary.differ).toBe(0)
    expect(diff.summary.new).toBe(0)
    expect(diff.summary.removed).toBe(0)

    // Verify each check is marked as unchanged
    const checksByName = Object.fromEntries(diff.checks.map((c) => [c.name, c]))
    expect(checksByName.typecheck.status).toBe("unchanged")
    expect(checksByName.lint.status).toBe("unchanged")
    expect(checksByName.audit.status).toBe("unchanged")
    expect(checksByName.test.status).toBe("unchanged")

    // All patterns should be unchanged (no additions or removals)
    for (const pattern of diff.patterns) {
      expect(pattern.added).toEqual([])
      expect(pattern.removed).toEqual([])
      expect(pattern.unchanged.length).toBeGreaterThan(0)
    }
  })

  it("should show all checks as differ for Python profile", () => {
    const pythonProfile: ToolchainProfile = {
      language: "python",
      packageManager: "poetry",
      checks: {
        typecheck: {
          label: "typecheck",
          cmd: "poetry",
          args: ["run", "mypy", "."],
          source: "auto-detected",
        },
        lint: {
          label: "lint",
          cmd: "poetry",
          args: ["run", "ruff", "check"],
          source: "auto-detected",
        },
        test: {
          label: "test",
          cmd: "poetry",
          args: ["run", "pytest"],
          source: "auto-detected",
        },
        // No audit equivalent in Python
      },
      sourcePatterns: ["**/*.py", "!**/test_*.py", "!**/*_test.py", "!**/venv/**"],
      testPatterns: ["**/test_*.py", "**/*_test.py"],
      ignorePatterns: ["**/venv/**", "**/__pycache__/**"],
      allowedCommands: ["python", "pip", "poetry", "git", "cat", "head", "tail", "wc", "diff"],
      adversarial: defaultAdversarialConfig({ language: "python" }),
    }

    const diff = diffToolchainProfile(pythonProfile)

    // Should have differs and removals, no unchanged
    expect(diff.summary.unchanged).toBe(0)
    expect(diff.summary.differ).toBe(3) // typecheck, lint, test differ
    expect(diff.summary.new).toBe(0)
    expect(diff.summary.removed).toBe(1) // audit is removed

    const checksByName = Object.fromEntries(diff.checks.map((c) => [c.name, c]))
    expect(checksByName.typecheck.status).toBe("differ")
    expect(checksByName.lint.status).toBe("differ")
    expect(checksByName.test.status).toBe("differ")
    expect(checksByName.audit.status).toBe("removed")

    // Patterns should show differences
    const sourcePatterns = diff.patterns.find((p) => p.type === "sourcePatterns")
    expect(sourcePatterns).toBeDefined()
    expect(sourcePatterns?.added.length).toBeGreaterThan(0)
    expect(sourcePatterns?.removed.length).toBeGreaterThan(0)

    const allowedCommands = diff.patterns.find((p) => p.type === "allowedCommands")
    expect(allowedCommands).toBeDefined()
    expect(allowedCommands?.added).toContain("python")
    expect(allowedCommands?.added).toContain("poetry")
    expect(allowedCommands?.removed).toContain("tsc")
  })

  it("should show all hardcoded checks as removed for empty profile", () => {
    const emptyProfile: ToolchainProfile = {
      language: "unknown",
      checks: {},
      sourcePatterns: [],
      testPatterns: [],
      ignorePatterns: [],
      allowedCommands: [],
      adversarial: defaultAdversarialConfig({ language: "unknown" }),
    }

    const diff = diffToolchainProfile(emptyProfile)

    // All hardcoded checks should be removed
    expect(diff.summary.unchanged).toBe(0)
    expect(diff.summary.differ).toBe(0)
    expect(diff.summary.new).toBe(0)
    expect(diff.summary.removed).toBe(4) // typecheck, lint, audit, test

    const checksByName = Object.fromEntries(diff.checks.map((c) => [c.name, c]))
    expect(checksByName.typecheck.status).toBe("removed")
    expect(checksByName.lint.status).toBe("removed")
    expect(checksByName.audit.status).toBe("removed")
    expect(checksByName.test.status).toBe("removed")

    // All patterns should be removed
    for (const pattern of diff.patterns) {
      expect(pattern.added).toEqual([])
      expect(pattern.unchanged).toEqual([])
      expect(pattern.removed.length).toBeGreaterThan(0)
    }
  })

  it("should detect new checks not in hardcoded defaults", () => {
    const profileWithNewChecks: ToolchainProfile = {
      language: "typescript",
      packageManager: "pnpm",
      checks: {
        typecheck: {
          label: "typecheck",
          cmd: "pnpm",
          args: ["run", "typecheck"],
          source: "auto-detected",
        },
        lint: {
          label: "lint",
          cmd: "pnpm",
          args: ["run", "lint"],
          source: "auto-detected",
        },
        audit: {
          label: "audit",
          cmd: "pnpm",
          args: ["audit", "--audit-level=high"],
          source: "auto-detected",
        },
        test: {
          label: "test",
          cmd: "pnpm",
          args: ["exec", "vitest", "run"],
          source: "auto-detected",
        },
        secretScan: {
          label: "secretScan",
          cmd: "truffleHog",
          args: ["--regex", "--entropy=False", "."],
          source: "auto-detected",
        },
      },
      sourcePatterns: [
        "**/*.ts",
        "**/*.tsx",
        "!**/*.test.ts",
        "!**/*.spec.ts",
        "!**/node_modules/**",
        "!**/dist/**",
      ],
      testPatterns: ["**/*.test.ts", "**/*.spec.ts"],
      ignorePatterns: ["**/node_modules/**", "**/dist/**"],
      allowedCommands: ["npm", "npx", "node", "tsc", "git", "cat", "head", "tail", "wc", "diff"],
      adversarial: defaultAdversarialConfig({ language: "typescript" }),
    }

    const diff = diffToolchainProfile(profileWithNewChecks)

    expect(diff.summary.unchanged).toBe(4)
    expect(diff.summary.differ).toBe(0)
    expect(diff.summary.new).toBe(1) // secretScan is new
    expect(diff.summary.removed).toBe(0)

    const checksByName = Object.fromEntries(diff.checks.map((c) => [c.name, c]))
    expect(checksByName.secretScan.status).toBe("new")
    expect(checksByName.secretScan.detected?.cmd).toBe("truffleHog")
  })

  it("should handle mixed scenarios with unchanged, differ, new, and removed", () => {
    const mixedProfile: ToolchainProfile = {
      language: "typescript",
      packageManager: "npm", // Different from pnpm in hardcoded
      checks: {
        typecheck: {
          label: "typecheck",
          cmd: "pnpm",
          args: ["run", "typecheck"],
          source: "auto-detected",
        }, // unchanged
        lint: {
          label: "lint",
          cmd: "eslint",
          args: ["src/"],
          source: "auto-detected",
        }, // differ
        // audit is missing (removed)
        test: {
          label: "test",
          cmd: "jest",
          args: ["--coverage"],
          source: "auto-detected",
        }, // differ
        secretScan: {
          label: "secretScan",
          cmd: "gitleaks",
          args: ["detect"],
          source: "auto-detected",
        }, // new
      },
      sourcePatterns: ["**/*.ts", "**/*.tsx", "!**/*.test.ts"],
      testPatterns: ["**/*.test.ts"],
      ignorePatterns: [],
      allowedCommands: ["npm", "node", "git"],
      adversarial: defaultAdversarialConfig({ language: "typescript" }),
    }

    const diff = diffToolchainProfile(mixedProfile)

    expect(diff.summary.unchanged).toBe(1) // typecheck
    expect(diff.summary.differ).toBe(2) // lint, test
    expect(diff.summary.new).toBe(1) // secretScan
    expect(diff.summary.removed).toBe(1) // audit

    const checksByName = Object.fromEntries(diff.checks.map((c) => [c.name, c]))
    expect(checksByName.typecheck.status).toBe("unchanged")
    expect(checksByName.lint.status).toBe("differ")
    expect(checksByName.test.status).toBe("differ")
    expect(checksByName.audit.status).toBe("removed")
    expect(checksByName.secretScan.status).toBe("new")
  })

  it("should correctly compare command arguments", () => {
    const profileWithDifferentArgs: ToolchainProfile = {
      language: "typescript",
      packageManager: "pnpm",
      checks: {
        audit: {
          label: "audit",
          cmd: "pnpm",
          args: ["audit", "--audit-level=moderate"], // Different level
          source: "auto-detected",
        },
      },
      sourcePatterns: [],
      testPatterns: [],
      ignorePatterns: [],
      allowedCommands: [],
      adversarial: defaultAdversarialConfig({ language: "typescript" }),
    }

    const diff = diffToolchainProfile(profileWithDifferentArgs)

    const auditCheck = diff.checks.find((c) => c.name === "audit")
    expect(auditCheck).toBeDefined()
    expect(auditCheck?.status).toBe("differ")
    expect(auditCheck?.hardcoded?.args).toEqual(["audit", "--audit-level=high"])
    expect(auditCheck?.detected?.args).toEqual(["audit", "--audit-level=moderate"])
  })
})
