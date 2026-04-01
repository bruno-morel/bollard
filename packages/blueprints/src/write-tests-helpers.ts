import { basename, dirname, extname, join } from "node:path"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"

function deriveTypescriptTestPath(sourceFile: string): string {
  const ext = extname(sourceFile)
  const hasSrcDir = sourceFile.includes("/src/") || sourceFile.startsWith("src/")
  if (hasSrcDir) {
    return sourceFile
      .replace(/(^|\/)src\//, "$1tests/")
      .replace(new RegExp(`\\${ext}$`), `.adversarial.test${ext}`)
  }
  return sourceFile.replace(new RegExp(`\\${ext}$`), `.adversarial.test${ext}`)
}

function derivePythonTestPath(sourceFile: string): string {
  const dir = dirname(sourceFile)
  const base = basename(sourceFile, ".py")
  const hasSrcDir = sourceFile.includes("/src/") || sourceFile.startsWith("src/")
  const targetDir = hasSrcDir ? dir.replace(/(^|\/)src(\/|$)/, "$1tests$2") : dir
  return join(targetDir, `test_adversarial_${base}.py`)
}

function deriveGoTestPath(sourceFile: string): string {
  const ext = extname(sourceFile)
  return sourceFile.replace(new RegExp(`\\${ext}$`), `_adversarial_test${ext}`)
}

function deriveRustTestPath(sourceFile: string): string {
  const dir = dirname(sourceFile)
  const base = basename(sourceFile, ".rs")
  const hasSrcDir = sourceFile.includes("/src/") || sourceFile.startsWith("src/")
  const targetDir = hasSrcDir ? dir.replace(/(^|\/)src(\/|$)/, "$1tests$2") : dir
  return join(targetDir, `${base}_adversarial_test.rs`)
}

export function deriveAdversarialTestPath(sourceFile: string, profile?: ToolchainProfile): string {
  const lang = profile?.language ?? "typescript"

  switch (lang) {
    case "python":
      return derivePythonTestPath(sourceFile)
    case "go":
      return deriveGoTestPath(sourceFile)
    case "rust":
      return deriveRustTestPath(sourceFile)
    default:
      return deriveTypescriptTestPath(sourceFile)
  }
}

export function stripMarkdownFences(output: string): string {
  let result = output.trim()
  result = result.replace(/^```\w*\n/, "")
  result = result.replace(/\n```\s*$/, "")
  return result
}
