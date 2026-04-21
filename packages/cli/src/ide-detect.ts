import { existsSync } from "node:fs"
import { join } from "node:path"
import { BollardError } from "@bollard/engine/src/errors.js"

export type IdePlatform = "cursor" | "claude-code" | "codex" | "antigravity"

export const ALL_IDE_PLATFORMS: readonly IdePlatform[] = [
  "cursor",
  "claude-code",
  "codex",
  "antigravity",
] as const

/** Detect which IDE platform config directories already exist at the given root. */
export function detectIdeEnvironment(cwd: string): IdePlatform[] {
  const detected: IdePlatform[] = []
  if (existsSync(join(cwd, ".cursor"))) detected.push("cursor")
  if (existsSync(join(cwd, ".claude"))) detected.push("claude-code")
  if (existsSync(join(cwd, ".codex"))) detected.push("codex")
  if (existsSync(join(cwd, "mcp_config.json"))) detected.push("antigravity")
  return detected
}

/** Parse --ide flag value into a list of platforms. */
export function parseIdePlatform(value: string): IdePlatform[] {
  if (value === "all") return [...ALL_IDE_PLATFORMS]
  const platform = value as IdePlatform
  if (!ALL_IDE_PLATFORMS.includes(platform)) {
    throw new BollardError({
      code: "IDE_CONFIG_INVALID",
      message: `Unknown IDE platform: "${value}". Valid options: ${ALL_IDE_PLATFORMS.join(", ")}, all`,
      context: { value },
    })
  }
  return [platform]
}
