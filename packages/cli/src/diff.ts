import type { ToolchainProfile, VerificationCommand } from "@bollard/detect/src/types.js"

export interface CheckDiff {
  name: string
  status: "unchanged" | "differ" | "new" | "removed"
  hardcoded?: VerificationCommand
  detected?: VerificationCommand
}

export interface PatternDiff {
  type: "sourcePatterns" | "testPatterns" | "allowedCommands"
  unchanged: string[]
  added: string[]
  removed: string[]
}

export interface DiffResult {
  checks: CheckDiff[]
  patterns: PatternDiff[]
  summary: {
    unchanged: number
    differ: number
    new: number
    removed: number
  }
}

function createHardcodedDefaults(): {
  checks: Record<string, VerificationCommand>
  sourcePatterns: string[]
  testPatterns: string[]
  allowedCommands: string[]
} {
  return {
    checks: {
      typecheck: {
        label: "typecheck",
        cmd: "pnpm",
        args: ["run", "typecheck"],
        source: "default",
      },
      lint: {
        label: "lint",
        cmd: "pnpm",
        args: ["run", "lint"],
        source: "default",
      },
      audit: {
        label: "audit",
        cmd: "pnpm",
        args: ["audit", "--audit-level=high"],
        source: "default",
      },
      test: {
        label: "test",
        cmd: "pnpm",
        args: ["exec", "vitest", "run"],
        source: "default",
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
    allowedCommands: ["npm", "npx", "node", "tsc", "git", "cat", "head", "tail", "wc", "diff"],
  }
}

function commandsEqual(a: VerificationCommand, b: VerificationCommand): boolean {
  return a.cmd === b.cmd && JSON.stringify(a.args) === JSON.stringify(b.args)
}

function compareArrays(
  hardcoded: string[],
  detected: string[],
): {
  unchanged: string[]
  added: string[]
  removed: string[]
} {
  const hardcodedSet = new Set(hardcoded)
  const detectedSet = new Set(detected)

  const unchanged = hardcoded.filter((item) => detectedSet.has(item))
  const added = detected.filter((item) => !hardcodedSet.has(item))
  const removed = hardcoded.filter((item) => !detectedSet.has(item))

  return { unchanged, added, removed }
}

export function diffToolchainProfile(profile: ToolchainProfile): DiffResult {
  const hardcoded = createHardcodedDefaults()
  const checks: CheckDiff[] = []

  // Compare each hardcoded check
  for (const [checkName, hardcodedCheck] of Object.entries(hardcoded.checks)) {
    const detectedCheck = profile.checks[checkName as keyof typeof profile.checks]

    if (!detectedCheck) {
      checks.push({
        name: checkName,
        status: "removed",
        hardcoded: hardcodedCheck,
      })
    } else if (commandsEqual(hardcodedCheck, detectedCheck)) {
      checks.push({
        name: checkName,
        status: "unchanged",
        hardcoded: hardcodedCheck,
        detected: detectedCheck,
      })
    } else {
      checks.push({
        name: checkName,
        status: "differ",
        hardcoded: hardcodedCheck,
        detected: detectedCheck,
      })
    }
  }

  // Find new checks in profile that aren't in hardcoded defaults
  for (const [checkName, detectedCheck] of Object.entries(profile.checks)) {
    if (detectedCheck && !hardcoded.checks[checkName]) {
      checks.push({
        name: checkName,
        status: "new",
        detected: detectedCheck,
      })
    }
  }

  // Compare patterns and allowed commands
  const sourcePatternsDiff = compareArrays(hardcoded.sourcePatterns, profile.sourcePatterns)
  const testPatternsDiff = compareArrays(hardcoded.testPatterns, profile.testPatterns)
  const allowedCommandsDiff = compareArrays(hardcoded.allowedCommands, profile.allowedCommands)

  const patterns: PatternDiff[] = [
    { type: "sourcePatterns", ...sourcePatternsDiff },
    { type: "testPatterns", ...testPatternsDiff },
    { type: "allowedCommands", ...allowedCommandsDiff },
  ]

  // Calculate summary
  const unchanged = checks.filter((c) => c.status === "unchanged").length
  const differ = checks.filter((c) => c.status === "differ").length
  const newChecks = checks.filter((c) => c.status === "new").length
  const removed = checks.filter((c) => c.status === "removed").length

  return {
    checks,
    patterns,
    summary: {
      unchanged,
      differ,
      new: newChecks,
      removed,
    },
  }
}
