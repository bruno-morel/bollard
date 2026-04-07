import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  deriveAllowedCommands,
  deriveIgnorePatterns,
  deriveSourcePatterns,
  deriveTestPatterns,
} from "../derive.js"
import type { ToolchainProfile, VerificationCommand } from "../types.js"

function detectLinter(cwd: string): VerificationCommand {
  if (existsSync(join(cwd, ".golangci.yml")) || existsSync(join(cwd, ".golangci.yaml"))) {
    return {
      label: "golangci-lint",
      cmd: "golangci-lint",
      args: ["run"],
      source: "auto-detected",
    }
  }

  return { label: "go vet", cmd: "go", args: ["vet", "./..."], source: "auto-detected" }
}

export async function detect(cwd: string): Promise<Partial<ToolchainProfile> | null> {
  if (!existsSync(join(cwd, "go.mod"))) return null

  const linter = detectLinter(cwd)
  const extraTools: string[] = []
  if (linter.cmd !== "go") extraTools.push(linter.cmd)

  return {
    language: "go",
    packageManager: "go",
    checks: {
      typecheck: {
        label: "go vet",
        cmd: "go",
        args: ["vet", "./..."],
        source: "auto-detected",
      },
      lint: linter,
      test: {
        label: "go test",
        cmd: "go",
        args: ["test", "./..."],
        source: "auto-detected",
      },
      audit: {
        label: "govulncheck",
        cmd: "govulncheck",
        args: ["./..."],
        source: "auto-detected",
      },
    },
    sourcePatterns: deriveSourcePatterns("go"),
    testPatterns: deriveTestPatterns("go"),
    ignorePatterns: deriveIgnorePatterns("go"),
    allowedCommands: deriveAllowedCommands("go", "go", ["govulncheck", ...extraTools]),
  }
}
