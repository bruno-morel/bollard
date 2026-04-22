import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..")
const pluginJsonPath = join(repoRoot, "plugin/claude-code/plugin.json")

interface PluginManifest {
  name: string
  version: string
  description?: string
  commands: string[]
  agents: string[]
  mcpServers: Record<string, { command: string; args: string[] }>
}

function loadManifest(): PluginManifest {
  const raw = readFileSync(pluginJsonPath, "utf-8")
  return JSON.parse(raw) as PluginManifest
}

describe("plugin/claude-code/plugin.json", () => {
  it("is valid JSON with expected fields", () => {
    const manifest = loadManifest()
    expect(manifest.name).toBe("bollard")
    expect(manifest.version).toBe("1.0.0")
    expect(Array.isArray(manifest.commands)).toBe(true)
    expect(Array.isArray(manifest.agents)).toBe(true)
    expect(manifest.mcpServers?.bollard?.command).toBe("npx")
    expect(manifest.mcpServers?.bollard?.args).toEqual(["-y", "@bollard/mcp"])
  })

  it("references expected command names and verifier agent", () => {
    const manifest = loadManifest()
    for (const cmd of [
      "bollard-verify",
      "bollard-implement",
      "bollard-contract",
      "bollard-probe",
    ]) {
      expect(manifest.commands).toContain(cmd)
    }
    expect(manifest.agents).toContain("bollard-verifier")
  })
})
