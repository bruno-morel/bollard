import { extname } from "node:path"

export function deriveAdversarialTestPath(sourceFile: string): string {
  const ext = extname(sourceFile)
  const hasSrcDir = sourceFile.includes("/src/") || sourceFile.startsWith("src/")
  if (hasSrcDir) {
    return sourceFile
      .replace(/(^|\/)src\//, "$1tests/")
      .replace(new RegExp(`\\${ext}$`), `.adversarial.test${ext}`)
  }
  return sourceFile.replace(new RegExp(`\\${ext}$`), `.adversarial.test${ext}`)
}

export function stripMarkdownFences(output: string): string {
  let result = output.trim()
  result = result.replace(/^```\w*\n/, "")
  result = result.replace(/\n```\s*$/, "")
  return result
}
