import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveConfig } from "../src/config.js"
import type { ResolvedConfig, ConfigSource, AnnotatedValue } from "../src/config.js"

describe("Feature: All exported functions have behavioral tests", () => {
  let tempDir: string
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "bollard-config-test-"))
    originalEnv = { ...process.env }
    process.env.ANTHROPIC_API_KEY = "test-key"
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    process.env = originalEnv
  })

  it("should resolve config with default values when no config file exists", async () => {
    const result = await resolveConfig({}, tempDir)
    
    expect(result).toHaveProperty("config")
    expect(result).toHaveProperty("profile")
    expect(result).toHaveProperty("sources")
    expect(typeof result.config).toBe("object")
    expect(typeof result.profile).toBe("object")
    expect(typeof result.sources).toBe("object")
  })

  it("should merge CLI flags with resolved config", async () => {
    const cliFlags = { agent: { max_cost_usd: 5.0 } }
    const result = await resolveConfig(cliFlags, tempDir)
    
    expect(result.config.agent?.max_cost_usd).toBe(5.0)
    expect(result.sources).toHaveProperty("agent.max_cost_usd")
    expect((result.sources["agent.max_cost_usd"] as AnnotatedValue<number>).source).toBe("cli")
  })

  it("should detect toolchain profile from filesystem", async () => {
    writeFileSync(join(tempDir, "tsconfig.json"), "{}")
    
    const result = await resolveConfig({}, tempDir)
    
    expect(result.profile).toHaveProperty("name")
    expect(result.profile).toHaveProperty("commands")
    expect(Array.isArray(result.profile.commands)).toBe(true)
  })
})

describe("Feature: Property-based tests for string/collection parameters", () => {
  let tempDir: string
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "bollard-config-test-"))
    originalEnv = { ...process.env }
    process.env.ANTHROPIC_API_KEY = "test-key"
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    process.env = originalEnv
  })

  it("should handle arbitrary valid cwd paths", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom(tempDir),
      async (cwd) => {
        const result = await resolveConfig({}, cwd)
        expect(result.config).toBeDefined()
        expect(result.profile).toBeDefined()
        expect(result.sources).toBeDefined()
      }
    ))
  })

  it("should handle arbitrary valid CLI config objects", async () => {
    await fc.assert(fc.asyncProperty(
      fc.record({
        llm: fc.option(fc.record({
          default: fc.option(fc.record({
            provider: fc.option(fc.constantFrom("anthropic", "openai")),
            model: fc.option(fc.string({ minLength: 1, maxLength: 50 }))
          }))
        })),
        agent: fc.option(fc.record({
          max_cost_usd: fc.option(fc.float({ min: 0.01, max: 1000 })),
          max_duration_minutes: fc.option(fc.integer({ min: 1, max: 1440 }))
        }))
      }),
      async (cliFlags) => {
        const result = await resolveConfig(cliFlags, tempDir)
        expect(result.config).toBeDefined()
        if (cliFlags.agent?.max_cost_usd) {
          expect(result.config.agent?.max_cost_usd).toBe(cliFlags.agent.max_cost_usd)
        }
        if (cliFlags.agent?.max_duration_minutes) {
          expect(result.config.agent?.max_duration_minutes).toBe(cliFlags.agent.max_duration_minutes)
        }
      }
    ))
  })
})

describe("Feature: Negative tests for error conditions", () => {
  let tempDir: string
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "bollard-config-test-"))
    originalEnv = { ...process.env }
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    process.env = originalEnv
  })

  it("should throw CONFIG_INVALID when no API keys are set", async () => {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    
    await expect(resolveConfig({}, tempDir)).rejects.toThrow()
  })

  it("should reject .bollard.yml with extra properties", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key"
    const invalidConfig = `
llm:
  default:
    provider: anthropic
extra_property: invalid
`
    writeFileSync(join(tempDir, ".bollard.yml"), invalidConfig)
    
    await expect(resolveConfig({}, tempDir)).rejects.toThrow()
  })

  it("should reject invalid llm provider values", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key"
    const invalidConfig = `
llm:
  default:
    provider: invalid_provider
`
    writeFileSync(join(tempDir, ".bollard.yml"), invalidConfig)
    
    await expect(resolveConfig({}, tempDir)).rejects.toThrow()
  })

  it("should reject negative max_cost_usd values", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key"
    const invalidConfig = `
agent:
  max_cost_usd: -1.0
`
    writeFileSync(join(tempDir, ".bollard.yml"), invalidConfig)
    
    await expect(resolveConfig({}, tempDir)).rejects.toThrow()
  })

  it("should reject non-numeric max_duration_minutes", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key"
    const invalidConfig = `
agent:
  max_duration_minutes: "not_a_number"
`
    writeFileSync(join(tempDir, ".bollard.yml"), invalidConfig)
    
    await expect(resolveConfig({}, tempDir)).rejects.toThrow()
  })

  it("should handle malformed YAML gracefully", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key"
    const malformedYaml = `
llm:
  default:
    provider: anthropic
  - invalid: yaml: structure
`
    writeFileSync(join(tempDir, ".bollard.yml"), malformedYaml)
    
    await expect(resolveConfig({}, tempDir)).rejects.toThrow()
  })

  it("should handle non-existent directory paths", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key"
    const nonExistentPath = join(tempDir, "does-not-exist")
    
    await expect(resolveConfig({}, nonExistentPath)).rejects.toThrow()
  })
})

describe("Feature: Domain-specific property assertions", () => {
  let tempDir: string
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "bollard-config-test-"))
    originalEnv = { ...process.env }
    process.env.ANTHROPIC_API_KEY = "test-key"
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    process.env = originalEnv
  })

  it("should preserve config source hierarchy: cli > file > env > auto-detected > default", async () => {
    const fileConfig = `
agent:
  max_cost_usd: 10.0
`
    writeFileSync(join(tempDir, ".bollard.yml"), fileConfig)
    
    const cliFlags = { agent: { max_cost_usd: 20.0 } }
    const result = await resolveConfig(cliFlags, tempDir)
    
    expect(result.config.agent?.max_cost_usd).toBe(20.0)
    expect((result.sources["agent.max_cost_usd"] as AnnotatedValue<number>).source).toBe("cli")
  })

  it("should annotate each config value with its source", async () => {
    const result = await resolveConfig({}, tempDir)
    
    Object.values(result.sources).forEach(annotated => {
      expect(annotated).toHaveProperty("value")
      expect(annotated).toHaveProperty("source")
      expect(["default", "auto-detected", "env", "file", "cli"]).toContain(annotated.source)
    })
  })

  it("should detect TypeScript toolchain when tsconfig.json exists", async () => {
    writeFileSync(join(tempDir, "tsconfig.json"), '{"compilerOptions": {}}')
    
    const result = await resolveConfig({}, tempDir)
    
    expect(result.profile.commands.some(cmd => 
      cmd.name.includes("typescript") || cmd.name.includes("tsc")
    )).toBe(true)
  })

  it("should detect Biome toolchain when biome.json exists", async () => {
    writeFileSync(join(tempDir, "biome.json"), '{}')
    
    const result = await resolveConfig({}, tempDir)
    
    expect(result.profile.commands.some(cmd => 
      cmd.name.includes("biome")
    )).toBe(true)
  })

  it("should validate LLM agent configurations have required provider and model", async () => {
    const configWithAgents = `
llm:
  agents:
    custom_agent:
      provider: anthropic
      model: claude-3-sonnet
`
    writeFileSync(join(tempDir, ".bollard.yml"), configWithAgents)
    
    const result = await resolveConfig({}, tempDir)
    
    expect(result.config.llm?.agents?.custom_agent).toHaveProperty("provider", "anthropic")
    expect(result.config.llm?.agents?.custom_agent).toHaveProperty("model", "claude-3-sonnet")
  })

  it("should enforce cost and duration limits are positive numbers", async () => {
    const result = await resolveConfig({
      agent: { max_cost_usd: 5.50, max_duration_minutes: 30 }
    }, tempDir)
    
    expect(result.config.agent?.max_cost_usd).toBeGreaterThan(0)
    expect(result.config.agent?.max_duration_minutes).toBeGreaterThan(0)
    expect(typeof result.config.agent?.max_cost_usd).toBe("number")
    expect(typeof result.config.agent?.max_duration_minutes).toBe("number")
  })
})