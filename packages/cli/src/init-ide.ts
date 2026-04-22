import { existsSync, readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import type { IdePlatform } from "./ide-detect.js"

export interface GeneratedFile {
  /** Relative path from project root */
  path: string
  /** File content */
  content: string
  /** If true, merge into existing file rather than overwriting */
  merge?: boolean
  /** If true, append content to an existing text file (trimEnd + blank lines); create if missing */
  appendText?: boolean
}

export interface IdeGeneratorResult {
  platform: IdePlatform
  files: GeneratedFile[]
  /** Summary messages for the user */
  messages: string[]
}

export type IdeGenerator = (cwd: string, profile: ToolchainProfile) => Promise<IdeGeneratorResult>

const generators = new Map<IdePlatform, IdeGenerator>()

export function registerIdeGenerator(platform: IdePlatform, generator: IdeGenerator): void {
  generators.set(platform, generator)
}

let builtinsLoaded = false

export async function loadBuiltinGenerators(): Promise<void> {
  if (builtinsLoaded) return
  builtinsLoaded = true

  const { generateCursorConfig } = await import("./generators/cursor.js")
  registerIdeGenerator("cursor", generateCursorConfig)

  const { generateClaudeCodeConfig } = await import("./generators/claude-code.js")
  registerIdeGenerator("claude-code", generateClaudeCodeConfig)

  const { generateAntigravityConfig } = await import("./generators/antigravity.js")
  registerIdeGenerator("antigravity", generateAntigravityConfig)

  const { generateCodexConfig } = await import("./generators/codex.js")
  registerIdeGenerator("codex", generateCodexConfig)
}

/** Merge a JSON object into an existing JSON file, or write fresh if no file exists. */
export async function mergeJsonFile(
  filePath: string,
  newContent: Record<string, unknown>,
): Promise<string> {
  let existing: Record<string, unknown> = {}
  if (existsSync(filePath)) {
    try {
      existing = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>
    } catch {
      existing = {}
    }
  }
  const merged = deepMerge(existing, newContent)
  return JSON.stringify(merged, null, 2)
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target }
  for (const [key, val] of Object.entries(source)) {
    if (
      val !== null &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        val as Record<string, unknown>,
      )
    } else {
      result[key] = val
    }
  }
  return result
}

/** Write generated files to disk. Never overwrites unless file is marked for merge. */
export async function writeGeneratedFiles(
  cwd: string,
  result: IdeGeneratorResult,
): Promise<{ written: string[]; skipped: string[] }> {
  const written: string[] = []
  const skipped: string[] = []

  for (const file of result.files) {
    const fullPath = join(cwd, file.path)
    await mkdir(dirname(fullPath), { recursive: true })

    if (file.appendText) {
      if (existsSync(fullPath)) {
        const existing = await readFile(fullPath, "utf-8")
        await writeFile(fullPath, `${existing.trimEnd()}\n\n${file.content}`, "utf-8")
        written.push(file.path)
      } else {
        await writeFile(fullPath, file.content, "utf-8")
        written.push(file.path)
      }
    } else if (file.merge && existsSync(fullPath)) {
      const merged = await mergeJsonFile(
        fullPath,
        JSON.parse(file.content) as Record<string, unknown>,
      )
      await writeFile(fullPath, merged, "utf-8")
      written.push(file.path)
    } else if (existsSync(fullPath)) {
      skipped.push(file.path)
    } else {
      await writeFile(fullPath, file.content, "utf-8")
      written.push(file.path)
    }
  }

  return { written, skipped }
}

/** Run the init --ide generation for the given platforms. */
export async function generateIdeConfigs(
  cwd: string,
  platforms: IdePlatform[],
  profile: ToolchainProfile,
): Promise<IdeGeneratorResult[]> {
  await loadBuiltinGenerators()
  const results: IdeGeneratorResult[] = []
  for (const platform of platforms) {
    const gen = generators.get(platform)
    if (!gen) {
      results.push({
        platform,
        files: [],
        messages: [`⚠ No generator registered for ${platform} (coming soon)`],
      })
      continue
    }
    results.push(await gen(cwd, profile))
  }
  return results
}
