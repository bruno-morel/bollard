import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { DocsEdit, DocsEditFile } from "@bollard/engine/src/docs-curation.js"

export const DOCS_CURATION_STAGING_DIR = ".bollard/curation/docs"
export const DOCS_CURATION_PLAN_FILE = join(DOCS_CURATION_STAGING_DIR, "plan.json")

export interface StagedDocsPlan {
  edits: DocsEdit[]
  diffs: Partial<Record<DocsEditFile, string>>
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

export async function stageDocsEdits(
  workDir: string,
  edits: DocsEdit[],
  fileContents: Record<DocsEditFile, string>,
): Promise<StagedDocsPlan> {
  const stagingRoot = resolve(workDir, DOCS_CURATION_STAGING_DIR)
  await mkdir(stagingRoot, { recursive: true })

  const diffs: Partial<Record<DocsEditFile, string>> = {}
  for (const file of ["README.md", "CLAUDE.md"] as const) {
    const content = fileContents[file]
    const fileEdits = edits.filter((e) => e.file === file)
    diffs[file] = buildDiffPreview(content, fileEdits)
    await writeFile(join(stagingRoot, `${file}.preview.md`), diffs[file] ?? "", "utf-8")
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

  const byFile = new Map<DocsEditFile, DocsEdit[]>()
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
