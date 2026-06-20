import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { auditDocs, listAdrDocFilenames, listSpecDocFilenames } from "./audit-docs.js"
import { resolveCurateScope } from "./docs-resolver.js"
import { BollardError } from "./errors.js"

export type DocsEditFile = string

export interface DocsEdit {
  id: string
  file: DocsEditFile
  oldText: string
  newText: string
  rationale: string
  grounding: Array<{ quote: string; source: "claude-md" | "roadmap" | "code" | "audit" }>
}

export interface DocsCurationPlan {
  edits: DocsEdit[]
}

export type DocsGroundingDropReason =
  | "grounding_not_in_corpus"
  | "ungrounded_fact_token"
  | "old_text_not_in_file"
  | "file_not_allowed"

export interface DocsGroundingResult {
  kept: DocsEdit[]
  dropped: Array<{ id: string; reason: DocsGroundingDropReason; detail?: string }>
}

const CLI_INDEX_REL = "packages/cli/src/index.ts"
const COMMAND_PATTERN = /if \(command === "([^"]+)"\)/g

const IDENTIFIER_PATTERN =
  /\b[a-z][a-zA-Z0-9]{3,}(?:\(\))?|\b[A-Z][A-Z0-9_]{3,}\b|\b[A-Z][a-zA-Z0-9]{3,}/g

const STAGE_PHASE_PATTERN = /\b(?:Stage|Phase|Layer)\s+\d+[a-z]?\b/gi

const NUMBER_PATTERN = /\b\d+(?:\.\d+)?%?\b|\bv\d+(?:\.\d+)*\b/g

const PATH_PATTERN = /\b(?:packages|spec|\.bollard)\/[a-zA-Z0-9_./-]+/g

const PACKAGE_PATTERN = /@bollard\/[a-zA-Z0-9_-]+/g

const COMMON_WORDS = new Set([
  "about",
  "after",
  "also",
  "apply",
  "audit",
  "before",
  "bollard",
  "check",
  "code",
  "command",
  "docs",
  "edit",
  "file",
  "from",
  "have",
  "into",
  "just",
  "like",
  "line",
  "make",
  "mode",
  "more",
  "must",
  "name",
  "only",
  "plan",
  "read",
  "readme",
  "roadmap",
  "same",
  "some",
  "spec",
  "stage",
  "test",
  "that",
  "them",
  "then",
  "this",
  "tool",
  "type",
  "used",
  "user",
  "when",
  "with",
  "work",
  "your",
])

export function extractCliCommands(indexContent: string): string[] {
  const commands: string[] = []
  for (const match of indexContent.matchAll(COMMAND_PATTERN)) {
    const cmd = match[1]
    if (cmd !== undefined && cmd.length > 0) {
      commands.push(cmd)
    }
  }
  return [...new Set(commands)].sort()
}

export async function listPackageNames(workDir: string): Promise<string[]> {
  const packagesDir = join(workDir, "packages")
  const entries = await readdir(packagesDir, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort()
}

function buildAuditDocsFactsSection(auditResult: Awaited<ReturnType<typeof auditDocs>>): string {
  const mcpCheck = auditResult.checks.find((c) => c.id === "mcp-tool-count")
  const lines = [
    `auditAllPassed: ${auditResult.allPassed}`,
    `mcpToolCount: ${mcpCheck?.expected ?? "unknown"}`,
  ]
  for (const check of auditResult.checks) {
    if (!check.passed) {
      lines.push(`failingCheck: ${check.id}`)
      if (check.expected !== undefined) {
        lines.push(`${check.id}.expected: ${check.expected}`)
      }
      if (check.actual !== undefined) {
        lines.push(`${check.id}.actual: ${check.actual}`)
      }
    }
  }
  return lines.join("\n")
}

export async function buildDocsCurationCorpus(opts: {
  workDir: string
  docHomes?: string[]
  /** Which editable docs to read into fileContents and append to corpus. Defaults to full editable tier. */
  contentPaths?: string[]
  /** Pre-computed audit result — when omitted, auditDocs runs inside this function. */
  auditResult?: Awaited<ReturnType<typeof auditDocs>>
  /** Pre-resolved scope — skips a second resolveCurateScope pass when provided. */
  scope?: { editable: string[]; detectOnly: string[] }
}): Promise<{
  corpus: string
  fileContents: Record<string, string>
  editable: string[]
  detectOnly: string[]
  allowedFiles: Set<string>
  auditResult: Awaited<ReturnType<typeof auditDocs>>
}> {
  const { workDir, docHomes, contentPaths, auditResult: auditResultIn, scope } = opts
  const scopeOpts = docHomes !== undefined ? { homes: docHomes } : undefined
  const { editable, detectOnly } = scope ?? (await resolveCurateScope(workDir, scopeOpts))

  const pathsToLoad = contentPaths ?? editable

  const fileContents: Record<string, string> = {}
  for (const relPath of pathsToLoad) {
    fileContents[relPath] = await readFile(join(workDir, relPath), "utf-8")
  }

  const claudeContent =
    fileContents["CLAUDE.md"] ?? (await readFile(join(workDir, "CLAUDE.md"), "utf-8"))
  const roadmapContent = await readFile(join(workDir, "spec/ROADMAP.md"), "utf-8")
  const auditResult =
    auditResultIn ??
    (await auditDocs(workDir, {
      ...(docHomes !== undefined ? { docHomes } : {}),
    }))
  const specFilenames = await listSpecDocFilenames(workDir)
  const adrFilenames = await listAdrDocFilenames(workDir)
  const packageNames = await listPackageNames(workDir)

  let cliCommands: string[] = []
  try {
    const indexContent = await readFile(join(workDir, CLI_INDEX_REL), "utf-8")
    cliCommands = extractCliCommands(indexContent)
  } catch {
    cliCommands = []
  }

  const sections = [
    "## CLAUDE.md (canonical state-of-truth)",
    claudeContent,
    "## spec/ROADMAP.md",
    roadmapContent,
    "## audit-docs result",
    JSON.stringify(auditResult, null, 2),
    "## audit-docs facts",
    buildAuditDocsFactsSection(auditResult),
    "## spec/NN-*.md files",
    specFilenames.join("\n"),
    "## spec/adr/NNNN-*.md files",
    adrFilenames.join("\n"),
    "## packages/*",
    packageNames.join("\n"),
    "## CLI commands (from packages/cli/src/index.ts)",
    cliCommands.join("\n"),
  ]

  for (const relPath of pathsToLoad) {
    if (relPath === "CLAUDE.md") {
      continue
    }
    const content = fileContents[relPath]
    if (content !== undefined) {
      sections.push(`## ${relPath}`, content)
    }
  }

  const allowedFiles = new Set(pathsToLoad)

  return {
    corpus: sections.join("\n\n"),
    fileContents,
    editable,
    detectOnly,
    allowedFiles,
    auditResult,
  }
}

export function extractFactTokens(text: string): string[] {
  const raw: string[] = []

  for (const match of text.matchAll(NUMBER_PATTERN)) {
    raw.push(match[0] ?? "")
  }
  for (const match of text.matchAll(PATH_PATTERN)) {
    raw.push(match[0] ?? "")
  }
  for (const match of text.matchAll(PACKAGE_PATTERN)) {
    raw.push(match[0] ?? "")
  }
  for (const match of text.matchAll(IDENTIFIER_PATTERN)) {
    raw.push(match[0] ?? "")
  }
  for (const match of text.matchAll(STAGE_PHASE_PATTERN)) {
    raw.push(match[0] ?? "")
  }

  const seen = new Set<string>()
  const tokens: string[] = []
  for (const token of raw) {
    const trimmed = token.trim()
    if (trimmed.length === 0) continue
    const lower = trimmed.toLowerCase()
    if (COMMON_WORDS.has(lower)) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    tokens.push(trimmed)
  }
  return tokens
}

export function verifyDocsCurationGrounding(
  plan: DocsCurationPlan,
  corpus: string,
  fileContents: Record<string, string>,
  allowedFiles: Set<string>,
): DocsGroundingResult {
  const kept: DocsEdit[] = []
  const dropped: DocsGroundingResult["dropped"] = []

  for (const edit of plan.edits) {
    if (!allowedFiles.has(edit.file)) {
      dropped.push({ id: edit.id, reason: "file_not_allowed", detail: edit.file })
      continue
    }

    const fileContent = fileContents[edit.file]
    if (fileContent === undefined || !fileContent.includes(edit.oldText)) {
      dropped.push({ id: edit.id, reason: "old_text_not_in_file" })
      continue
    }

    const groundingOk =
      edit.grounding.length > 0 && edit.grounding.every((g) => corpus.includes(g.quote))
    if (!groundingOk) {
      dropped.push({ id: edit.id, reason: "grounding_not_in_corpus" })
      continue
    }

    const factTokens = extractFactTokens(edit.newText)
    const ungrounded = factTokens.find((token) => !corpus.includes(token))
    if (ungrounded !== undefined) {
      dropped.push({
        id: edit.id,
        reason: "ungrounded_fact_token",
        detail: ungrounded,
      })
      continue
    }

    kept.push(edit)
  }

  return { kept, dropped }
}

function stripOptionalFences(raw: string): string {
  let result = raw.trim()
  result = result.replace(/^```\w*\n/, "")
  result = result.replace(/\n```\s*$/, "")
  return result.trim()
}

function isValidDocsEdit(value: unknown): value is DocsEdit {
  if (value === null || typeof value !== "object") return false
  const e = value as Record<string, unknown>
  if (typeof e["id"] !== "string") return false
  if (typeof e["file"] !== "string" || e["file"].length === 0) return false
  if (typeof e["oldText"] !== "string") return false
  if (typeof e["newText"] !== "string") return false
  if (typeof e["rationale"] !== "string") return false
  if (!Array.isArray(e["grounding"])) return false
  for (const g of e["grounding"]) {
    if (g === null || typeof g !== "object") return false
    const gr = g as Record<string, unknown>
    if (typeof gr["quote"] !== "string") return false
    const src = gr["source"]
    if (src !== "claude-md" && src !== "roadmap" && src !== "code" && src !== "audit") {
      return false
    }
  }
  return true
}

export function parseDocsCurationPlan(raw: string): DocsCurationPlan {
  const trimmed = stripOptionalFences(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (err: unknown) {
    throw new BollardError({
      code: "CURATION_OUTPUT_INVALID",
      message: `Failed to parse docs curation plan JSON: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new BollardError({
      code: "CURATION_OUTPUT_INVALID",
      message: "Docs curation plan must be a JSON object",
    })
  }
  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj["edits"])) {
    throw new BollardError({
      code: "CURATION_OUTPUT_INVALID",
      message: "Docs curation plan must have an edits array",
    })
  }
  const edits = obj["edits"]
  if (edits.length === 0) {
    return { edits: [] }
  }
  if (!edits.every(isValidDocsEdit)) {
    throw new BollardError({
      code: "CURATION_OUTPUT_INVALID",
      message: "One or more docs edits failed schema validation",
    })
  }
  return { edits: edits as DocsEdit[] }
}
