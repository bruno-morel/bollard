import type { Dirent } from "node:fs"
import { readFile, readdir, stat } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import type { LanguageId, ToolchainProfile } from "@bollard/detect/src/types.js"
import ts from "typescript"
import { TsCompilerExtractor } from "../type-extractor.js"
import type { ContractContext, ContractEdge, ContractGraphProvider, ModuleNode } from "./types.js"
import { filterByPublicSurface } from "./types.js"

async function resolveSpecifierToFile(
  fromFile: string,
  specifier: string,
): Promise<string | undefined> {
  const raw = resolve(dirname(fromFile), specifier)
  const candidates: string[] = [raw]
  if (/\.(js|mjs|cjs)$/i.test(raw)) {
    const base = raw.replace(/\.(js|mjs|cjs)$/i, "")
    candidates.push(`${base}.ts`, `${base}.tsx`, `${base}.d.ts`)
  } else if (!/\.(ts|tsx)$/i.test(raw)) {
    candidates.push(`${raw}.ts`, `${raw}.tsx`)
  }
  for (const p of candidates) {
    try {
      if ((await stat(p)).isFile()) return resolve(p)
    } catch {
      /* try next */
    }
  }
  return undefined
}

function resolvePackageDotExport(pkgRoot: string, exportsField: unknown): string | undefined {
  if (exportsField === undefined || exportsField === null) return undefined
  if (typeof exportsField === "string") {
    return resolve(pkgRoot, exportsField)
  }
  if (typeof exportsField !== "object") return undefined
  const root = (exportsField as Record<string, unknown>)["."]
  if (typeof root === "string") return resolve(pkgRoot, root)
  if (root && typeof root === "object") {
    const o = root as Record<string, string>
    const rel = o["types"] ?? o["import"] ?? o["default"]
    if (typeof rel === "string") return resolve(pkgRoot, rel)
  }
  return undefined
}

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

async function readWorkspacePackageRoots(workDir: string): Promise<Map<string, string>> {
  const idToRoot = new Map<string, string>()
  const wsPath = join(workDir, "pnpm-workspace.yaml")
  let content: string
  try {
    content = await readFile(wsPath, "utf-8")
  } catch {
    return idToRoot
  }
  const lines = content.split("\n")
  let inPkgs = false
  const globs: string[] = []
  for (const line of lines) {
    if (line.trim().startsWith("packages:")) {
      inPkgs = true
      continue
    }
    if (inPkgs) {
      const m = line.match(/^\s*-\s*["']?([^"'\s]+)["']?\s*$/)
      if (m?.[1]) {
        globs.push(m[1])
        continue
      }
      if (line.trim() !== "" && !line.startsWith(" ") && !line.startsWith("\t")) {
        break
      }
    }
  }

  for (const g of globs) {
    const starIdx = g.indexOf("*")
    const baseRel =
      (starIdx >= 0 ? g.slice(0, starIdx).replace(/\/$/, "") : g.replace(/\/$/, "")) || "packages"
    const baseAbs = resolve(workDir, baseRel)
    try {
      const entries = await readdir(baseAbs, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const pkgRoot = resolve(baseAbs, e.name)
        try {
          const pj = JSON.parse(await readFile(join(pkgRoot, "package.json"), "utf-8")) as {
            name?: string
          }
          if (pj.name) idToRoot.set(pj.name, pkgRoot)
        } catch {
          /* skip */
        }
      }
    } catch {
      /* skip */
    }
  }
  return idToRoot
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

/** Map `@scope/pkg/sub/path` → `@scope/pkg` to match `package.json` `name`. */
function workspacePackageIdFromImportSpec(spec: string): string | undefined {
  if (!spec.startsWith("@")) return undefined
  const segments = spec.split("/")
  if (segments.length < 2 || !segments[0]?.startsWith("@")) return undefined
  const uname = segments[1]
  if (!uname) return undefined
  return `${segments[0]}/${uname}`
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
