import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { dirname, extname, join, relative, resolve } from "node:path"
import type { CurationCandidate } from "@bollard/engine/src/test-quality.js"
import { derivePromotionDestPath } from "@bollard/engine/src/test-quality.js"

export const CURATION_STAGING_DIR = ".bollard/curation/tests"
export const CURATION_PLAN_FILE = join(CURATION_STAGING_DIR, "plan.json")

const IMPORT_FROM_RE = /(?:import\s+[\s\S]*?from\s+|}\s+from\s+)(['"])([^'"]+)\1/g

export interface StagedCurationAction {
  id: string
  action: CurationCandidate["action"]
  filePath: string
  destPath?: string
  stagedPath?: string
}

export interface StagedCurationPlan {
  actions: StagedCurationAction[]
}

function toPosixPath(p: string): string {
  return p.split("\\").join("/")
}

function formatRelativeImport(fromDir: string, toTarget: string): string {
  let rel = toPosixPath(relative(fromDir, toTarget))
  if (!rel.startsWith(".")) {
    rel = `./${rel}`
  }
  return rel
}

export function rewriteImportsForPromotion(
  content: string,
  fromPath: string,
  toPath: string,
): string {
  const fromDir = dirname(resolve(fromPath))
  const toDir = dirname(resolve(toPath))

  return content.replace(IMPORT_FROM_RE, (full, _quote: string, specifier: string) => {
    if (!specifier.startsWith(".")) {
      return full
    }
    const target = resolve(fromDir, specifier)
    const newSpecifier = formatRelativeImport(toDir, target)
    return full.replace(specifier, newSpecifier)
  })
}

function isTypeScriptTestFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase()
  return ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts"
}

function stripBollardGeneratedMarkers(content: string): string {
  return content
    .replace(/\/\/\s*@bollard-generated.*\n?/g, "")
    .replace(/#\s*@bollard-generated.*\n?/g, "")
}

export function stagingPathForSource(sourcePath: string): string {
  const normalized = sourcePath.replace(/\\/g, "/")
  return join(CURATION_STAGING_DIR, normalized)
}

export async function readStagedPlan(workDir: string): Promise<StagedCurationPlan | null> {
  try {
    const raw = await readFile(resolve(workDir, CURATION_PLAN_FILE), "utf-8")
    const parsed = JSON.parse(raw) as StagedCurationPlan
    if (!Array.isArray(parsed.actions)) return null
    return parsed
  } catch {
    return null
  }
}

export async function applyStagedCurationChanges(
  workDir: string,
): Promise<{ applied: StagedCurationAction[] }> {
  const plan = await readStagedPlan(workDir)
  if (plan === null || plan.actions.length === 0) {
    return { applied: [] }
  }

  const applied: StagedCurationAction[] = []

  for (const action of plan.actions) {
    if (action.action === "promote") {
      const sourceFull = resolve(workDir, action.stagedPath ?? action.filePath)
      const destRel = action.destPath ?? derivePromotionDestPath(action.filePath)
      const destFull = resolve(workDir, destRel)

      let content = await readFile(sourceFull, "utf-8")
      if (isTypeScriptTestFile(action.filePath)) {
        content = rewriteImportsForPromotion(content, sourceFull, destFull)
      }
      content = stripBollardGeneratedMarkers(content)
      await mkdir(dirname(destFull), { recursive: true })
      await writeFile(destFull, content, "utf-8")
      applied.push(action)
    } else if (action.action === "prune") {
      const target = resolve(workDir, action.filePath)
      try {
        await unlink(target)
      } catch {
        // file may already be gone
      }
      applied.push(action)
    } else if (action.action === "rewrite") {
      // Phase 2: staging marker only — claim ownership without rewriting
      applied.push(action)
    }
  }

  return { applied }
}
