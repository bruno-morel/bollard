import { execFile } from "node:child_process"
import { access, readFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import type { AuditDocsResult } from "./audit-docs.js"
import { extractRelativeMarkdownLinks, resolveRelativeLink } from "./audit-docs.js"

export interface DriftCandidate {
  path: string
  reasons: string[]
}

export type GitLastCommitTimeFn = (workDir: string, relPath: string) => Promise<number | null>

const PACKAGE_README_PATTERN = /^packages\/([^/]+)\/README\.md$/
const LINK_INTEGRITY_ENTRY = /^([^:]+):\s/

const execFileAsync = promisify(execFile)

/** Uncommitted/untracked docs get MAX so they are never flagged stale vs code. */
export function effectiveDocCommitTime(raw: number | null): number {
  return raw ?? Number.MAX_SAFE_INTEGER
}

export function formatCommitDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10)
}

export function isDocStaleVsRefs(docTime: number, refTimes: number[]): boolean {
  return refTimes.some((t) => t > docTime)
}

export function parseLinkIntegrityOwners(actual: string): string[] {
  const owners = new Set<string>()
  for (const part of actual.split(";")) {
    const trimmed = part.trim()
    const match = trimmed.match(LINK_INTEGRITY_ENTRY)
    if (match?.[1] !== undefined) {
      owners.add(match[1].trim())
    }
  }
  return [...owners]
}

/** Content-drift audit signals only — excludes doc-placement and link-orphans. */
export function collectAuditImplicatedDocs(auditResult: AuditDocsResult): Map<string, string[]> {
  const implicated = new Map<string, string[]>()

  const add = (docPath: string, reason: string): void => {
    const existing = implicated.get(docPath) ?? []
    if (!existing.includes(reason)) {
      existing.push(reason)
    }
    implicated.set(docPath, existing)
  }

  for (const check of auditResult.checks) {
    if (check.passed) {
      continue
    }
    switch (check.id) {
      case "mcp-tool-count":
      case "spec-doc-links":
      case "adr-links":
        add("README.md", `audit: ${check.id}`)
        break
      case "test-count-consistency":
        add("README.md", `audit: ${check.id}`)
        add("CLAUDE.md", `audit: ${check.id}`)
        break
      case "link-integrity":
        if (check.actual !== undefined) {
          for (const owner of parseLinkIntegrityOwners(check.actual)) {
            add(owner, "audit: link-integrity (dangling link)")
          }
        }
        break
      default:
        break
    }
  }

  return implicated
}

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await access(absPath)
    return true
  } catch {
    return false
  }
}

export async function extractCodeReferences(
  docPath: string,
  content: string,
  workDir: string,
): Promise<string[]> {
  const refs = new Set<string>()

  for (const target of extractRelativeMarkdownLinks(content)) {
    const { resolvedRel, absPath } = resolveRelativeLink(docPath, target, workDir)
    if (resolvedRel.endsWith(".md")) {
      continue
    }
    if (await pathExists(absPath)) {
      refs.add(resolvedRel)
    }
  }

  const pkgMatch = docPath.match(PACKAGE_README_PATTERN)
  if (pkgMatch?.[1] !== undefined) {
    const srcRel = `packages/${pkgMatch[1]}/src`
    if (await pathExists(join(workDir, srcRel))) {
      refs.add(srcRel)
    }
  }

  return [...refs]
}

export async function defaultGetLastCommitTime(
  workDir: string,
  relPath: string,
): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("git", ["log", "-1", "--format=%ct", "--", relPath], {
      cwd: workDir,
      timeout: 10_000,
    })
    const trimmed = stdout.trim()
    if (trimmed.length === 0) {
      return null
    }
    const parsed = Number.parseInt(trimmed, 10)
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function buildStaleReason(refPath: string, refTime: number, docTime: number): string {
  return `code newer than doc: ${refPath} (code ${formatCommitDate(refTime)}, doc ${formatCommitDate(docTime)})`
}

export async function selectDriftCandidates(
  workDir: string,
  editable: string[],
  opts?: {
    auditResult?: AuditDocsResult
    all?: boolean
    getLastCommitTime?: GitLastCommitTimeFn
    readFileFn?: (absPath: string) => Promise<string>
  },
): Promise<DriftCandidate[]> {
  if (opts?.all === true) {
    return editable.map((path) => ({ path, reasons: ["--all"] }))
  }

  const getTime = opts?.getLastCommitTime ?? defaultGetLastCommitTime
  const readDoc = opts?.readFileFn ?? ((absPath: string) => readFile(absPath, "utf-8"))
  const editableSet = new Set(editable)
  const candidateMap = new Map<string, string[]>()
  const timeCache = new Map<string, number | null>()

  const getTimeCached = async (relPath: string): Promise<number | null> => {
    if (!timeCache.has(relPath)) {
      timeCache.set(relPath, await getTime(workDir, relPath))
    }
    return timeCache.get(relPath) ?? null
  }

  const mergeReasons = (path: string, reasons: string[]): void => {
    if (!editableSet.has(path)) {
      return
    }
    const existing = candidateMap.get(path) ?? []
    for (const r of reasons) {
      if (!existing.includes(r)) {
        existing.push(r)
      }
    }
    candidateMap.set(path, existing)
  }

  if (opts?.auditResult !== undefined) {
    for (const [path, reasons] of collectAuditImplicatedDocs(opts.auditResult)) {
      mergeReasons(path, reasons)
    }
  }

  for (const docPath of editable) {
    let content: string
    try {
      content = await readDoc(join(workDir, docPath))
    } catch {
      continue
    }

    const refs = await extractCodeReferences(docPath, content, workDir)
    if (refs.length === 0) {
      continue
    }

    const rawDocTime = await getTimeCached(docPath)
    const docTime = effectiveDocCommitTime(rawDocTime)

    let newestRef: { path: string; time: number } | undefined
    for (const refPath of refs) {
      const refTime = await getTimeCached(refPath)
      if (refTime === null) {
        continue
      }
      if (newestRef === undefined || refTime > newestRef.time) {
        newestRef = { path: refPath, time: refTime }
      }
    }

    if (newestRef !== undefined && isDocStaleVsRefs(docTime, [newestRef.time])) {
      mergeReasons(docPath, [buildStaleReason(newestRef.path, newestRef.time, docTime)])
    }
  }

  return [...candidateMap.entries()]
    .map(([path, reasons]) => ({ path, reasons }))
    .sort((a, b) => a.path.localeCompare(b.path))
}
