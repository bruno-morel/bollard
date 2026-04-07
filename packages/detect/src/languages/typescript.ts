import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  deriveAllowedCommands,
  deriveIgnorePatterns,
  deriveSourcePatterns,
  deriveTestPatterns,
} from "../derive.js"
import type { PackageManagerId, ToolchainProfile, VerificationCommand } from "../types.js"

function detectPackageManager(cwd: string): PackageManagerId {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm"
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn"
  if (existsSync(join(cwd, "package-lock.json"))) return "npm"
  if (existsSync(join(cwd, "bun.lockb"))) return "bun"
  return "npm"
}

function detectLinter(cwd: string, pkg: PackageManagerId): VerificationCommand | undefined {
  if (existsSync(join(cwd, "biome.json")) || existsSync(join(cwd, "biome.jsonc"))) {
    return { label: "Biome", cmd: pkg, args: ["run", "lint"], source: "auto-detected" }
  }

  const eslintMarkers = [
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
    ".eslintrc.yml",
    ".eslintrc.yaml",
    "eslint.config.js",
    "eslint.config.cjs",
    "eslint.config.mjs",
    "eslint.config.ts",
  ]
  for (const marker of eslintMarkers) {
    if (existsSync(join(cwd, marker))) {
      return { label: "ESLint", cmd: pkg, args: ["run", "lint"], source: "auto-detected" }
    }
  }

  return undefined
}

function detectTestFramework(cwd: string, pkg: PackageManagerId): VerificationCommand | undefined {
  const vitestMarkers = ["vitest.config.ts", "vitest.config.js", "vitest.config.mts"]
  for (const marker of vitestMarkers) {
    if (existsSync(join(cwd, marker))) {
      return { label: "Vitest", cmd: pkg, args: ["run", "test"], source: "auto-detected" }
    }
  }

  const jestMarkers = ["jest.config.js", "jest.config.ts", "jest.config.cjs", "jest.config.mjs"]
  for (const marker of jestMarkers) {
    if (existsSync(join(cwd, marker))) {
      return { label: "Jest", cmd: pkg, args: ["run", "test"], source: "auto-detected" }
    }
  }

  return undefined
}

function detectLinterTool(cwd: string): string | undefined {
  if (existsSync(join(cwd, "biome.json")) || existsSync(join(cwd, "biome.jsonc"))) {
    return "biome"
  }
  const eslintMarkers = [
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
    ".eslintrc.yml",
    ".eslintrc.yaml",
    "eslint.config.js",
    "eslint.config.cjs",
    "eslint.config.mjs",
    "eslint.config.ts",
  ]
  for (const marker of eslintMarkers) {
    if (existsSync(join(cwd, marker))) return "eslint"
  }
  return undefined
}

export async function detect(cwd: string): Promise<Partial<ToolchainProfile> | null> {
  if (!existsSync(join(cwd, "tsconfig.json"))) return null

  const pkg = detectPackageManager(cwd)
  const linter = detectLinter(cwd, pkg)
  const test = detectTestFramework(cwd, pkg)
  const linterTool = detectLinterTool(cwd)
  const extraTools = linterTool ? [linterTool] : []

  return {
    language: "typescript",
    packageManager: pkg,
    checks: {
      typecheck: {
        label: "tsc",
        cmd: pkg,
        args: ["run", "typecheck"],
        source: "auto-detected",
      },
      ...(linter ? { lint: linter } : {}),
      ...(test ? { test } : {}),
      audit: {
        label: `${pkg} audit`,
        cmd: pkg,
        args: ["audit", "--audit-level=high"],
        source: "auto-detected",
      },
    },
    sourcePatterns: deriveSourcePatterns("typescript"),
    testPatterns: deriveTestPatterns("typescript"),
    ignorePatterns: deriveIgnorePatterns("typescript"),
    allowedCommands: deriveAllowedCommands("typescript", pkg, extraTools),
  }
}
