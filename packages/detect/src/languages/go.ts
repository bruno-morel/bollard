import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
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

/** Parses `use` module paths from a go.work file (single-line and block forms). */
export function parseGoWorkUses(content: string): string[] {
  const uses: string[] = []
  let inUseBlock = false

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === "" || line.startsWith("//")) continue

    if (line.startsWith("use(") || line.startsWith("use (")) {
      inUseBlock = true
      continue
    }
    if (inUseBlock && line === ")") {
      inUseBlock = false
      continue
    }

    const singleUseMatch = /^use\s+(.+)$/.exec(line)
    if (singleUseMatch && !inUseBlock) {
      const cap = singleUseMatch[1]
      if (cap) {
        const token = stripGoWorkQuotes(cap.trim())
        if (token) uses.push(normalizeGoUsePath(token))
      }
      continue
    }

    if (inUseBlock) {
      const token = stripGoWorkQuotes(line)
      if (token && token !== ")") uses.push(normalizeGoUsePath(token))
    }
  }

  return [...new Set(uses)]
}

function stripGoWorkQuotes(s: string): string {
  const t = s.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).trim()
  }
  return t
}

function normalizeGoUsePath(p: string): string {
  let out = p.trim()
  if (out.startsWith("./")) out = out.slice(2)
  out = out.replace(/\/+$/, "")
  return out
}

function sourcePatternsFromGoWorkUses(relPaths: string[]): string[] {
  if (relPaths.length === 0) return deriveSourcePatterns("go")

  const patterns: string[] = []
  for (const m of relPaths) {
    if (m === "" || m === ".") {
      patterns.push(...deriveSourcePatterns("go"))
    } else {
      patterns.push(`${m}/**/*.go`, `!${m}/**/*_test.go`)
    }
  }
  return patterns
}

export async function detect(cwd: string): Promise<Partial<ToolchainProfile> | null> {
  const goModPath = join(cwd, "go.mod")
  const goWorkPath = join(cwd, "go.work")
  const hasMod = existsSync(goModPath)
  const hasWork = existsSync(goWorkPath)

  if (!hasMod && !hasWork) return null

  const linter = detectLinter(cwd)
  const extraTools: string[] = []
  if (linter.cmd !== "go") extraTools.push(linter.cmd)

  let sourcePatterns: string[]
  if (hasMod) {
    sourcePatterns = deriveSourcePatterns("go")
  } else {
    let workContent = ""
    try {
      workContent = await readFile(goWorkPath, "utf-8")
    } catch {
      return null
    }
    const uses = parseGoWorkUses(workContent)
    sourcePatterns = sourcePatternsFromGoWorkUses(uses)
  }

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
    sourcePatterns,
    testPatterns: deriveTestPatterns("go"),
    ignorePatterns: deriveIgnorePatterns("go"),
    allowedCommands: deriveAllowedCommands("go", "go", ["govulncheck", ...extraTools]),
  }
}
