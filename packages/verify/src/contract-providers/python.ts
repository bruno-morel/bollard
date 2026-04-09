import type { Dirent } from "node:fs"
import { readFile, readdir, stat } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"
import type { LanguageId, ToolchainProfile } from "@bollard/detect/src/types.js"
import { PythonAstExtractor } from "../extractors/python.js"
import type { ContractContext, ContractEdge, ContractGraphProvider, ModuleNode } from "./types.js"
import { filterByPublicSurface } from "./types.js"

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

export class PythonContractProvider implements ContractGraphProvider {
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
