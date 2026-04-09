import type { Dirent } from "node:fs"
import { readFile, readdir, stat } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"
import type { LanguageId, ToolchainProfile } from "@bollard/detect/src/types.js"
import ts from "typescript"
import { GoAstExtractor } from "./extractors/go.js"
import { PythonAstExtractor } from "./extractors/python.js"
import type { ExtractedSignature } from "./type-extractor.js"
import { TsCompilerExtractor } from "./type-extractor.js"

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

function filterByPublicSurface<T extends { filePath: string }>(
  items: T[],
  surface: Set<string> | undefined,
): T[] {
  if (!surface) return items
  return items.filter((x) => surface.has(resolve(x.filePath)))
}

export interface ModuleNode {
  id: string
  language: LanguageId
  rootPath: string
  publicExports: ExtractedSignature[]
  errorTypes: string[]
}

export interface ContractEdge {
  from: string
  to: string
  importedSymbols: string[]
  providerErrors: string[]
  /** Best-effort; TS try/catch narrowing is TODO for richer extraction */
  consumerCatches: string[]
}

export interface ContractContext {
  modules: ModuleNode[]
  edges: ContractEdge[]
  affectedEdges: ContractEdge[]
}

export interface ContractGraphProvider {
  readonly language: LanguageId
  build(
    affectedFiles: string[],
    profile: ToolchainProfile,
    workDir: string,
    warn?: (msg: string) => void,
  ): Promise<ContractContext>
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

class TypeScriptContractProvider implements ContractGraphProvider {
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

// ── Python contract graph helpers ──────────────────────────────────────

function parsePyprojectName(content: string): string | undefined {
  const lines = content.split("\n")
  let inTarget = false
  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[(.+)\]\s*$/)
    if (sectionMatch) {
      const section = sectionMatch[1]?.trim()
      inTarget = section === "project" || section === "tool.poetry"
      continue
    }
    if (inTarget) {
      const nameMatch = line.match(/^\s*name\s*=\s*["']([^"']+)["']/)
      if (nameMatch?.[1]) return nameMatch[1]
    }
  }
  return undefined
}

const PYTHON_SKIP_DIRS = new Set([
  "tests",
  "test",
  "__pycache__",
  ".venv",
  "venv",
  "node_modules",
  ".git",
  "dist",
  ".tox",
  ".mypy_cache",
  ".ruff_cache",
])

async function discoverPythonPackages(
  workDir: string,
  warn?: (msg: string) => void,
): Promise<Map<string, string>> {
  const idToRoot = new Map<string, string>()

  async function tryPyproject(dir: string): Promise<void> {
    try {
      const content = await readFile(join(dir, "pyproject.toml"), "utf-8")
      const name = parsePyprojectName(content)
      if (name) idToRoot.set(name, dir)
    } catch {
      /* no pyproject.toml */
    }
  }

  try {
    const topEntries = await readdir(workDir, { withFileTypes: true })
    for (const e of topEntries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue
      const dir = resolve(workDir, e.name)
      await tryPyproject(dir)
      try {
        const subEntries = await readdir(dir, { withFileTypes: true })
        for (const se of subEntries) {
          if (!se.isDirectory() || se.name.startsWith(".")) continue
          await tryPyproject(resolve(dir, se.name))
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }

  if (idToRoot.size > 0) return idToRoot

  let hasRootPyproject = false
  try {
    hasRootPyproject = (await stat(join(workDir, "pyproject.toml"))).isFile()
  } catch {
    /* no root pyproject.toml */
  }

  if (!hasRootPyproject) {
    warn?.("buildContractContext: no Python packages found (no pyproject.toml)")
    return idToRoot
  }

  try {
    const entries = await readdir(workDir, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isDirectory() || PYTHON_SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue
      const dir = resolve(workDir, e.name)
      try {
        if ((await stat(join(dir, "__init__.py"))).isFile()) {
          idToRoot.set(e.name, dir)
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }

  if (idToRoot.size === 0) {
    warn?.("buildContractContext: no Python packages found (no __init__.py directories)")
  }

  return idToRoot
}

async function collectPythonPublicSurface(
  packageRoot: string,
  warn?: (msg: string) => void,
): Promise<Set<string>> {
  const surface = new Set<string>()
  const seen = new Set<string>()

  const dirName = basename(packageRoot)
  const candidates = [
    join(packageRoot, "__init__.py"),
    join(packageRoot, "src", dirName, "__init__.py"),
  ]

  let initPath: string | undefined
  for (const c of candidates) {
    try {
      if ((await stat(c)).isFile()) {
        initPath = c
        break
      }
    } catch {
      /* try next */
    }
  }

  if (!initPath) return surface

  async function walkInit(filePath: string): Promise<void> {
    const abs = resolve(filePath)
    if (seen.has(abs)) return
    seen.add(abs)
    surface.add(abs)

    let text: string
    try {
      text = await readFile(abs, "utf-8")
    } catch {
      return
    }

    const dir = dirname(abs)

    const allMatch = text.match(/__all__\s*=\s*\[([\s\S]*?)\]/)
    const allNames = allMatch
      ? (allMatch[1]?.match(/["']([^"']+)["']/g)?.map((s) => s.slice(1, -1)) ?? [])
      : undefined

    const nameToFile = new Map<string, string>()

    const relImportRe = /^from\s+\.(\.*)(\w[\w.]*)\s+import\s+(.+)$/gm
    for (let m = relImportRe.exec(text); m !== null; m = relImportRe.exec(text)) {
      const dots = m[1]
      if (dots && dots.length > 0) {
        warn?.(`collectPythonPublicSurface: multi-dot relative import skipped in ${abs}`)
        continue
      }
      const moduleName = m[2]
      const rawNames = m[3]
      if (!moduleName || !rawNames) continue
      const names = rawNames
        .split(",")
        .map((n) =>
          n
            .trim()
            .split(/\s+as\s+/)[0]
            ?.trim(),
        )
        .filter((n): n is string => Boolean(n))

      let modulePath: string | undefined
      const pyPath = resolve(dir, `${moduleName}.py`)
      try {
        if ((await stat(pyPath)).isFile()) modulePath = pyPath
      } catch {
        /* not a .py file */
      }
      if (!modulePath) {
        const subInit = resolve(dir, moduleName, "__init__.py")
        try {
          if ((await stat(subInit)).isFile()) modulePath = subInit
        } catch {
          /* not a subpackage */
        }
      }

      if (modulePath) {
        for (const name of names) {
          nameToFile.set(name, modulePath)
        }
      }
    }

    const bareRelImportRe = /^from\s+\.\s+import\s+(.+)$/gm
    for (let m = bareRelImportRe.exec(text); m !== null; m = bareRelImportRe.exec(text)) {
      const rawNames = m[1]
      if (!rawNames) continue
      const names = rawNames
        .split(",")
        .map((n) =>
          n
            .trim()
            .split(/\s+as\s+/)[0]
            ?.trim(),
        )
        .filter((n): n is string => Boolean(n))

      for (const name of names) {
        const pyPath = resolve(dir, `${name}.py`)
        try {
          if ((await stat(pyPath)).isFile()) {
            nameToFile.set(name, pyPath)
            continue
          }
        } catch {
          /* try subpackage */
        }
        const subInit = resolve(dir, name, "__init__.py")
        try {
          if ((await stat(subInit)).isFile()) {
            nameToFile.set(name, subInit)
          }
        } catch {
          /* skip */
        }
      }
    }

    if (allNames) {
      const surfaceFiles = new Set<string>()
      for (const name of allNames) {
        const file = nameToFile.get(name)
        if (file) surfaceFiles.add(file)
      }
      for (const file of surfaceFiles) {
        if (file.endsWith("__init__.py")) {
          await walkInit(file)
        } else {
          surface.add(resolve(file))
        }
      }
    } else {
      for (const file of nameToFile.values()) {
        if (file.endsWith("__init__.py")) {
          await walkInit(file)
        } else {
          surface.add(resolve(file))
        }
      }
    }
  }

  await walkInit(initPath)
  return surface
}

function parsePythonImports(fileContent: string): { spec: string; names: string[] }[] {
  const out: { spec: string; names: string[] }[] = []
  const lines = fileContent.split("\n")

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith("from .") || trimmed.startsWith("#")) continue

    const fromMatch = trimmed.match(/^from\s+([\w.]+)\s+import\s+(.+)$/)
    if (fromMatch) {
      const spec = fromMatch[1]
      const rawNames = fromMatch[2]
      if (!spec || !rawNames) continue
      const names = rawNames
        .split(",")
        .map((n) =>
          n
            .trim()
            .split(/\s+as\s+/)[0]
            ?.trim(),
        )
        .filter((n): n is string => Boolean(n))
      out.push({ spec, names })
      continue
    }

    const importMatch = trimmed.match(/^import\s+([\w.]+(?:\s*,\s*[\w.]+)*)$/)
    if (importMatch?.[1]) {
      const specs = importMatch[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      for (const spec of specs) {
        const last = spec.split(".").pop()
        if (last) out.push({ spec, names: [last] })
      }
    }
  }

  return out
}

async function listPythonSourceFiles(pkgRoot: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as Dirent[]
    } catch {
      return
    }
    for (const e of entries) {
      if (PYTHON_SKIP_DIRS.has(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        await walk(p)
      } else if (
        e.name.endsWith(".py") &&
        !e.name.startsWith("test_") &&
        !e.name.endsWith("_test.py")
      ) {
        out.push(p)
      }
    }
  }
  await walk(pkgRoot)
  return out
}

class PythonContractProvider implements ContractGraphProvider {
  readonly language: LanguageId = "python"

  async build(
    affectedFiles: string[],
    profile: ToolchainProfile,
    workDir: string,
    warn?: (msg: string) => void,
  ): Promise<ContractContext> {
    const packages = await discoverPythonPackages(workDir, warn)
    if (packages.size === 0) {
      return { modules: [], edges: [], affectedEdges: [] }
    }

    const extractor = new PythonAstExtractor(warn)
    const modules: ModuleNode[] = []

    for (const [id, root] of packages) {
      const files = await listPythonSourceFiles(root)
      if (files.length === 0) continue
      const surface = await collectPythonPublicSurface(root, warn)
      const surfaceFilter = surface.size > 0 ? surface : undefined
      const result = await extractor.extract(files, profile, workDir)
      const signatures = filterByPublicSurface(result.signatures, surfaceFilter)
      const types = filterByPublicSurface(result.types, surfaceFilter)
      const errorTypes = types.filter((t) => t.name.endsWith("Error")).map((t) => t.name)
      modules.push({
        id,
        language: "python",
        rootPath: resolve(root),
        publicExports: signatures,
        errorTypes,
      })
    }

    const importNameToId = new Map<string, string>()
    for (const [id, root] of packages) {
      importNameToId.set(id, id)
      const dirName = basename(root)
      if (dirName !== id) importNameToId.set(dirName, id)
    }

    const modById = new Map(modules.map((m) => [m.id, m]))
    const edgeMap = new Map<string, ContractEdge>()

    for (const [id, root] of packages) {
      const files = await listPythonSourceFiles(root)
      for (const fp of files) {
        let text: string
        try {
          text = await readFile(fp, "utf-8")
        } catch {
          continue
        }
        const imports = parsePythonImports(text)
        for (const imp of imports) {
          const topLevel = imp.spec.split(".")[0]
          if (!topLevel) continue
          const toId = importNameToId.get(topLevel)
          if (!toId || toId === id) continue
          const key = `${id}->${toId}`
          let edge = edgeMap.get(key)
          if (!edge) {
            const prov = modById.get(toId)
            edge = {
              from: id,
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
      const p = packageForPath(abs, packages)
      if (p) touched.add(p.id)
    }
    const affectedEdges = edges.filter((e) => touched.has(e.from) || touched.has(e.to))

    return { modules, edges, affectedEdges }
  }
}

// ── Go contract graph helpers ──────────────────────────────────────────

const GO_SKIP_DIRS = new Set(["vendor", "testdata", "node_modules", ".git"])

function parseGoModulePath(content: string): string | undefined {
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.startsWith("//")) continue
    const m = trimmed.match(/^module\s+(\S+)/)
    if (m?.[1]) return m[1]
  }
  return undefined
}

async function discoverGoModules(
  workDir: string,
  warn?: (msg: string) => void,
): Promise<Map<string, string>> {
  const modules = new Map<string, string>()

  let goWorkContent: string | undefined
  try {
    goWorkContent = await readFile(join(workDir, "go.work"), "utf-8")
  } catch {
    /* no go.work */
  }

  if (goWorkContent) {
    const usePaths: string[] = []
    let inBlock = false
    for (const line of goWorkContent.split("\n")) {
      const trimmed = line.trim()
      if (trimmed.startsWith("//")) continue

      if (inBlock) {
        if (trimmed === ")") {
          inBlock = false
          continue
        }
        const pathMatch = trimmed.match(/^(\S+)/)
        if (pathMatch?.[1]) usePaths.push(pathMatch[1])
        continue
      }

      const blockStart = trimmed.match(/^use\s*\(\s*$/)
      if (blockStart) {
        inBlock = true
        continue
      }

      const inlineBlockStart = trimmed.match(/^use\s*\(\s*(\S+)\s*\)\s*$/)
      if (inlineBlockStart?.[1]) {
        usePaths.push(inlineBlockStart[1])
        continue
      }

      const singleUse = trimmed.match(/^use\s+(\S+)/)
      if (singleUse?.[1] && !singleUse[1].startsWith("(")) {
        usePaths.push(singleUse[1])
      }
    }

    for (const rel of usePaths) {
      const modRoot = resolve(workDir, rel)
      try {
        const goMod = await readFile(join(modRoot, "go.mod"), "utf-8")
        const modPath = parseGoModulePath(goMod)
        if (modPath) modules.set(modPath, modRoot)
      } catch {
        warn?.(`discoverGoModules: go.work use ${rel} — missing or unreadable go.mod`)
      }
    }

    return modules
  }

  try {
    const goMod = await readFile(join(workDir, "go.mod"), "utf-8")
    const modPath = parseGoModulePath(goMod)
    if (modPath) modules.set(modPath, workDir)
  } catch {
    /* no root go.mod */
  }

  return modules
}

function isInternalPath(relPath: string): boolean {
  const segments = relPath.split("/")
  return segments.includes("internal")
}

async function listGoPackages(moduleRoot: string): Promise<{ dir: string; files: string[] }[]> {
  const packages: { dir: string; files: string[] }[] = []

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as Dirent[]
    } catch {
      return
    }

    const goFiles: string[] = []
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (GO_SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue
        const rel = relative(moduleRoot, p)
        if (isInternalPath(rel)) continue
        await walk(p)
      } else if (e.name.endsWith(".go") && !e.name.endsWith("_test.go")) {
        goFiles.push(p)
      }
    }

    if (goFiles.length > 0) packages.push({ dir, files: goFiles })
  }

  await walk(moduleRoot)
  return packages
}

function parseGoImports(fileContent: string): string[] {
  const imports: string[] = []

  const singleRe = /^import\s+(?:[\w.]+\s+)?"([^"]+)"/gm
  for (let m = singleRe.exec(fileContent); m !== null; m = singleRe.exec(fileContent)) {
    if (m[1]) imports.push(m[1])
  }

  const groupRe = /import\s*\(([\s\S]*?)\)/g
  for (let m = groupRe.exec(fileContent); m !== null; m = groupRe.exec(fileContent)) {
    const block = m[1]
    if (!block) continue
    for (const line of block.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("//")) continue
      const pathMatch = trimmed.match(/(?:[\w.]+\s+)?"([^"]+)"/)
      if (pathMatch?.[1]) imports.push(pathMatch[1])
    }
  }

  return imports
}

function goImportBelongsToModule(importPath: string, modulePath: string): boolean {
  return importPath === modulePath || importPath.startsWith(`${modulePath}/`)
}

class GoContractProvider implements ContractGraphProvider {
  readonly language: LanguageId = "go"

  async build(
    affectedFiles: string[],
    profile: ToolchainProfile,
    workDir: string,
    warn?: (msg: string) => void,
  ): Promise<ContractContext> {
    const goModules = await discoverGoModules(workDir, warn)
    if (goModules.size === 0) {
      warn?.("buildContractContext: no Go modules found (no go.work or go.mod)")
      return { modules: [], edges: [], affectedEdges: [] }
    }

    const extractor = new GoAstExtractor(warn)
    const modules: ModuleNode[] = []

    for (const [modPath, modRoot] of goModules) {
      const packages = await listGoPackages(modRoot)
      const allFiles = packages.flatMap((p) => p.files)
      if (allFiles.length === 0) continue
      const result = await extractor.extract(allFiles, profile, workDir)
      const errorTypes = result.types.filter((t) => t.name.endsWith("Error")).map((t) => t.name)
      modules.push({
        id: modPath,
        language: "go",
        rootPath: resolve(modRoot),
        publicExports: result.signatures,
        errorTypes,
      })
    }

    const modById = new Map(modules.map((m) => [m.id, m]))
    const edgeMap = new Map<string, ContractEdge>()
    const knownModPaths = [...goModules.keys()]

    for (const [modPath, modRoot] of goModules) {
      const packages = await listGoPackages(modRoot)
      for (const pkg of packages) {
        for (const fp of pkg.files) {
          let text: string
          try {
            text = await readFile(fp, "utf-8")
          } catch {
            continue
          }
          const imports = parseGoImports(text)
          for (const imp of imports) {
            const targetMod = knownModPaths.find(
              (m) => m !== modPath && goImportBelongsToModule(imp, m),
            )
            if (!targetMod) continue
            const key = `${modPath}->${targetMod}`
            let edge = edgeMap.get(key)
            if (!edge) {
              const prov = modById.get(targetMod)
              edge = {
                from: modPath,
                to: targetMod,
                importedSymbols: [],
                providerErrors: [...(prov?.errorTypes ?? [])],
                consumerCatches: [],
              }
              edgeMap.set(key, edge)
            }
            const pkgName = imp.split("/").pop()
            if (pkgName && !edge.importedSymbols.includes(pkgName)) {
              edge.importedSymbols.push(pkgName)
            }
          }
        }
      }
    }

    const edges = [...edgeMap.values()]

    const touched = new Set<string>()
    for (const rel of affectedFiles) {
      const abs = resolve(workDir, rel)
      for (const [modPath, modRoot] of goModules) {
        const r = relative(modRoot, abs)
        if (r && !r.startsWith("..")) {
          touched.add(modPath)
          break
        }
      }
    }
    const affectedEdges = edges.filter((e) => touched.has(e.from) || touched.has(e.to))

    return { modules, edges, affectedEdges }
  }
}

const PROVIDERS: Partial<Record<LanguageId, ContractGraphProvider>> = {
  typescript: new TypeScriptContractProvider(),
  python: new PythonContractProvider(),
  go: new GoContractProvider(),
}

export async function buildContractContext(
  affectedFiles: string[],
  profile: ToolchainProfile,
  workDir: string,
  warn?: (msg: string) => void,
): Promise<ContractContext> {
  const provider = PROVIDERS[profile.language]
  if (!provider) {
    warn?.(
      `buildContractContext: ${profile.language} provider not implemented — returning empty graph`,
    )
    return { modules: [], edges: [], affectedEdges: [] }
  }
  return provider.build(affectedFiles, profile, workDir, warn)
}
