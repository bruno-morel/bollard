import { readFile } from "node:fs/promises"
import { relative, resolve } from "node:path"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import ts from "typescript"
import {
  readWorkspacePackageRoots,
  resolveSpecifierToFile,
  resolveWorkspaceSpecifier,
} from "./workspace-resolver.js"

export const MAX_PRELOAD_FILES = 10
export const MAX_PRELOAD_CHARS_PER_FILE = 10_000

const MAX_IMPORT_DEPTH = 3

export interface ExpandedFiles {
  files: string[]
  fanInScores: Record<string, number>
  source: "import-graph" | "passthrough"
}

function shouldSkipRel(rel: string, profile: ToolchainProfile): boolean {
  const n = rel.replace(/\\/g, "/")
  if (n.includes("node_modules")) return true
  if (n.includes("/dist/") || n === "dist" || n.startsWith("dist/")) return true
  if (n.includes("/.bollard/") || n.startsWith(".bollard/")) return true
  for (const ig of profile.ignorePatterns) {
    if (ig && (n === ig || n.includes(ig))) return true
  }
  return false
}

function relFromWork(workDir: string, abs: string): string {
  const r = relative(workDir, abs)
  if (r.startsWith("..")) return abs
  return r.replace(/\\/g, "/")
}

function normPath(p: string): string {
  return p.replace(/\\/g, "/")
}

async function resolveImportTarget(
  currentAbs: string,
  spec: string,
  idToRoot: Map<string, string>,
): Promise<string | undefined> {
  const trimmed = spec.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith(".") || trimmed.startsWith("/")) {
    return resolveSpecifierToFile(currentAbs, trimmed)
  }
  return resolveWorkspaceSpecifier(trimmed, idToRoot)
}

export async function expandAffectedFiles(
  workDir: string,
  affectedModify: string[],
  profile: ToolchainProfile,
  maxFiles: number,
  warn?: (msg: string, data?: Record<string, unknown>) => void,
): Promise<ExpandedFiles> {
  if (profile.language !== "typescript") {
    return {
      files: affectedModify.slice(0, maxFiles),
      fanInScores: {},
      source: "passthrough",
    }
  }

  try {
    const idToRoot = await readWorkspacePackageRoots(workDir)
    const seeds: string[] = []
    for (const p of affectedModify) {
      const abs = resolve(workDir, p)
      try {
        await readFile(abs, "utf-8")
        seeds.push(abs)
      } catch {
        /* skip missing seed for graph only */
      }
    }

    /** Min import hops from any seed; only follow imports out of nodes with hop < MAX_IMPORT_DEPTH. */
    const reachableHop = new Map<string, number>()
    const queue: string[] = []
    for (const s of seeds) {
      if (!reachableHop.has(s)) {
        reachableHop.set(s, 0)
        queue.push(s)
      }
    }

    while (queue.length > 0) {
      const abs = queue.shift()
      if (!abs) continue
      const hop = reachableHop.get(abs) ?? 0
      let text: string
      try {
        text = await readFile(abs, "utf-8")
      } catch {
        continue
      }
      if (hop >= MAX_IMPORT_DEPTH) continue

      const pre = ts.preProcessFile(text, true, false)
      for (const ref of pre.importedFiles) {
        const spec = ref.fileName
        const target = await resolveImportTarget(abs, spec, idToRoot)
        if (!target) continue
        const rel = relFromWork(workDir, target)
        if (shouldSkipRel(rel, profile)) continue
        const newHop = hop + 1
        if (newHop > MAX_IMPORT_DEPTH) continue

        const prev = reachableHop.get(target)
        if (prev === undefined || newHop < prev) {
          reachableHop.set(target, newHop)
          if (newHop < MAX_IMPORT_DEPTH) {
            queue.push(target)
          }
        }
      }
    }

    const seedSet = new Set(seeds)
    const fanIn = new Map<string, number>()
    const fanInScores: Record<string, number> = {}

    for (const abs of reachableHop.keys()) {
      let text: string
      try {
        text = await readFile(abs, "utf-8")
      } catch {
        continue
      }
      const pre = ts.preProcessFile(text, true, false)
      for (const ref of pre.importedFiles) {
        const target = await resolveImportTarget(abs, ref.fileName, idToRoot)
        if (!target || !reachableHop.has(target)) continue
        if (seedSet.has(target)) continue
        fanIn.set(target, (fanIn.get(target) ?? 0) + 1)
      }
    }

    for (const [k, v] of fanIn) {
      fanInScores[relFromWork(workDir, k)] = v
    }

    const modifyFirst: string[] = []
    const seenOut = new Set<string>()
    for (const p of affectedModify) {
      const key = normPath(p)
      if (seenOut.has(key)) continue
      seenOut.add(key)
      modifyFirst.push(p)
      if (modifyFirst.length >= maxFiles) {
        return {
          files: modifyFirst,
          fanInScores: Object.fromEntries(
            Object.entries(fanInScores).filter(([f]) => modifyFirst.includes(f)),
          ),
          source: "import-graph",
        }
      }
    }

    const extras: { abs: string; rel: string; score: number; hop: number }[] = []
    for (const [abs, hop] of reachableHop) {
      const rel = relFromWork(workDir, abs)
      if (seenOut.has(normPath(rel))) continue
      if (shouldSkipRel(rel, profile)) continue
      extras.push({
        abs,
        rel,
        score: fanIn.get(abs) ?? 0,
        hop,
      })
    }
    extras.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.hop - b.hop
    })

    const files = [...modifyFirst]
    for (const e of extras) {
      if (files.length >= maxFiles) break
      files.push(e.rel)
    }

    return {
      files,
      fanInScores: Object.fromEntries(
        Object.entries(fanInScores).filter(([f]) => files.includes(f)),
      ),
      source: "import-graph",
    }
  } catch (err) {
    warn?.("expandAffectedFiles: falling back to passthrough", {
      error: err instanceof Error ? err.message : String(err),
    })
    return {
      files: affectedModify.slice(0, maxFiles),
      fanInScores: {},
      source: "passthrough",
    }
  }
}
