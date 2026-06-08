import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { BOLD, DIM, GREEN, RED, RESET } from "./terminal-styles.js"

export type DocsCheckId =
  | "mcp-tool-count"
  | "spec-doc-links"
  | "adr-links"
  | "test-count-consistency"

export interface DocsCheckResult {
  id: DocsCheckId
  label: string
  passed: boolean
  expected?: string
  actual?: string
}

export interface AuditDocsResult {
  allPassed: boolean
  checks: DocsCheckResult[]
}

const MCP_TOOLS_SOURCE_REL = "packages/mcp/src/tools.ts"
const SPEC_DOC_PATTERN = /^\d{2}-.*\.md$/
const ADR_DOC_PATTERN = /^\d{4}-.*\.md$/
const MCP_SERVER_CLAIM = /MCP server:\*?\*?\s*(\d+)\s+tools/i
const README_MAIN_COUNTS = /(\d+)\s+passed\s+\/\s+(\d+)\s+skipped/i
const README_ADVERSARIAL = /Adversarial suite:?\*?\*?\s*(\d+)\s+passed/i
const CLAUDE_LATEST_COUNT = /\*\*Latest count[^`]*`(\d+)`\s+passed,\s*`(\d+)`\s+skipped/i
const CLAUDE_ADVERSARIAL = /Adversarial suite\s*`(\d+)`\s+passed/i

export function countMcpToolsFromSource(toolsTsContent: string): number {
  return (toolsTsContent.match(/name: "bollard_/g) ?? []).length
}

export function checkMcpToolCount(readme: string, actualCount: number): DocsCheckResult {
  const claimMatch = readme.match(MCP_SERVER_CLAIM)
  if (!claimMatch) {
    return {
      id: "mcp-tool-count",
      label: "README MCP tool count matches source",
      passed: false,
      expected: String(actualCount),
      actual: "claim not found",
    }
  }

  const claimed = Number.parseInt(claimMatch[1] ?? "", 10)
  const passed = claimed === actualCount
  return {
    id: "mcp-tool-count",
    label: "README MCP tool count matches source",
    passed,
    ...(passed
      ? {}
      : {
          expected: String(actualCount),
          actual: String(claimed),
        }),
  }
}

export function checkSpecDocLinks(readme: string, specFilenames: string[]): DocsCheckResult {
  const missing = specFilenames.filter((name) => !readme.includes(name))
  const passed = missing.length === 0
  return {
    id: "spec-doc-links",
    label: "README links all spec/NN-*.md documents",
    passed,
    ...(passed
      ? {}
      : {
          expected: `${specFilenames.length} linked`,
          actual: `missing: ${missing.join(", ")}`,
        }),
  }
}

export function checkAdrLinks(readme: string, adrFilenames: string[]): DocsCheckResult {
  const missing = adrFilenames.filter((name) => !readme.includes(name))
  const passed = missing.length === 0
  return {
    id: "adr-links",
    label: "README links all spec/adr/NNNN-*.md documents",
    passed,
    ...(passed
      ? {}
      : {
          expected: `${adrFilenames.length} linked`,
          actual: `missing: ${missing.join(", ")}`,
        }),
  }
}

function parseReadmeMainCounts(readme: string): { passed: number; skipped: number } | undefined {
  const match = readme.match(README_MAIN_COUNTS)
  if (!match) return undefined
  return {
    passed: Number.parseInt(match[1] ?? "", 10),
    skipped: Number.parseInt(match[2] ?? "", 10),
  }
}

function parseClaudeMainCounts(claude: string): { passed: number; skipped: number } | undefined {
  const match = claude.match(CLAUDE_LATEST_COUNT)
  if (!match) return undefined
  return {
    passed: Number.parseInt(match[1] ?? "", 10),
    skipped: Number.parseInt(match[2] ?? "", 10),
  }
}

function parseReadmeAdversarialCount(readme: string): number | undefined {
  const match = readme.match(README_ADVERSARIAL)
  if (!match) return undefined
  return Number.parseInt(match[1] ?? "", 10)
}

function parseClaudeAdversarialCount(claude: string): number | undefined {
  const latestCountIdx = claude.indexOf("**Latest count")
  const searchRegion =
    latestCountIdx >= 0 ? claude.slice(latestCountIdx, latestCountIdx + 400) : claude
  const match = searchRegion.match(CLAUDE_ADVERSARIAL)
  if (!match) return undefined
  return Number.parseInt(match[1] ?? "", 10)
}

export function checkTestCountConsistency(readme: string, claude: string): DocsCheckResult {
  const readmeMain = parseReadmeMainCounts(readme)
  const claudeMain = parseClaudeMainCounts(claude)
  const readmeAdv = parseReadmeAdversarialCount(readme)
  const claudeAdv = parseClaudeAdversarialCount(claude)

  if (readmeMain === undefined) {
    return {
      id: "test-count-consistency",
      label: "README and CLAUDE.md test counts match",
      passed: false,
      actual: "claim not found (README main counts)",
    }
  }
  if (claudeMain === undefined) {
    return {
      id: "test-count-consistency",
      label: "README and CLAUDE.md test counts match",
      passed: false,
      actual: "claim not found (CLAUDE.md Latest count)",
    }
  }
  if (readmeAdv === undefined) {
    return {
      id: "test-count-consistency",
      label: "README and CLAUDE.md test counts match",
      passed: false,
      actual: "claim not found (README adversarial count)",
    }
  }
  if (claudeAdv === undefined) {
    return {
      id: "test-count-consistency",
      label: "README and CLAUDE.md test counts match",
      passed: false,
      actual: "claim not found (CLAUDE.md adversarial count)",
    }
  }

  const mainMatch =
    readmeMain.passed === claudeMain.passed && readmeMain.skipped === claudeMain.skipped
  const advMatch = readmeAdv === claudeAdv
  const passed = mainMatch && advMatch

  if (passed) {
    return {
      id: "test-count-consistency",
      label: "README and CLAUDE.md test counts match",
      passed: true,
    }
  }

  const parts: string[] = []
  if (!mainMatch) {
    parts.push(
      `main README ${readmeMain.passed}/${readmeMain.skipped} vs CLAUDE ${claudeMain.passed}/${claudeMain.skipped}`,
    )
  }
  if (!advMatch) {
    parts.push(`adversarial README ${readmeAdv} vs CLAUDE ${claudeAdv}`)
  }

  return {
    id: "test-count-consistency",
    label: "README and CLAUDE.md test counts match",
    passed: false,
    expected: `README: ${readmeMain.passed}/${readmeMain.skipped}, adversarial ${readmeAdv}`,
    actual: parts.join("; "),
  }
}

async function resolveMcpToolCount(
  workDir: string,
  options?: { toolCount?: number },
): Promise<{ count: number } | { error: string }> {
  if (options?.toolCount !== undefined) {
    return { count: options.toolCount }
  }

  const toolsPath = join(workDir, MCP_TOOLS_SOURCE_REL)
  try {
    const content = await readFile(toolsPath, "utf-8")
    return { count: countMcpToolsFromSource(content) }
  } catch {
    return { error: `${MCP_TOOLS_SOURCE_REL} not found` }
  }
}

async function listMatchingFiles(dir: string, pattern: RegExp): Promise<string[]> {
  const entries = await readdir(dir)
  return entries.filter((name) => pattern.test(name)).sort()
}

export async function auditDocs(
  workDir: string,
  options?: { toolCount?: number },
): Promise<AuditDocsResult> {
  const readmePath = join(workDir, "README.md")
  const claudePath = join(workDir, "CLAUDE.md")
  const readme = await readFile(readmePath, "utf-8")
  const claude = await readFile(claudePath, "utf-8")

  const toolCountResult = await resolveMcpToolCount(workDir, options)
  const mcpCheck: DocsCheckResult =
    "error" in toolCountResult
      ? {
          id: "mcp-tool-count",
          label: "README MCP tool count matches source",
          passed: false,
          actual: toolCountResult.error,
        }
      : checkMcpToolCount(readme, toolCountResult.count)

  const specFilenames = await listMatchingFiles(join(workDir, "spec"), SPEC_DOC_PATTERN)
  const adrFilenames = await listMatchingFiles(join(workDir, "spec/adr"), ADR_DOC_PATTERN)

  const checks: DocsCheckResult[] = [
    mcpCheck,
    checkSpecDocLinks(readme, specFilenames),
    checkAdrLinks(readme, adrFilenames),
    checkTestCountConsistency(readme, claude),
  ]

  return {
    allPassed: checks.every((c) => c.passed),
    checks,
  }
}

export function formatAuditDocsResult(result: AuditDocsResult): string {
  const lines: string[] = []

  for (const check of result.checks) {
    const icon = check.passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`
    let detail = ""
    if (!check.passed) {
      const parts: string[] = []
      if (check.expected !== undefined) parts.push(`expected: ${check.expected}`)
      if (check.actual !== undefined) parts.push(`actual: ${check.actual}`)
      if (parts.length > 0) detail = ` ${DIM}(${parts.join(", ")})${RESET}`
    }
    lines.push(`  ${icon} ${BOLD}${check.label}${RESET}${detail}`)
  }

  return lines.join("\n").trimEnd()
}
