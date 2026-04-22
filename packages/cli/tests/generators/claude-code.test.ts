import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultAdversarialConfig } from "@bollard/detect/src/concerns.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { afterEach, describe, expect, it } from "vitest"
import { generateClaudeCodeConfig } from "../../src/generators/claude-code.js"

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

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

describe("generateClaudeCodeConfig", () => {
  it('returns platform "claude-code"', async () => {
    const result = await generateClaudeCodeConfig("/tmp", minimalProfile())
    expect(result.platform).toBe("claude-code")
  })

  it("places MCP config at .mcp.json root with merge true", async () => {
    const result = await generateClaudeCodeConfig("/tmp", minimalProfile())
    const mcp = result.files.find((f) => f.path === ".mcp.json")
    expect(mcp?.merge).toBe(true)
    expect(mcp?.path).toBe(".mcp.json")
  })

  it("generates four slash command files under .claude/commands/", async () => {
    const result = await generateClaudeCodeConfig("/tmp", minimalProfile())
    const cmds = result.files.filter((f) => f.path.startsWith(".claude/commands/"))
    expect(cmds).toHaveLength(4)
    const paths = cmds.map((c) => c.path).sort()
    expect(paths).toEqual([
      ".claude/commands/bollard-contract.md",
      ".claude/commands/bollard-implement.md",
      ".claude/commands/bollard-probe.md",
      ".claude/commands/bollard-verify.md",
    ])
  })

  it("verify command frontmatter includes tools: [Bash]", async () => {
    const result = await generateClaudeCodeConfig("/tmp", minimalProfile())
    const verify = result.files.find((f) => f.path === ".claude/commands/bollard-verify.md")
    expect(verify?.content).toContain("tools: [Bash]")
  })

  it("implement command frontmatter includes tools: [Bash, Read, Write, Edit]", async () => {
    const result = await generateClaudeCodeConfig("/tmp", minimalProfile())
    const impl = result.files.find((f) => f.path === ".claude/commands/bollard-implement.md")
    expect(impl?.content).toContain("tools: [Bash, Read, Write, Edit]")
  })

  it("writes subagent at .claude/agents/bollard-verifier.md", async () => {
    const result = await generateClaudeCodeConfig("/tmp", minimalProfile())
    const agent = result.files.find((f) => f.path === ".claude/agents/bollard-verifier.md")
    expect(agent?.content).toContain("Bollard Verification Agent")
  })

  it("settings.json hooks include only pre-commit gate (no verify-on-edit)", async () => {
    const result = await generateClaudeCodeConfig("/tmp", minimalProfile())
    const settings = result.files.find((f) => f.path === ".claude/settings.json")
    expect(settings?.merge).toBe(true)
    const parsed = JSON.parse(settings?.content ?? "{}") as {
      hooks: Array<{ name: string }>
    }
    const names = parsed.hooks.map((h) => h.name)
    expect(names).toContain("bollard-lint-pre-commit")
    expect(names).not.toContain("bollard-verify-on-edit")
  })

  it("CLAUDE.md entry contains verification protocol", async () => {
    const result = await generateClaudeCodeConfig("/tmp", minimalProfile())
    const claude = result.files.find((f) => f.path === "CLAUDE.md")
    expect(claude?.content).toContain("## Bollard Integration")
    expect(claude?.content).toContain("VERIFICATION PROTOCOL")
    expect(claude?.content).toContain("bollard_verify")
  })

  it("skips CLAUDE.md file when marker already present in existing file", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "claude-code-gen-"))
    await writeFile(
      join(tempDir, "CLAUDE.md"),
      "# Project\n\n## Bollard Integration\nalready here\n",
      "utf-8",
    )
    const result = await generateClaudeCodeConfig(tempDir, minimalProfile())
    expect(result.files.some((f) => f.path === "CLAUDE.md")).toBe(false)
    expect(result.messages.some((m) => m.includes("skipped"))).toBe(true)
  })
})
