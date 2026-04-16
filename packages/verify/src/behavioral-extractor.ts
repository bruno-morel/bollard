import type { Dirent } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { join, relative } from "node:path"
import type { LanguageId, ToolchainProfile } from "@bollard/detect/src/types.js"

export interface EndpointEntry {
  method: string
  path: string
  handler: string
  sourceFile: string
  auth?: string
}

export interface ConfigEntry {
  key: string
  source: "env" | "file" | "arg" | "code"
  defaultValue?: string
  sourceFile: string
}

export interface ExternalDependency {
  name: string
  type: "database" | "cache" | "queue" | "http" | "grpc" | "file" | "other"
  clientLibrary: string
  sourceFile: string
}

export interface FailureMode {
  dependency: string
  mode: string
  severity: "low" | "medium" | "high"
}

export interface BehavioralContext {
  endpoints: EndpointEntry[]
  config: ConfigEntry[]
  dependencies: ExternalDependency[]
  failureModes: FailureMode[]
}

const IGNORE_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "target",
  "coverage",
  ".bollard",
  "__pycache__",
  ".venv",
  "venv",
])

/** Library substring → dependency metadata */
const CLIENT_PATTERNS: ReadonlyArray<{
  match: RegExp
  name: string
  type: ExternalDependency["type"]
  clientLibrary: string
}> = [
  {
    match: /\bfrom\s+["']pg["']|require\(["']pg["']\)/,
    name: "postgres",
    type: "database",
    clientLibrary: "pg",
  },
  {
    match: /\bfrom\s+["']mysql2["']|require\(["']mysql2["']\)/,
    name: "mysql",
    type: "database",
    clientLibrary: "mysql2",
  },
  {
    match: /\bfrom\s+["']ioredis["']|require\(["']ioredis["']\)|\bredis\b.*createClient/,
    name: "redis",
    type: "cache",
    clientLibrary: "ioredis",
  },
  {
    match: /\bfrom\s+["']amqplib["']|require\(["']amqplib["']\)/,
    name: "rabbitmq",
    type: "queue",
    clientLibrary: "amqplib",
  },
  {
    match: /\bfrom\s+["']mongoose["']|require\(["']mongoose["']\)/,
    name: "mongodb",
    type: "database",
    clientLibrary: "mongoose",
  },
  {
    match: /\bfrom\s+["']@prisma\/client["']/,
    name: "prisma",
    type: "database",
    clientLibrary: "@prisma/client",
  },
  {
    match: /\bfrom\s+["']axios["']|require\(["']axios["']\)/,
    name: "http-upstream",
    type: "http",
    clientLibrary: "axios",
  },
  {
    match: /\bfrom\s+["']@anthropic-ai\/sdk["']/,
    name: "anthropic-api",
    type: "http",
    clientLibrary: "@anthropic-ai/sdk",
  },
  {
    match: /\bfrom\s+["']openai["']|require\(["']openai["']\)/,
    name: "openai-api",
    type: "http",
    clientLibrary: "openai",
  },
  {
    match: /\bfrom\s+["']@google\/generative-ai["']/,
    name: "google-generative-ai",
    type: "http",
    clientLibrary: "@google/generative-ai",
  },
  {
    match: /\bfrom\s+["']@modelcontextprotocol\/sdk["']/,
    name: "mcp-sdk",
    type: "grpc",
    clientLibrary: "@modelcontextprotocol/sdk",
  },
  {
    match: /\bimport\s+sqlalchemy|from\s+sqlalchemy\b/,
    name: "sqlalchemy",
    type: "database",
    clientLibrary: "sqlalchemy",
  },
  {
    match: /\basyncpg\b|import\s+asyncpg/,
    name: "postgres",
    type: "database",
    clientLibrary: "asyncpg",
  },
  {
    match: /\bdatabase\/sql\b|"database\/sql"|'database\/sql'/,
    name: "postgres",
    type: "database",
    clientLibrary: "database/sql",
  },
  {
    match: /\breqwest::/,
    name: "http-upstream",
    type: "http",
    clientLibrary: "reqwest",
  },
  {
    match: /\bredis::Client\b|::redis::/,
    name: "redis",
    type: "cache",
    clientLibrary: "redis",
  },
]

const FAILURE_BY_TYPE: Partial<
  Record<
    ExternalDependency["type"],
    ReadonlyArray<{ mode: string; severity: FailureMode["severity"] }>
  >
> = {
  database: [
    { mode: "timeout", severity: "high" },
    { mode: "connection_refused", severity: "high" },
    { mode: "auth_failure", severity: "high" },
    { mode: "query_timeout", severity: "medium" },
  ],
  cache: [
    { mode: "timeout", severity: "medium" },
    { mode: "connection_refused", severity: "high" },
    { mode: "eviction", severity: "low" },
  ],
  queue: [
    { mode: "queue_full", severity: "high" },
    { mode: "timeout", severity: "medium" },
    { mode: "connection_refused", severity: "high" },
  ],
  http: [
    { mode: "timeout", severity: "medium" },
    { mode: "rate_limit", severity: "medium" },
    { mode: "partial_response", severity: "medium" },
  ],
  grpc: [
    { mode: "timeout", severity: "medium" },
    { mode: "connection_refused", severity: "high" },
  ],
  file: [
    { mode: "io_error", severity: "medium" },
    { mode: "permission_denied", severity: "high" },
  ],
  other: [{ mode: "unknown_fault", severity: "low" }],
}

async function collectSourceFiles(workDir: string, lang: LanguageId): Promise<string[]> {
  const exts = extensionsForLanguage(lang)
  const out: string[] = []

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const name = String(e.name)
      const p = join(dir, name)
      if (e.isDirectory()) {
        if (IGNORE_DIR_NAMES.has(name)) continue
        await walk(p)
      } else if (e.isFile()) {
        const ext = name.includes(".") ? `.${name.split(".").pop()}` : ""
        if (ext && exts.has(ext)) out.push(p)
      }
    }
  }

  await walk(workDir)
  return out
}

function extensionsForLanguage(lang: LanguageId): Set<string> {
  switch (lang) {
    case "typescript":
    case "javascript":
      return new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"])
    case "python":
      return new Set([".py"])
    case "go":
      return new Set([".go"])
    case "rust":
      return new Set([".rs"])
    default:
      return new Set()
  }
}

function relPath(workDir: string, abs: string): string {
  const r = relative(workDir, abs)
  return r.startsWith("..") ? abs : r
}

function extractEndpointsFromTsJs(content: string, sourceFile: string): EndpointEntry[] {
  const endpoints: EndpointEntry[] = []
  const file = sourceFile

  const expressRoute =
    /(?:^|[^\w.])(app|router|api)\s*\.\s*(get|post|put|delete|patch|all|use)\s*\(\s*['"`]([^'"`]+)['"`]/gim
  for (const m of content.matchAll(expressRoute)) {
    const g1 = m[1] ?? ""
    const g2 = m[2] ?? ""
    const g3 = m[3] ?? ""
    const method = g2.toUpperCase() === "ALL" ? "ALL" : g2.toUpperCase()
    endpoints.push({
      method,
      path: g3,
      handler: `express:${g1}.${g2}`,
      sourceFile: file,
    })
  }

  const fastifyRoute =
    /(?:^|[^\w.])(app|fastify)\s*\.\s*(get|post|put|delete|patch|all)\s*\(\s*['"`]([^'"`]+)['"`]/gim
  for (const m of content.matchAll(fastifyRoute)) {
    const g1 = m[1] ?? ""
    const g2 = m[2] ?? ""
    const g3 = m[3] ?? ""
    endpoints.push({
      method: g2.toUpperCase(),
      path: g3,
      handler: `fastify:${g1}.${g2}`,
      sourceFile: file,
    })
  }

  const nestMethod = /@(Get|Post|Put|Delete|Patch)\s*\(\s*['"`]([^'"`]+)['"`]/gim
  for (const m of content.matchAll(nestMethod)) {
    const g1 = m[1] ?? ""
    const g2 = m[2] ?? ""
    endpoints.push({
      method: g1.toUpperCase(),
      path: g2,
      handler: `nest:${g1}`,
      sourceFile: file,
    })
  }

  return endpoints
}

function extractEndpointsFromPython(content: string, sourceFile: string): EndpointEntry[] {
  const endpoints: EndpointEntry[] = []
  const file = sourceFile

  const fastapiRoute =
    /@(app|router)\s*\.\s*(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gim
  for (const m of content.matchAll(fastapiRoute)) {
    const g1 = m[1] ?? ""
    const g2 = m[2] ?? ""
    const g3 = m[3] ?? ""
    endpoints.push({
      method: g2.toUpperCase(),
      path: g3,
      handler: `fastapi:${g1}.${g2}`,
      sourceFile: file,
    })
  }

  const djangoPath = /path\s*\(\s*['"`]([^'"`]+)['"`]/gim
  for (const m of content.matchAll(djangoPath)) {
    endpoints.push({
      method: "HTTP",
      path: m[1] ?? "",
      handler: "django:path",
      sourceFile: file,
    })
  }

  return endpoints
}

function extractEndpointsFromGo(content: string, sourceFile: string): EndpointEntry[] {
  const endpoints: EndpointEntry[] = []
  const file = sourceFile

  const handleFunc = /http\.HandleFunc\s*\(\s*["']([^"']+)["']/gim
  for (const m of content.matchAll(handleFunc)) {
    endpoints.push({
      method: "GET",
      path: m[1] ?? "",
      handler: "http.HandleFunc",
      sourceFile: file,
    })
  }

  const echoGet = /(?:^|\s)(e|echo)\s*\.\s*(GET|POST|PUT|DELETE|PATCH)\s*\(\s*["']([^"']+)["']/gim
  for (const m of content.matchAll(echoGet)) {
    endpoints.push({
      method: (m[2] ?? "").toUpperCase(),
      path: m[3] ?? "",
      handler: "echo:route",
      sourceFile: file,
    })
  }

  const ginGet = /(?:^|\s)(r|router)\s*\.\s*(GET|POST|PUT|DELETE|PATCH)\s*\(\s*["']([^"']+)["']/gim
  for (const m of content.matchAll(ginGet)) {
    endpoints.push({
      method: (m[2] ?? "").toUpperCase(),
      path: m[3] ?? "",
      handler: "gin:route",
      sourceFile: file,
    })
  }

  return endpoints
}

function extractEndpointsFromRust(content: string, sourceFile: string): EndpointEntry[] {
  const endpoints: EndpointEntry[] = []
  const file = sourceFile

  const actixAttr = /#\[(get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/gim
  for (const m of content.matchAll(actixAttr)) {
    endpoints.push({
      method: (m[1] ?? "").toUpperCase(),
      path: m[2] ?? "",
      handler: "actix:attr",
      sourceFile: file,
    })
  }

  const routeCall = /\.route\s*\(\s*["']([^"']+)["']/gim
  for (const m of content.matchAll(routeCall)) {
    endpoints.push({
      method: "HTTP",
      path: m[1] ?? "",
      handler: "route",
      sourceFile: file,
    })
  }

  return endpoints
}

function extractConfigEntries(
  content: string,
  sourceFile: string,
  lang: LanguageId,
): ConfigEntry[] {
  const entries: ConfigEntry[] = []
  const file = sourceFile

  const processEnvDot = /process\.env\.([A-Z0-9_]+)/gim
  for (const m of content.matchAll(processEnvDot)) {
    const k = m[1] ?? ""
    if (k) entries.push({ key: k, source: "code", sourceFile: file })
  }
  const processEnvBracket = /process\.env\[["']([A-Z0-9_]+)["']\]/gim
  for (const m of content.matchAll(processEnvBracket)) {
    const k = m[1] ?? ""
    if (k) entries.push({ key: k, source: "code", sourceFile: file })
  }

  if (lang === "python") {
    const osEnviron = /os\.environ\[["']([^"']+)["']\]|os\.getenv\s*\(\s*["']([^"']+)["']/gim
    for (const m of content.matchAll(osEnviron)) {
      const key = m[1] ?? m[2]
      if (key) entries.push({ key, source: "code", sourceFile: file })
    }
  }

  if (lang === "go") {
    const goGetenv = /os\.Getenv\s*\(\s*["']([^"']+)["']\)/gim
    for (const m of content.matchAll(goGetenv)) {
      const k = m[1] ?? ""
      if (k) entries.push({ key: k, source: "code", sourceFile: file })
    }
  }

  if (lang === "rust") {
    const rustEnv = /std::env::var\s*\(\s*["']([^"']+)["']\)/gim
    for (const m of content.matchAll(rustEnv)) {
      const k = m[1] ?? ""
      if (k) entries.push({ key: k, source: "code", sourceFile: file })
    }
  }

  return entries
}

function extractDependenciesFromContent(content: string, sourceFile: string): ExternalDependency[] {
  const deps: ExternalDependency[] = []
  const file = sourceFile

  for (const p of CLIENT_PATTERNS) {
    if (p.match.test(content)) {
      deps.push({
        name: p.name,
        type: p.type,
        clientLibrary: p.clientLibrary,
        sourceFile: file,
      })
    }
  }

  return deps
}

function dedupeEndpoints(endpoints: EndpointEntry[]): EndpointEntry[] {
  const seen = new Set<string>()
  const out: EndpointEntry[] = []
  for (const e of endpoints) {
    const k = `${e.method}:${e.path}:${e.sourceFile}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(e)
  }
  return out
}

function dedupeConfig(config: ConfigEntry[]): ConfigEntry[] {
  const seen = new Set<string>()
  const out: ConfigEntry[] = []
  for (const c of config) {
    const k = `${c.key}:${c.sourceFile}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(c)
  }
  return out
}

function dedupeDeps(deps: ExternalDependency[]): ExternalDependency[] {
  const seen = new Set<string>()
  const out: ExternalDependency[] = []
  for (const d of deps) {
    const k = `${d.name}:${d.sourceFile}:${d.clientLibrary}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(d)
  }
  return out
}

function buildFailureModesForDeps(deps: ExternalDependency[]): FailureMode[] {
  const modes: FailureMode[] = []
  const seen = new Set<string>()
  for (const d of deps) {
    const catalog = FAILURE_BY_TYPE[d.type] ?? FAILURE_BY_TYPE.other ?? []
    for (const f of catalog) {
      const k = `${d.name}:${f.mode}`
      if (seen.has(k)) continue
      seen.add(k)
      modes.push({
        dependency: d.name,
        mode: f.mode,
        severity: f.severity,
      })
    }
  }
  return modes
}

async function scanEnvFiles(workDir: string): Promise<ConfigEntry[]> {
  const entries: ConfigEntry[] = []
  let root: Dirent[]
  try {
    root = await readdir(workDir, { withFileTypes: true })
  } catch {
    return entries
  }
  for (const e of root) {
    if (!e.isFile()) continue
    const name = String(e.name)
    if (!/^\.env/.test(name)) continue
    try {
      const text = await readFile(join(workDir, name), "utf-8")
      for (const line of text.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) continue
        const eq = trimmed.indexOf("=")
        if (eq === -1) continue
        const key = trimmed.slice(0, eq).trim()
        if (/^[A-Z0-9_]+$/.test(key)) {
          entries.push({
            key,
            source: "file",
            sourceFile: name,
          })
        }
      }
    } catch {
      /* skip */
    }
  }
  return entries
}

/**
 * Deterministic behavioral context: HTTP-style endpoints, env/config hints, external deps, failure modes.
 */
export async function buildBehavioralContext(
  profile: ToolchainProfile,
  workDir: string,
  warn?: (msg: string) => void,
): Promise<BehavioralContext> {
  const lang = profile.language
  const supported: LanguageId[] = ["typescript", "javascript", "python", "go", "rust"]
  if (!supported.includes(lang)) {
    warn?.(`buildBehavioralContext: ${lang} not supported — returning empty context`)
    return { endpoints: [], config: [], dependencies: [], failureModes: [] }
  }

  const files = await collectSourceFiles(workDir, lang)
  const endpoints: EndpointEntry[] = []
  const config: ConfigEntry[] = []
  const dependencies: ExternalDependency[] = []

  for (const abs of files) {
    const sourceFile = relPath(workDir, abs)
    let content: string
    try {
      content = await readFile(abs, "utf-8")
    } catch {
      continue
    }

    if (lang === "typescript" || lang === "javascript") {
      endpoints.push(...extractEndpointsFromTsJs(content, sourceFile))
    } else if (lang === "python") {
      endpoints.push(...extractEndpointsFromPython(content, sourceFile))
    } else if (lang === "go") {
      endpoints.push(...extractEndpointsFromGo(content, sourceFile))
    } else if (lang === "rust") {
      endpoints.push(...extractEndpointsFromRust(content, sourceFile))
    }

    config.push(...extractConfigEntries(content, sourceFile, lang))
    dependencies.push(...extractDependenciesFromContent(content, sourceFile))
  }

  config.push(...(await scanEnvFiles(workDir)))

  const dedupedEndpoints = dedupeEndpoints(endpoints)
  const dedupedConfig = dedupeConfig(config)
  const dedupedDeps = dedupeDeps(dependencies)
  const failureModes = buildFailureModesForDeps(dedupedDeps)

  return {
    endpoints: dedupedEndpoints,
    config: dedupedConfig,
    dependencies: dedupedDeps,
    failureModes,
  }
}
