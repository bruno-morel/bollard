import type { Dirent } from "node:fs"
import { readFile, readdir, stat } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import type { LanguageId, ToolchainProfile } from "@bollard/detect/src/types.js"
import ts from "typescript"
import { TsCompilerExtractor } from "../type-extractor.js"
import {
  readWorkspacePackageRoots,
  resolvePackageDotExport,
  resolveSpecifierToFile,
  workspacePackageIdFromImportSpec,
} from "../workspace-resolver.js"
import type { ContractContext, ContractEdge, ContractGraphProvider, ModuleNode } from "./types.js"
import { filterByPublicSurface } from "./types.js"

/** TS source files reachable from package.json `exports["."]` via static `export … from` (Stage 3a contract surface). */
async function collectPublicExportClosure(entryAbs: string): Promise<Set<string>> {
  const normalizedEntry = resolve(entryAbs)
  const seen = new Set<string>()
  const queue: string[] = [normalizedEntry]

  while (queue.length > 0) {
    const f = queue.pop()
    if (!f || seen.has(f)) continue
    let text: string
    try {
      text = await readFile(f, "utf-8")
    } catch {
      continue
    }
    seen.add(f)
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    for (const stmt of sf.statements) {
      if (
        !ts.isExportDeclaration(stmt) ||
        !stmt.moduleSpecifier ||
        !ts.isStringLiteral(stmt.moduleSpecifier)
      )
        continue
      const next = await resolveSpecifierToFile(f, stmt.moduleSpecifier.text)
      if (next && !seen.has(next)) queue.push(next)
    }
  }
  return seen
}

async function publicSurfaceFilesForPackage(pkgRoot: string): Promise<Set<string> | undefined> {
  let pkgJson: { exports?: unknown }
  try {
    pkgJson = JSON.parse(await readFile(join(pkgRoot, "package.json"), "utf-8")) as {
      exports?: unknown
    }
  } catch {
    return undefined
  }
  const entry = resolvePackageDotExport(pkgRoot, pkgJson.exports)
  if (!entry) return undefined
  try {
    if (!(await stat(entry)).isFile()) return undefined
  } catch {
    return undefined
  }
  return collectPublicExportClosure(entry)
}

function packageForPath(
  absFile: string,
  idToRoot: Map<string, string>,
): { id: string; root: string } | undefined {
  let best: { id: string; root: string; len: number } | undefined
  for (const [id, root] of idToRoot) {
    const rel = relative(root, absFile)
    if (rel && !rel.startsWith("..")) {
      if (!best || root.length > best.len) best = { id, root, len: root.length }
    }
  }
  return best ? { id: best.id, root: best.root } : undefined
}

async function listPackageSourceFiles(pkgRoot: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as Dirent[]
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === "dist") continue
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        await walk(p)
      } else if (
        (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) &&
        !e.name.includes(".test.") &&
        !e.name.includes(".spec.")
      ) {
        out.push(p)
      }
    }
  }
  const src = join(pkgRoot, "src")
  try {
    await walk(src)
  } catch {
    await walk(pkgRoot)
  }
  return out
}

function parseImportSpecs(sourceFile: ts.SourceFile): { spec: string; names: string[] }[] {
  const out: { spec: string; names: string[] }[] = []
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    const mod = stmt.moduleSpecifier
    if (!ts.isStringLiteral(mod)) continue
    const spec = mod.text
    const names: string[] = []
    const cl = stmt.importClause
    if (cl?.name) names.push(cl.name.text)
    if (cl?.namedBindings && ts.isNamedImports(cl.namedBindings)) {
      for (const el of cl.namedBindings.elements) {
        names.push(el.propertyName?.text ?? el.name.text)
      }
    }
    out.push({ spec, names })
  }
  return out
}

export class TypeScriptContractProvider implements ContractGraphProvider {
  readonly language: LanguageId = "typescript"

  async build(
    affectedFiles: string[],
    _profile: ToolchainProfile,
    workDir: string,
    warn?: (msg: string) => void,
  ): Promise<ContractContext> {
    const idToRoot = await readWorkspacePackageRoots(workDir)
    if (idToRoot.size === 0) {
      warn?.(
        "buildContractContext: no workspace packages found (pnpm-workspace.yaml + package.json names)",
      )
      return { modules: [], edges: [], affectedEdges: [] }
    }

    const extractor = new TsCompilerExtractor()
    const modules: ModuleNode[] = []

    for (const [id, root] of idToRoot) {
      const files = await listPackageSourceFiles(root)
      if (files.length === 0) continue
      const surface = await publicSurfaceFilesForPackage(root)
      const merged = await extractor.extract(files, _profile, workDir)
      const signatures = filterByPublicSurface(merged.signatures, surface)
      const types = filterByPublicSurface(merged.types, surface)
      const errorTypes = types.filter((t) => t.name.endsWith("Error")).map((t) => t.name)
      modules.push({
        id,
        language: "typescript",
        rootPath: resolve(root),
        publicExports: signatures,
        errorTypes,
      })
    }

    const modById = new Map(modules.map((m) => [m.id, m]))
    const edgeMap = new Map<string, ContractEdge>()

    for (const [id, root] of idToRoot) {
      const files = await listPackageSourceFiles(root)
      for (const fp of files) {
        let text: string
        try {
          text = await readFile(fp, "utf-8")
        } catch {
          continue
        }
        const sf = ts.createSourceFile(fp, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
        const abs = resolve(fp)
        const consumer = packageForPath(abs, idToRoot)
        if (!consumer || consumer.id !== id) continue

        for (const imp of parseImportSpecs(sf)) {
          if (!imp.spec.startsWith("@bollard/")) continue
          const toId = workspacePackageIdFromImportSpec(imp.spec)
          if (!toId || !idToRoot.has(toId)) continue
          const key = `${consumer.id}->${toId}`
          let edge = edgeMap.get(key)
          if (!edge) {
            const prov = modById.get(toId)
            edge = {
              from: consumer.id,
              to: toId,
              importedSymbols: [],
              providerErrors: [...(prov?.errorTypes ?? [])],
              consumerCatches: [],
            }
            edgeMap.set(key, edge)
          }
          for (const n of imp.names) {
            if (!edge.importedSymbols.includes(n)) edge.importedSymbols.push(n)
          }
        }
      }
    }

    const edges = [...edgeMap.values()]

    const touched = new Set<string>()
    for (const rel of affectedFiles) {
      const abs = resolve(workDir, rel)
      const p = packageForPath(abs, idToRoot)
      if (p) touched.add(p.id)
    }
    const affectedEdges = edges.filter((e) => touched.has(e.from) || touched.has(e.to))

    return { modules, edges, affectedEdges }
  }
}
