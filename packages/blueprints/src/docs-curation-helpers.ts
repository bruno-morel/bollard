import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { DocsEdit, DocsGroundingResult } from "@bollard/engine/src/docs-curation.js"
import type { DriftCandidate } from "@bollard/engine/src/docs-drift-signals.js"

export const DOCS_CURATION_STAGING_DIR = ".bollard/curation/docs"
export const DOCS_CURATION_PLAN_FILE = join(DOCS_CURATION_STAGING_DIR, "plan.json")
export const DOCS_GROUNDING_REPORT_FILE = join(DOCS_CURATION_STAGING_DIR, "grounding-report.json")

export interface DocsGroundingReport {
  runId: string
  timestamp: string
  kept: Array<{ id: string; file: string }>
  dropped: Array<{ id: string; file: string; reason: string; detail?: string }>
  candidates: DriftCandidate[]
}

export function buildDocsGroundingReport(
  runId: string,
  candidates: DriftCandidate[],
  planEdits: DocsEdit[],
  result: DocsGroundingResult,
): DocsGroundingReport {
  const fileById = new Map(planEdits.map((e) => [e.id, e.file]))

  return {
    runId,
    timestamp: new Date().toISOString(),
    kept: result.kept.map((e) => ({ id: e.id, file: e.file })),
    dropped: result.dropped.map((d) => {
      const file =
        fileById.get(d.id) ??
        (d.reason === "file_not_allowed" && d.detail !== undefined ? d.detail : "unknown")
      const entry: DocsGroundingReport["dropped"][number] = {
        id: d.id,
        file,
        reason: d.reason,
      }
      if (d.detail !== undefined && d.reason !== "file_not_allowed") {
        entry.detail = d.detail
      }
      return entry
    }),
    candidates,
  }
}

export async function writeDocsGroundingReport(
  workDir: string,
  report: DocsGroundingReport,
): Promise<void> {
  const stagingRoot = resolve(workDir, DOCS_CURATION_STAGING_DIR)
  await mkdir(stagingRoot, { recursive: true })
  await writeFile(
    resolve(workDir, DOCS_GROUNDING_REPORT_FILE),
    JSON.stringify(report, null, 2),
    "utf-8",
  )
}

export interface StagedDocsPlan {
  edits: DocsEdit[]
  diffs: Partial<Record<string, string>>
}

export function buildDiffPreview(fileContent: string, edits: DocsEdit[]): string {
  const fileEdits = edits.filter((e) => fileContent.includes(e.oldText))
  if (fileEdits.length === 0) {
    return "(no applicable edits for this file)\n"
  }

  const lines: string[] = []
  for (const edit of fileEdits) {
    lines.push(`--- edit ${edit.id} (${edit.file}) ---`)
    lines.push(`Rationale: ${edit.rationale}`)
    lines.push("- old:")
    for (const line of edit.oldText.split("\n")) {
      lines.push(`  ${line}`)
    }
    lines.push("+ new:")
    for (const line of edit.newText.split("\n")) {
      lines.push(`  ${line}`)
    }
    lines.push("")
  }
  return `${lines.join("\n")}\n`
}

export function applyEditsToContent(content: string, edits: DocsEdit[]): string {
  let result = content
  for (const edit of edits) {
    if (result.includes(edit.oldText)) {
      result = result.replace(edit.oldText, edit.newText)
    }
  }
  return result
}

export async function readStagedDocsPlan(workDir: string): Promise<StagedDocsPlan | null> {
  try {
    const raw = await readFile(resolve(workDir, DOCS_CURATION_PLAN_FILE), "utf-8")
    const parsed = JSON.parse(raw) as StagedDocsPlan
    if (!Array.isArray(parsed.edits)) return null
    return parsed
  } catch {
    return null
  }
}

function previewFileName(relPath: string): string {
  return `${relPath.replace(/\//g, "__")}.preview.md`
}

export async function stageDocsEdits(
  workDir: string,
  edits: DocsEdit[],
  fileContents: Record<string, string>,
): Promise<StagedDocsPlan> {
  const stagingRoot = resolve(workDir, DOCS_CURATION_STAGING_DIR)
  await mkdir(stagingRoot, { recursive: true })

  const diffs: Partial<Record<string, string>> = {}
  for (const file of Object.keys(fileContents).sort()) {
    const content = fileContents[file] ?? ""
    const fileEdits = edits.filter((e) => e.file === file)
    diffs[file] = buildDiffPreview(content, fileEdits)
    await writeFile(join(stagingRoot, previewFileName(file)), diffs[file] ?? "", "utf-8")
  }

  const plan: StagedDocsPlan = { edits, diffs }
  await writeFile(resolve(workDir, DOCS_CURATION_PLAN_FILE), JSON.stringify(plan, null, 2), "utf-8")
  return plan
}

export async function applyDocsEdits(
  workDir: string,
  edits: DocsEdit[],
): Promise<{
  applied: DocsEdit[]
  skipped: Array<{ id: string; reason: string }>
}> {
  const applied: DocsEdit[] = []
  const skipped: Array<{ id: string; reason: string }> = []

  const byFile = new Map<string, DocsEdit[]>()
  for (const edit of edits) {
    const list = byFile.get(edit.file) ?? []
    list.push(edit)
    byFile.set(edit.file, list)
  }

  for (const [file, fileEdits] of byFile) {
    const filePath = resolve(workDir, file)
    let content = await readFile(filePath, "utf-8")

    for (const edit of fileEdits) {
      if (!content.includes(edit.oldText)) {
        skipped.push({ id: edit.id, reason: "old_text_no_longer_matches" })
        continue
      }
      content = content.replace(edit.oldText, edit.newText)
      applied.push(edit)
    }

    await writeFile(filePath, content, "utf-8")
  }

  return { applied, skipped }
}
