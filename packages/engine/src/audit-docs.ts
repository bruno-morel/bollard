import { access, readdir, readFile } from "node:fs/promises"
import { dirname, join, normalize, relative, resolve } from "node:path"
import type { DocClassification } from "./docs-resolver.js"
import { DEFAULT_DOC_HOMES, isDocAtHome, resolveCuratableDocs } from "./docs-resolver.js"

export type DocsCheckId =
  | "mcp-tool-count"
  | "spec-doc-links"
  | "adr-links"
  | "test-count-consistency"
  | "link-integrity"
  | "link-orphans"
  | "doc-placement"

export interface DocsCheckResult {
  id: DocsCheckId
  label: string
  passed: boolean
  expected?: string
  actual?: string
  /** When true, excluded from allPassed (informational / advisory). */
  advisory?: boolean
}

export interface AuditDocsResult {
  allPassed: boolean
  checks: DocsCheckResult[]
}

export interface AuditDocsOptions {
  toolCount?: number
  docHomes?: string[]
}

const MCP_TOOLS_SOURCE_REL = "packages/mcp/src/tools.ts"
const SPEC_DOC_PATTERN = /^\d{2}-.*\.md$/
const ADR_DOC_PATTERN = /^\d{4}-.*\.md$/
const MCP_SERVER_CLAIM = /MCP server:\*?\*?\s*(\d+)\s+tools/i
const README_MAIN_COUNTS = /(\d+)\s+passed\s+\/\s+(\d+)\s+skipped/i
const README_ADVERSARIAL = /Adversarial suite:?\*?\*?\s*(\d+)\s+passed/i
const CLAUDE_LATEST_COUNT = /\*\*Latest count[^`]*`(\d+)`\s+passed,\s*`(\d+)`\s+skipped/i
const CLAUDE_ADVERSARIAL = /Adversarial suite\s*`(\d+)`\s+passed/i
const MARKDOWN_LINK_PATTERN = /\[([^\]]*)\]\(([^)]+)\)/g
const ROOT_ENTRY_POINTS = ["README.md", "CLAUDE.md", "CONTRIBUTING.md"] as const

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

export function extractRelativeMarkdownLinks(content: string): string[] {
  const targets: string[] = []
  const pattern = new RegExp(MARKDOWN_LINK_PATTERN.source, "g")

  for (const match of content.matchAll(pattern)) {
    const raw = (match[2] ?? "").trim()
    if (raw.length === 0) {
      continue
    }
    if (raw.startsWith("#")) {
      continue
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      continue
    }
    const withoutAnchor = raw.split("#")[0] ?? raw
    if (withoutAnchor.length === 0) {
      continue
    }
    targets.push(withoutAnchor)
  }

  return targets
}

export function resolveRelativeLink(
  fromRelPath: string,
  target: string,
  workDir: string,
): { resolvedRel: string; absPath: string } {
  const fromDir = dirname(fromRelPath)
  const joined = fromDir === "." ? target : join(fromDir, target)
  const absPath = normalize(resolve(workDir, joined))
  const resolvedRel = relative(workDir, absPath).split("\\").join("/")
  return { resolvedRel, absPath }
}

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await access(absPath)
    return true
  } catch {
    return false
  }
}

export interface LinkIntegrityFinding {
  from: string
  target: string
}

export function findLinkOrphans(opts: {
  classifications: DocClassification[]
  docContents: Map<string, string>
  workDir: string
}): string[] {
  const { classifications, docContents, workDir } = opts
  const eligibleMd = new Set(
    classifications.filter((c) => c.eligible && c.path.endsWith(".md")).map((c) => c.path),
  )

  const reached = new Set<string>()
  const queue: string[] = []

  for (const root of ROOT_ENTRY_POINTS) {
    if (eligibleMd.has(root)) {
      queue.push(root)
      reached.add(root)
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) {
      break
    }
    const content = docContents.get(current)
    if (content === undefined) {
      continue
    }
    for (const target of extractRelativeMarkdownLinks(content)) {
      const { resolvedRel } = resolveRelativeLink(current, target, workDir)
      if (!resolvedRel.endsWith(".md") || !eligibleMd.has(resolvedRel)) {
        continue
      }
      if (!reached.has(resolvedRel)) {
        reached.add(resolvedRel)
        queue.push(resolvedRel)
      }
    }
  }

  return [...eligibleMd].filter((path) => !reached.has(path)).sort()
}

export async function findDanglingLinks(opts: {
  classifications: DocClassification[]
  docContents: Map<string, string>
  workDir: string
}): Promise<LinkIntegrityFinding[]> {
  const { classifications, docContents, workDir } = opts
  const dangling: LinkIntegrityFinding[] = []

  for (const doc of classifications) {
    if (!doc.eligible) {
      continue
    }
    const content = docContents.get(doc.path)
    if (content === undefined) {
      continue
    }
    for (const target of extractRelativeMarkdownLinks(content)) {
      const { absPath } = resolveRelativeLink(doc.path, target, workDir)
      if (!(await pathExists(absPath))) {
        dangling.push({ from: doc.path, target })
      }
    }
  }

  return dangling
}

export function checkLinkIntegrity(dangling: LinkIntegrityFinding[]): DocsCheckResult {
  const passed = dangling.length === 0
  return {
    id: "link-integrity",
    label: "Eligible doc relative links resolve on disk",
    passed,
    ...(passed
      ? {}
      : {
          actual: dangling.map((d) => `${d.from}: ${d.target}`).join("; "),
        }),
  }
}

export function checkLinkOrphans(orphans: string[]): DocsCheckResult {
  return {
    id: "link-orphans",
    label: "Eligible docs unreachable from root entry points (advisory)",
    passed: true,
    advisory: true,
    ...(orphans.length > 0 ? { actual: orphans.join(", ") } : {}),
  }
}

export function checkDocPlacement(
  classifications: DocClassification[],
  homes: readonly string[] = DEFAULT_DOC_HOMES,
): DocsCheckResult {
  const offenders = classifications
    .filter((c) => c.eligible && !isDocAtHome(c.path, homes))
    .map((c) => c.path)
    .sort()

  return {
    id: "doc-placement",
    label: "Eligible docs outside docs.homes (advisory)",
    passed: true,
    advisory: true,
    ...(offenders.length > 0 ? { actual: offenders.join(", ") } : {}),
  }
}

async function resolveMcpToolCount(
  workDir: string,
  options?: AuditDocsOptions,
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

export async function listSpecDocFilenames(workDir: string): Promise<string[]> {
  return listMatchingFiles(join(workDir, "spec"), SPEC_DOC_PATTERN)
}

export async function listAdrDocFilenames(workDir: string): Promise<string[]> {
  return listMatchingFiles(join(workDir, "spec/adr"), ADR_DOC_PATTERN)
}

function computeAllPassed(checks: DocsCheckResult[]): boolean {
  return checks.filter((c) => !c.advisory).every((c) => c.passed)
}

export async function auditDocs(
  workDir: string,
  options?: AuditDocsOptions,
): Promise<AuditDocsResult> {
  const readmePath = join(workDir, "README.md")
  const claudePath = join(workDir, "CLAUDE.md")
  const readme = await readFile(readmePath, "utf-8")
  const claude = await readFile(claudePath, "utf-8")

  const docHomes = options?.docHomes ?? [...DEFAULT_DOC_HOMES]

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

  const specFilenames = await listSpecDocFilenames(workDir)
  const adrFilenames = await listAdrDocFilenames(workDir)

  const classifications = await resolveCuratableDocs(workDir, { homes: docHomes })
  const docContents = new Map<string, string>()
  for (const doc of classifications) {
    if (!doc.eligible) {
      continue
    }
    try {
      docContents.set(doc.path, await readFile(join(workDir, doc.path), "utf-8"))
    } catch {
      // unreadable eligible doc — dangling-link pass will surface missing targets if linked
    }
  }

  const dangling = await findDanglingLinks({ classifications, docContents, workDir })
  const orphans = findLinkOrphans({ classifications, docContents, workDir })

  const checks: DocsCheckResult[] = [
    mcpCheck,
    checkSpecDocLinks(readme, specFilenames),
    checkAdrLinks(readme, adrFilenames),
    checkTestCountConsistency(readme, claude),
    checkLinkIntegrity(dangling),
    checkLinkOrphans(orphans),
    checkDocPlacement(classifications, docHomes),
  ]

  return {
    allPassed: computeAllPassed(checks),
    checks,
  }
}
