import type { Dirent } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import type { LanguageId, ToolchainProfile } from "@bollard/detect/src/types.js"
import { RustSynExtractor } from "../extractors/rust.js"
import type { ContractContext, ContractEdge, ContractGraphProvider, ModuleNode } from "./types.js"

const RUST_SKIP_DIRS = new Set(["target", "tests", "benches", "examples", "node_modules", ".git"])

const RUST_STD_CRATES = new Set(["std", "core", "alloc", "self", "super", "crate"])

// ── TOML helpers ──────────────────────────────────────────────────────

function parseCargoPackageName(content: string): string | undefined {
  const lines = content.split("\n")
  let inPackage = false
  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[(.+)\]\s*$/)
    if (sectionMatch) {
      inPackage = sectionMatch[1]?.trim() === "package"
      continue
    }
    if (inPackage) {
      const nameMatch = line.match(/^\s*name\s*=\s*["']([^"']+)["']/)
      if (nameMatch?.[1]) return nameMatch[1]
    }
  }
  return undefined
}

function parseCargoWorkspaceMembers(content: string): string[] | undefined {
  const lines = content.split("\n")
  let inWorkspace = false
  let inMembers = false
  const members: string[] = []
  let memberBuf = ""

  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[(.+)\]\s*$/)
    if (sectionMatch) {
      inWorkspace = sectionMatch[1]?.trim() === "workspace"
      inMembers = false
      continue
    }
    if (!inWorkspace) continue

    if (inMembers) {
      memberBuf += line
      if (line.includes("]")) {
        inMembers = false
      }
      continue
    }

    const membersMatch = line.match(/^\s*members\s*=\s*(.*)$/)
    if (membersMatch) {
      memberBuf = membersMatch[1] ?? ""
      if (!memberBuf.includes("]")) {
        inMembers = true
      }
    }
  }

  if (!memberBuf) return undefined

  const items = memberBuf.match(/["']([^"']+)["']/g)
  if (!items) return undefined
  return items.map((s) => s.slice(1, -1))
}

// ── Discovery ─────────────────────────────────────────────────────────

async function discoverCargoCrates(
  workDir: string,
  warn?: (msg: string) => void,
): Promise<Map<string, string>> {
  const crates = new Map<string, string>()

  let rootToml: string | undefined
  try {
    rootToml = await readFile(join(workDir, "Cargo.toml"), "utf-8")
  } catch {
    warn?.("buildContractContext: no Cargo.toml found")
    return crates
  }

  const wsMembers = parseCargoWorkspaceMembers(rootToml)

  if (wsMembers) {
    for (const pattern of wsMembers) {
      if (pattern.includes("*")) {
        const starIdx = pattern.indexOf("*")
        const prefix = pattern.slice(0, starIdx).replace(/\/$/, "")
        const baseAbs = resolve(workDir, prefix)
        try {
          const entries = await readdir(baseAbs, { withFileTypes: true })
          for (const e of entries) {
            if (!e.isDirectory()) continue
            const crateDir = resolve(baseAbs, e.name)
            try {
              const toml = await readFile(join(crateDir, "Cargo.toml"), "utf-8")
              const name = parseCargoPackageName(toml)
              if (name) crates.set(name, crateDir)
            } catch {
              /* no Cargo.toml in member dir */
            }
          }
        } catch {
          /* base dir doesn't exist */
        }
      } else {
        const crateDir = resolve(workDir, pattern)
        try {
          const toml = await readFile(join(crateDir, "Cargo.toml"), "utf-8")
          const name = parseCargoPackageName(toml)
          if (name) crates.set(name, crateDir)
        } catch {
          warn?.(
            `discoverCargoCrates: workspace member ${pattern} — missing or unreadable Cargo.toml`,
          )
        }
      }
    }
    return crates
  }

  const rootName = parseCargoPackageName(rootToml)
  if (rootName) {
    crates.set(rootName, workDir)
  }

  return crates
}

// ── Source listing ─────────────────────────────────────────────────────

async function listCrateSourceFiles(crateRoot: string): Promise<string[]> {
  const out: string[] = []
  const srcDir = join(crateRoot, "src")

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as Dirent[]
    } catch {
      return
    }
    for (const e of entries) {
      if (RUST_SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        await walk(p)
      } else if (e.name.endsWith(".rs") && !e.name.endsWith("_test.rs")) {
        out.push(p)
      }
    }
  }

  await walk(srcDir)
  return out
}

// ── Import edge extraction ────────────────────────────────────────────

function parseRustUseStatements(fileContent: string): string[] {
  const segments = new Set<string>()
  const re = /\buse\s+([\w_]+)::/g
  for (let m = re.exec(fileContent); m !== null; m = re.exec(fileContent)) {
    const first = m[1]
    if (first && !RUST_STD_CRATES.has(first)) segments.add(first)
  }
  return [...segments]
}

// ── Normalization ─────────────────────────────────────────────────────

function buildCrateNameLookup(crates: Map<string, string>): Map<string, string> {
  const lookup = new Map<string, string>()
  for (const name of crates.keys()) {
    lookup.set(name, name)
    const underscored = name.replace(/-/g, "_")
    if (underscored !== name) lookup.set(underscored, name)
  }
  return lookup
}

// ── Provider ──────────────────────────────────────────────────────────

export class RustContractProvider implements ContractGraphProvider {
  readonly language: LanguageId = "rust"

  async build(
    affectedFiles: string[],
    profile: ToolchainProfile,
    workDir: string,
    warn?: (msg: string) => void,
  ): Promise<ContractContext> {
    const crates = await discoverCargoCrates(workDir, warn)
    if (crates.size === 0) {
      warn?.("buildContractContext: no Rust crates found (no Cargo.toml)")
      return { modules: [], edges: [], affectedEdges: [] }
    }

    const extractor = new RustSynExtractor(warn)
    const modules: ModuleNode[] = []

    for (const [name, root] of crates) {
      const files = await listCrateSourceFiles(root)
      if (files.length === 0) continue
      const result = await extractor.extract(files, profile, workDir)
      const isPubCrate = (s: string) => /pub\s*\(\s*crate\s*\)/.test(s)
      const signatures = result.signatures.map((s) => ({
        ...s,
        signatures: s.signatures
          .split("\n")
          .filter((line) => !isPubCrate(line))
          .join("\n"),
      }))
      const types = result.types.filter((t) => !isPubCrate(t.definition))
      const errorTypes = types.filter((t) => t.name.endsWith("Error")).map((t) => t.name)
      modules.push({
        id: name,
        language: "rust",
        rootPath: resolve(root),
        publicExports: signatures,
        errorTypes,
      })
    }

    const crateLookup = buildCrateNameLookup(crates)
    const modById = new Map(modules.map((m) => [m.id, m]))
    const edgeMap = new Map<string, ContractEdge>()

    for (const [name, root] of crates) {
      const files = await listCrateSourceFiles(root)
      for (const fp of files) {
        let text: string
        try {
          text = await readFile(fp, "utf-8")
        } catch {
          continue
        }
        const usedCrates = parseRustUseStatements(text)
        for (const seg of usedCrates) {
          const targetName = crateLookup.get(seg)
          if (!targetName || targetName === name) continue
          const key = `${name}->${targetName}`
          let edge = edgeMap.get(key)
          if (!edge) {
            const prov = modById.get(targetName)
            edge = {
              from: name,
              to: targetName,
              importedSymbols: [],
              providerErrors: [...(prov?.errorTypes ?? [])],
              consumerCatches: [],
            }
            edgeMap.set(key, edge)
          }
          if (!edge.importedSymbols.includes(seg)) {
            edge.importedSymbols.push(seg)
          }
        }
      }
    }

    const edges = [...edgeMap.values()]

    const touched = new Set<string>()
    for (const rel of affectedFiles) {
      const abs = resolve(workDir, rel)
      for (const [crateName, crateRoot] of crates) {
        const r = relative(crateRoot, abs)
        if (r && !r.startsWith("..")) {
          touched.add(crateName)
          break
        }
      }
    }
    const affectedEdges = edges.filter((e) => touched.has(e.from) || touched.has(e.to))

    return { modules, edges, affectedEdges }
  }
}
