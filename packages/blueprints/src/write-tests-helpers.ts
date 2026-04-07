import { basename, dirname, extname, join } from "node:path"
import type { AdversarialScope, ToolchainProfile } from "@bollard/detect/src/types.js"

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

function deriveTypescriptContractPath(sourceFile: string): string {
  const ext = extname(sourceFile)
  const base = basename(sourceFile, ext)
  const hasSrcDir = sourceFile.includes("/src/") || sourceFile.startsWith("src/")
  if (hasSrcDir) {
    return sourceFile
      .replace(/(^|\/)src\//, "$1tests/contracts/")
      .replace(new RegExp(`\\${ext}$`), `.contract.test${ext}`)
  }
  return join(dirname(sourceFile), "tests/contracts", `${base}.contract.test${ext}`)
}

function derivePythonTestPath(sourceFile: string): string {
  const dir = dirname(sourceFile)
  const base = basename(sourceFile, ".py")
  const hasSrcDir = sourceFile.includes("/src/") || sourceFile.startsWith("src/")
  const targetDir = hasSrcDir ? dir.replace(/(^|\/)src(\/|$)/, "$1tests$2") : dir
  return join(targetDir, `test_adversarial_${base}.py`)
}

function derivePythonContractPath(sourceFile: string): string {
  const dir = dirname(sourceFile)
  const base = basename(sourceFile, ".py")
  const hasSrcDir = sourceFile.includes("/src/") || sourceFile.startsWith("src/")
  const targetDir = hasSrcDir
    ? dir.replace(/(^|\/)src(\/|$)/, "$1tests/contracts$2")
    : join(dir, "tests/contracts")
  return join(targetDir, `test_${base}_contract.py`)
}

function deriveGoTestPath(sourceFile: string): string {
  const ext = extname(sourceFile)
  return sourceFile.replace(new RegExp(`\\${ext}$`), `_adversarial_test${ext}`)
}

function deriveGoContractPath(sourceFile: string): string {
  const ext = extname(sourceFile)
  return sourceFile.replace(new RegExp(`\\${ext}$`), `_contract_test${ext}`)
}

function deriveRustTestPath(sourceFile: string): string {
  const dir = dirname(sourceFile)
  const base = basename(sourceFile, ".rs")
  const hasSrcDir = sourceFile.includes("/src/") || sourceFile.startsWith("src/")
  const targetDir = hasSrcDir ? dir.replace(/(^|\/)src(\/|$)/, "$1tests$2") : dir
  return join(targetDir, `${base}_adversarial_test.rs`)
}

function deriveRustContractPath(sourceFile: string): string {
  const dir = dirname(sourceFile)
  const base = basename(sourceFile, ".rs")
  const hasSrcDir = sourceFile.includes("/src/") || sourceFile.startsWith("src/")
  const targetDir = hasSrcDir
    ? dir.replace(/(^|\/)src(\/|$)/, "$1tests/contracts$2")
    : join(dir, "tests/contracts")
  return join(targetDir, `${base}_contract.rs`)
}

export function deriveAdversarialTestPath(
  sourceFile: string,
  profile?: ToolchainProfile,
  scope: AdversarialScope = "boundary",
): string {
  const lang = profile?.language ?? "typescript"

  if (scope === "contract") {
    switch (lang) {
      case "python":
        return derivePythonContractPath(sourceFile)
      case "go":
        return deriveGoContractPath(sourceFile)
      case "rust":
        return deriveRustContractPath(sourceFile)
      default:
        return deriveTypescriptContractPath(sourceFile)
    }
  }

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
