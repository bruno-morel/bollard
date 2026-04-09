import type { Dirent } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import type { LanguageId, ToolchainProfile } from "@bollard/detect/src/types.js"
import { GoAstExtractor } from "../extractors/go.js"
import type { ContractContext, ContractEdge, ContractGraphProvider, ModuleNode } from "./types.js"

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

export class GoContractProvider implements ContractGraphProvider {
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
