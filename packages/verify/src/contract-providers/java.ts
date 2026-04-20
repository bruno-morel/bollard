import type { Dirent } from "node:fs"
import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import type { LanguageId, ToolchainProfile } from "@bollard/detect/src/types.js"
import { JavaParserExtractor } from "../extractors/java.js"
import type { ContractContext, ContractEdge, ContractGraphProvider, ModuleNode } from "./types.js"

const SKIP = new Set(["build", "target", ".gradle", "node_modules", ".git", "out"])

export interface JvmModule {
  id: string
  root: string
}

/** Parse Maven `<modules>` from root pom (best-effort). */
export async function discoverMavenModules(workDir: string): Promise<JvmModule[]> {
  let rootPom: string
  try {
    rootPom = await readFile(join(workDir, "pom.xml"), "utf-8")
  } catch {
    return []
  }
  const mods: JvmModule[] = []
  const block = rootPom.match(/<modules>([\s\S]*?)<\/modules>/i)
  if (!block?.[1]) {
    mods.push({ id: ".", root: workDir })
    return mods
  }
  for (const m of block[1].matchAll(/<module>([^<]+)<\/module>/gi)) {
    const name = m[1]?.trim()
    if (name) mods.push({ id: name, root: resolve(workDir, name) })
  }
  if (mods.length === 0) {
    mods.push({ id: ".", root: workDir })
  }
  return mods
}

/** Parse Gradle `include` lines (Groovy + simplified Kotlin DSL). */
export function parseGradleIncludes(content: string): string[] {
  const out: string[] = []
  const re = /include\s*\(\s*([^)]+)\s*\)|include\s+([^\n]+)/g
  let m: RegExpExecArray | null
  while (true) {
    m = re.exec(content)
    if (m === null) break
    const raw = (m[1] ?? m[2] ?? "").trim()
    const parts = raw.split(/[,]/).map((s) =>
      s
        .trim()
        .replace(/^['"]|['"]$/g, "")
        .replace(/^:/, "")
        .replace(/:/g, "/"),
    )
    for (const p of parts) {
      if (p.length > 0) out.push(p)
    }
  }
  return [...new Set(out)]
}

export async function discoverGradleModules(workDir: string): Promise<JvmModule[]> {
  let settings = ""
  for (const f of ["settings.gradle.kts", "settings.gradle"]) {
    try {
      settings = await readFile(join(workDir, f), "utf-8")
      break
    } catch {
      /* try next */
    }
  }
  const includes = parseGradleIncludes(settings)
  if (includes.length === 0) {
    return [{ id: ".", root: workDir }]
  }
  return includes.map((id) => ({ id, root: resolve(workDir, id) }))
}

function packageFromJavaPath(absFile: string, moduleRoot: string): string | undefined {
  const rel = relative(moduleRoot, absFile).replace(/\\/g, "/")
  const m = rel.match(/src\/main\/(?:java|kotlin)\/(.+)\.[^.]+$/)
  if (!m?.[1]) return undefined
  const segments = m[1].split("/")
  if (segments.length < 2) return undefined
  return segments.slice(0, -1).join(".")
}

const JAVA_IMPORT_RE = /^import\s+(?:static\s+)?([a-zA-Z_][\w.]*)\s*;/gm
const KT_IMPORT_RE = /^import\s+(?:static\s+)?([a-zA-Z_][\w.]*)/gm

function parseImports(content: string, isKt: boolean): string[] {
  const re = isKt ? KT_IMPORT_RE : JAVA_IMPORT_RE
  const out: string[] = []
  let m: RegExpExecArray | null
  while (true) {
    m = re.exec(content)
    if (m === null) break
    if (m[1]) out.push(m[1])
  }
  return out
}

async function listSourceFiles(moduleRoot: string): Promise<{ path: string; isKt: boolean }[]> {
  const out: { path: string; isKt: boolean }[] = []
  async function walk(dir: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as Dirent[]
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP.has(e.name) || e.name.startsWith(".")) continue
        await walk(p)
      } else if (e.isFile()) {
        if (e.name.endsWith(".java")) out.push({ path: p, isKt: false })
        else if (e.name.endsWith(".kt")) out.push({ path: p, isKt: true })
      }
    }
  }
  for (const sub of ["src/main/java", "src/main/kotlin"]) {
    await walk(join(moduleRoot, sub))
  }
  return out
}

function longestModuleForPackage(
  pkg: string,
  modulePackages: Map<string, Set<string>>,
): string | undefined {
  let best: { id: string; len: number } | undefined
  for (const [modId, pkgs] of modulePackages) {
    for (const p of pkgs) {
      if (pkg === p || pkg.startsWith(`${p}.`)) {
        const len = p.length
        if (!best || len > best.len) best = { id: modId, len }
      }
    }
  }
  return best?.id
}

export class JavaContractProvider implements ContractGraphProvider {
  readonly language: LanguageId

  constructor(language: LanguageId = "java") {
    this.language = language === "kotlin" ? "kotlin" : "java"
  }

  async build(
    affectedFiles: string[],
    profile: ToolchainProfile,
    workDir: string,
    warn?: (msg: string) => void,
  ): Promise<ContractContext> {
    void profile
    const hasGradle =
      existsSync(join(workDir, "build.gradle")) ||
      existsSync(join(workDir, "build.gradle.kts")) ||
      existsSync(join(workDir, "settings.gradle")) ||
      existsSync(join(workDir, "settings.gradle.kts"))
    const hasMaven = existsSync(join(workDir, "pom.xml"))

    let modules: JvmModule[] = []
    if (hasGradle) {
      modules = await discoverGradleModules(workDir)
    } else if (hasMaven) {
      modules = await discoverMavenModules(workDir)
    } else {
      warn?.("JavaContractProvider: not a Maven/Gradle project")
      return { modules: [], edges: [], affectedEdges: [] }
    }

    const extractor = new JavaParserExtractor(warn)
    const moduleNodes: ModuleNode[] = []
    const modulePackages = new Map<string, Set<string>>()

    for (const mod of modules) {
      const files = await listSourceFiles(mod.root)
      if (files.length === 0) continue
      const pkgs = new Set<string>()
      for (const f of files) {
        const pkg = packageFromJavaPath(f.path, mod.root)
        if (pkg) pkgs.add(pkg)
      }
      modulePackages.set(mod.id, pkgs)

      const paths = files.map((x) => x.path)
      const ex = await extractor.extract(paths, profile, workDir)
      const errorTypes = ex.types
        .filter((t) => t.name.endsWith("Exception") || t.name.endsWith("Error"))
        .map((t) => t.name)
      moduleNodes.push({
        id: mod.id,
        language: profile.language,
        rootPath: resolve(mod.root),
        publicExports: ex.signatures,
        errorTypes,
      })
    }

    const edgeMap = new Map<string, ContractEdge>()
    const modIds = new Set(moduleNodes.map((m) => m.id))

    for (const mod of modules) {
      const files = await listSourceFiles(mod.root)
      for (const { path: fp, isKt } of files) {
        let text: string
        try {
          text = await readFile(fp, "utf-8")
        } catch {
          continue
        }
        const imports = parseImports(text, isKt)
        for (const imp of imports) {
          const targetMod = longestModuleForPackage(imp, modulePackages)
          if (!targetMod || targetMod === mod.id) continue
          if (!modIds.has(targetMod)) continue
          const key = `${mod.id}->${targetMod}`
          let edge = edgeMap.get(key)
          if (!edge) {
            const prov = moduleNodes.find((m) => m.id === targetMod)
            edge = {
              from: mod.id,
              to: targetMod,
              importedSymbols: [],
              providerErrors: [...(prov?.errorTypes ?? [])],
              consumerCatches: [],
            }
            edgeMap.set(key, edge)
          }
          const simple = imp.split(".").pop()
          if (simple && !edge.importedSymbols.includes(simple)) {
            edge.importedSymbols.push(simple)
          }
        }
      }
    }

    const edges = [...edgeMap.values()]
    const touched = new Set<string>()
    for (const rel of affectedFiles) {
      const abs = resolve(workDir, rel)
      for (const mod of modules) {
        const r = relative(mod.root, abs)
        if (r && !r.startsWith("..")) {
          touched.add(mod.id)
          break
        }
      }
    }
    const affectedEdges = edges.filter((e) => touched.has(e.from) || touched.has(e.to))

    return { modules: moduleNodes, edges, affectedEdges }
  }
}
