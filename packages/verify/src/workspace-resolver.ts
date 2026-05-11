import { readFile, readdir, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

/** Resolve `absPath` to an existing file, trying `.ts` / `.tsx` / `.d.ts` when the path ends in `.js` or has no extension. */
export async function resolveAbsolutePathWithTsExtensions(
  raw: string,
): Promise<string | undefined> {
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

export async function resolveSpecifierToFile(
  fromFile: string,
  specifier: string,
): Promise<string | undefined> {
  const raw = resolve(dirname(fromFile), specifier)
  return resolveAbsolutePathWithTsExtensions(raw)
}

export function resolvePackageDotExport(
  pkgRoot: string,
  exportsField: unknown,
): string | undefined {
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

export async function readWorkspacePackageRoots(workDir: string): Promise<Map<string, string>> {
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

/** Map `@scope/pkg/sub/path` → `@scope/pkg` to match `package.json` `name`. */
export function workspacePackageIdFromImportSpec(spec: string): string | undefined {
  if (!spec.startsWith("@")) return undefined
  const segments = spec.split("/")
  if (segments.length < 2 || !segments[0]?.startsWith("@")) return undefined
  const uname = segments[1]
  if (!uname) return undefined
  return `${segments[0]}/${uname}`
}

/** Resolve a workspace package import (e.g. `@bollard/foo` or `@bollard/foo/src/x.js`) to an absolute `.ts` file path, or undefined if not in the workspace map / not a file. */
export async function resolveWorkspaceSpecifier(
  spec: string,
  idToRoot: Map<string, string>,
): Promise<string | undefined> {
  const pkgId = workspacePackageIdFromImportSpec(spec)
  if (!pkgId) return undefined
  const pkgRoot = idToRoot.get(pkgId)
  if (!pkgRoot) return undefined

  if (spec === pkgId) {
    let pkgJson: { exports?: unknown; main?: string; types?: string }
    try {
      pkgJson = JSON.parse(await readFile(join(pkgRoot, "package.json"), "utf-8")) as {
        exports?: unknown
        main?: string
        types?: string
      }
    } catch {
      return undefined
    }
    const fromExports = resolvePackageDotExport(pkgRoot, pkgJson.exports)
    if (fromExports) {
      const r = await resolveAbsolutePathWithTsExtensions(fromExports)
      if (r) return r
    }
    for (const key of ["types", "main"] as const) {
      const rel = pkgJson[key]
      if (typeof rel === "string") {
        const abs = resolve(pkgRoot, rel)
        const r = await resolveAbsolutePathWithTsExtensions(abs)
        if (r) return r
      }
    }
    const idx = resolve(pkgRoot, "src/index.ts")
    try {
      if ((await stat(idx)).isFile()) return resolve(idx)
    } catch {
      /* */
    }
    return undefined
  }

  const sub = spec.slice(pkgId.length + 1)
  if (!sub) return resolveWorkspaceSpecifier(pkgId, idToRoot)
  const abs = resolve(pkgRoot, sub)
  return resolveAbsolutePathWithTsExtensions(abs)
}
