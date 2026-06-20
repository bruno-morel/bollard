import { readdir, readFile } from "node:fs/promises"
import { basename, join } from "node:path"

export type DocTier = "curate" | "detect-only" | "never-touch"

export interface DocFrontMatter {
  curate?: boolean
  tier?: DocTier
}

export interface DocClassification {
  path: string
  eligible: boolean
  tier: DocTier
  reason: string
}

export const DEFAULT_DOC_HOMES = ["docs", "spec"] as const

const EXCLUSION_ZONES = [
  "node_modules",
  ".git",
  "dist",
  ".bollard",
  ".cursor",
  "plugin",
  "spec/archive",
  "spec/prompts",
  "packages/agents/prompts",
  "packages/verify/tests/fixtures",
] as const

const DENYLIST_BASENAMES = [
  (name: string) => name.endsWith("-results.md"),
  (name: string) => name.endsWith("-validation-results.md"),
  (name: string) => name.startsWith("self-test-") && name.endsWith(".md"),
] as const

const DETECT_ONLY_PATTERNS = [
  /^spec\/0\d-.*\.md$/,
  /^spec\/adr\/.*\.md$/,
  /^spec\/ROADMAP\.md$/,
] as const

function normalizeRelPath(relPath: string): string {
  return relPath.split("\\").join("/")
}

function isExcludedZone(relPath: string): boolean {
  const normalized = normalizeRelPath(relPath)
  for (const zone of EXCLUSION_ZONES) {
    if (normalized === zone || normalized.startsWith(`${zone}/`)) {
      return true
    }
    const segments = normalized.split("/")
    if (segments.includes(zone)) {
      return true
    }
  }
  return false
}

function isDenylistedBasename(name: string): boolean {
  return DENYLIST_BASENAMES.some((match) => match(name))
}

function defaultTierForPath(relPath: string): DocTier {
  const normalized = normalizeRelPath(relPath)
  for (const pattern of DETECT_ONLY_PATTERNS) {
    if (pattern.test(normalized)) {
      return "detect-only"
    }
  }
  return "curate"
}

export function parseDocFrontMatter(content: string): DocFrontMatter | undefined {
  if (!content.startsWith("---")) {
    return undefined
  }

  const endIdx = content.indexOf("\n---", 3)
  if (endIdx === -1) {
    return undefined
  }

  const block = content.slice(4, endIdx)
  if (block.trim().length === 0) {
    return undefined
  }

  const result: DocFrontMatter = {}

  for (const line of block.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue
    }

    const colonIdx = trimmed.indexOf(":")
    if (colonIdx === -1) {
      continue
    }

    const key = trimmed.slice(0, colonIdx).trim()
    let value = trimmed.slice(colonIdx + 1).trim()

    if (key !== "curate" && key !== "tier") {
      continue
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    if (key === "curate") {
      if (value === "true") {
        result.curate = true
      } else if (value === "false") {
        result.curate = false
      }
    } else if (key === "tier") {
      if (value === "curate" || value === "detect-only" || value === "never-touch") {
        result.tier = value
      }
    }
  }

  return Object.keys(result).length > 0 ? result : undefined
}

export function classifyDocPath(
  relPath: string,
  opts?: { frontMatter?: DocFrontMatter },
): DocClassification {
  const path = normalizeRelPath(relPath)

  if (isExcludedZone(path)) {
    return {
      path,
      eligible: false,
      tier: "never-touch",
      reason: "exclusion zone",
    }
  }

  const base = basename(path)
  if (isDenylistedBasename(base)) {
    return {
      path,
      eligible: false,
      tier: "never-touch",
      reason: "content-class denylist",
    }
  }

  const frontMatter = opts?.frontMatter
  if (frontMatter?.curate === false) {
    return {
      path,
      eligible: false,
      tier: "never-touch",
      reason: "front-matter curate: false",
    }
  }

  const tier = frontMatter?.tier ?? defaultTierForPath(path)
  const reason =
    frontMatter?.tier !== undefined
      ? `front-matter tier: ${frontMatter.tier}`
      : tier === "detect-only"
        ? "path-tier default"
        : "path-tier default"

  return {
    path,
    eligible: true,
    tier,
    reason,
  }
}

export function isDocAtHome(
  relPath: string,
  homes: readonly string[] = DEFAULT_DOC_HOMES,
): boolean {
  const path = normalizeRelPath(relPath)
  if (!path.includes("/")) {
    return true
  }
  for (const home of homes) {
    const normalizedHome = normalizeRelPath(home)
    if (path === normalizedHome || path.startsWith(`${normalizedHome}/`)) {
      return true
    }
  }
  return false
}

async function globMarkdownFiles(workDir: string): Promise<string[]> {
  const files: string[] = []

  try {
    const entries = await readdir(workDir, { recursive: true })
    for (const entry of entries as string[]) {
      if (!entry.endsWith(".md")) {
        continue
      }
      files.push(normalizeRelPath(entry))
    }
  } catch {
    return files
  }

  return files.sort()
}

export async function resolveCuratableDocs(
  workDir: string,
  _opts?: { homes?: string[] },
): Promise<DocClassification[]> {
  void _opts
  const mdPaths = await globMarkdownFiles(workDir)
  const classifications: DocClassification[] = []

  for (const relPath of mdPaths) {
    let frontMatter: DocFrontMatter | undefined
    try {
      const content = await readFile(join(workDir, relPath), "utf-8")
      frontMatter = parseDocFrontMatter(content)
    } catch {
      frontMatter = undefined
    }
    classifications.push(
      classifyDocPath(relPath, frontMatter !== undefined ? { frontMatter } : undefined),
    )
  }

  return classifications
}

export async function resolveCurateScope(
  workDir: string,
  opts?: { homes?: string[] },
): Promise<{ editable: string[]; detectOnly: string[] }> {
  const classifications = await resolveCuratableDocs(workDir, opts)
  const editable: string[] = []
  const detectOnly: string[] = []

  for (const c of classifications) {
    if (!c.eligible) {
      continue
    }
    if (c.tier === "curate") {
      editable.push(c.path)
    } else if (c.tier === "detect-only") {
      detectOnly.push(c.path)
    }
  }

  return { editable, detectOnly }
}
