import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultAdversarialConfig } from "@bollard/detect/src/concerns.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { afterEach, describe, expect, it } from "vitest"
import { generateCursorConfig } from "../../src/generators/cursor.js"
import { writeGeneratedFiles } from "../../src/init-ide.js"

function makeProfile(overrides: Partial<ToolchainProfile> = {}): ToolchainProfile {
  const language = overrides.language ?? "typescript"
  return {
    language,
    sourcePatterns: ["src/**/*.ts"],
    testPatterns: ["tests/**/*.test.ts"],
    ignorePatterns: ["node_modules"],
    allowedCommands: ["pnpm"],
    checks: {
      typecheck: {
        label: "tsc",
        cmd: "pnpm",
        args: ["run", "typecheck"],
        source: "auto-detected",
      },
      lint: { label: "biome", cmd: "pnpm", args: ["run", "lint"], source: "auto-detected" },
      test: {
        label: "vitest",
        cmd: "pnpm",
        args: ["exec", "vitest", "run"],
        source: "auto-detected",
      },
    },
    adversarial: defaultAdversarialConfig({ language }),
    ...overrides,
  }
}

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

describe("generateCursorConfig", () => {
  it("returns platform cursor", async () => {
    const result = await generateCursorConfig("/tmp", makeProfile())
    expect(result.platform).toBe("cursor")
  })

  it("marks MCP config as merge", async () => {
    const result = await generateCursorConfig("/tmp", makeProfile())
    const mcp = result.files.find((f) => f.path === ".cursor/mcp.json")
    expect(mcp?.merge).toBe(true)
  })

  it("includes mcpServers.bollard with Docker compose MCP command", async () => {
    const result = await generateCursorConfig("/tmp", makeProfile())
    const mcp = result.files.find((f) => f.path === ".cursor/mcp.json")
    expect(mcp?.content).toBeDefined()
    const parsed = JSON.parse(mcp?.content ?? "{}") as {
      mcpServers: { bollard: { command: string; args: string[] } }
    }
    expect(parsed.mcpServers.bollard.command).toBe("docker")
    expect(parsed.mcpServers.bollard.args).toContain("compose")
    expect(parsed.mcpServers.bollard.args).toContain("--filter")
    expect(parsed.mcpServers.bollard.args).toContain("@bollard/mcp")
    expect(parsed.mcpServers.bollard.args.join(" ")).toContain("run start")
  })

  it("rules file has rule-type Always frontmatter", async () => {
    const result = await generateCursorConfig("/tmp", makeProfile())
    const rules = result.files.find((f) => f.path === ".cursor/rules/bollard.mdc")
    expect(rules?.content).toContain("rule-type: Always")
  })

  it("rules file includes TypeScript coding standards when profile is TypeScript", async () => {
    const result = await generateCursorConfig("/tmp", makeProfile({ language: "typescript" }))
    const rules = result.files.find((f) => f.path === ".cursor/rules/bollard.mdc")
    const content = rules?.content ?? ""
    expect(content).toContain("No `any` types")
    expect(content).toContain("named exports only")
    expect(content).not.toContain("PEP 484")
  })

  it("rules file includes Python coding standards when profile is Python", async () => {
    const result = await generateCursorConfig(
      "/tmp",
      makeProfile({
        language: "python",
        sourcePatterns: ["src/**/*.py"],
        testPatterns: ["tests/**/*.py"],
      }),
    )
    const rules = result.files.find((f) => f.path === ".cursor/rules/bollard.mdc")
    const content = rules?.content ?? ""
    expect(content).toContain("PEP 484")
    expect(content).toContain("bare `except:`")
    expect(content).not.toContain("named exports only")
  })

  it("rules file contains mandatory verification protocol", async () => {
    const result = await generateCursorConfig("/tmp", makeProfile())
    const rules = result.files.find((f) => f.path === ".cursor/rules/bollard.mdc")
    const content = rules?.content ?? ""
    expect(content).toContain("VERIFICATION PROTOCOL (MANDATORY)")
    expect(content).toContain("you MUST call `bollard_verify`")
    expect(content).toContain("Before running `git commit`")
    expect(content).toContain("bollard_contract")
    expect(content).toContain("DO NOT call `bollard_verify` after every individual file edit")
  })

  it("does not generate hooks.json", async () => {
    const result = await generateCursorConfig("/tmp", makeProfile())
    const hooks = result.files.find((f) => f.path === ".cursor/hooks.json")
    expect(hooks).toBeUndefined()
  })

  it("generates four slash command files with expected paths", async () => {
    const result = await generateCursorConfig("/tmp", makeProfile())
    const paths = result.files.map((f) => f.path).sort()
    expect(paths).toContain(".cursor/commands/bollard-verify.md")
    expect(paths).toContain(".cursor/commands/bollard-implement.md")
    expect(paths).toContain(".cursor/commands/bollard-contract.md")
    expect(paths).toContain(".cursor/commands/bollard-drift.md")
  })

  it("generates automations guide", async () => {
    const result = await generateCursorConfig("/tmp", makeProfile())
    const guide = result.files.find((f) => f.path === ".cursor/bollard-automations-guide.md")
    expect(guide?.content).toContain("Bollard Cursor Automations")
  })

  it("merges mcp.json without dropping existing servers when file exists", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cursor-gen-"))
    const cursorDir = join(tempDir, ".cursor")
    await mkdir(cursorDir, { recursive: true })
    await writeFile(
      join(cursorDir, "mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "echo", args: ["hi"] } } }, null, 2),
      "utf-8",
    )
    const result = await generateCursorConfig(tempDir, makeProfile())
    const { written } = await writeGeneratedFiles(tempDir, result)
    expect(written).toContain(".cursor/mcp.json")
    const merged = JSON.parse(await readFile(join(cursorDir, "mcp.json"), "utf-8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>
    }
    expect(merged.mcpServers.other).toEqual({ command: "echo", args: ["hi"] })
    expect(merged.mcpServers.bollard?.command).toBe("docker")
  })
})
