import { defaultAdversarialConfig } from "@bollard/detect/src/concerns.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { describe, expect, it } from "vitest"
import { generateAntigravityConfig } from "../../src/generators/antigravity.js"
import { generateCodexConfig } from "../../src/generators/codex.js"

function minimalProfile(): ToolchainProfile {
  return {
    language: "typescript",
    checks: {},
    sourcePatterns: [],
    testPatterns: [],
    ignorePatterns: [],
    allowedCommands: [],
    adversarial: defaultAdversarialConfig({ language: "typescript" }),
  }
}

describe("generateAntigravityConfig", () => {
  it("generates mcp_config.json with merge flag and antigravity platform", async () => {
    const result = await generateAntigravityConfig("/tmp", minimalProfile())
    expect(result.platform).toBe("antigravity")
    const f = result.files.find((x) => x.path === "mcp_config.json")
    expect(f?.merge).toBe(true)
    expect(JSON.parse(f?.content ?? "{}")).toHaveProperty("mcpServers")
  })
})

describe("generateCodexConfig", () => {
  it("generates .codex/config.toml with TOML content", async () => {
    const result = await generateCodexConfig("/tmp", minimalProfile())
    const f = result.files.find((x) => x.path === ".codex/config.toml")
    expect(f?.content).toContain('command = "docker"')
    expect(f?.content).toContain("args = [")
  })

  it("TOML contains [mcp_servers.bollard] section", async () => {
    const result = await generateCodexConfig("/tmp", minimalProfile())
    const f = result.files.find((x) => x.path === ".codex/config.toml")
    expect(f?.content).toContain("[mcp_servers.bollard]")
    expect(f?.content).toContain("[mcp_servers.bollard.env]")
  })

  it('returns platform "codex"', async () => {
    const result = await generateCodexConfig("/tmp", minimalProfile())
    expect(result.platform).toBe("codex")
  })
})
