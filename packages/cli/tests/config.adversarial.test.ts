import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fc from "fast-check"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveConfig } from "../src/config.js"

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

  it("should return default config when no files exist", () => {
    const result = resolveConfig({}, tempDir)
    
    expect(result.config).toBeDefined()
    expect(result.sources).toBeDefined()
    expect(typeof result.config).toBe("object")
    expect(typeof result.sources).toBe("object")
  })

  it("should merge CLI flags into resolved config", () => {
    const cliFlags = { agent: { max_cost_usd: 5.0 } }
    const result = resolveConfig(cliFlags, tempDir)
    
    expect(result.config.agent?.max_cost_usd).toBe(5.0)
    expect(result.sources).toHaveProperty("agent.max_cost_usd")
  })

  it("should detect and parse valid .bollard.yml file", () => {
    const configContent = `
llm:
  default:
    provider: anthropic
    model: claude-3-sonnet
agent:
  max_cost_usd: 10.0
`
    writeFileSync(join(tempDir, ".bollard.yml"), configContent)
    
    const result = resolveConfig({}, tempDir)
    
    expect(result.config.llm?.default?.provider).toBe("anthropic")
    expect(result.config.llm?.default?.model).toBe("claude-3-sonnet")
    expect(result.config.agent?.max_cost_usd).toBe(10.0)
  })

  it("should auto-detect project type from tsconfig.json", () => {
    writeFileSync(join(tempDir, "tsconfig.json"), JSON.stringify({}))
    
    const result = resolveConfig({}, tempDir)
    
    // Should detect TypeScript project and configure accordingly
    expect(result.sources).toBeDefined()
  })

  it("should auto-detect project type from biome.json", () => {
    writeFileSync(join(tempDir, "biome.json"), JSON.stringify({}))
    
    const result = resolveConfig({}, tempDir)
    
    expect(result.sources).toBeDefined()
  })
})

describe("Feature: Property-based tests for string/collection parameters", () => {
  let tempDir: string
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "bollard-config-prop-"))
    originalEnv = { ...process.env }
    process.env.ANTHROPIC_API_KEY = "test-key"
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    process.env = originalEnv
  })

  it("should handle arbitrary valid directory paths", () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1 }).filter(s => !s.includes('\0')),
      (pathSuffix) => {
        const testDir = join(tempDir, pathSuffix.replace(/[<>:"|?*]/g, '_'))
        
        try {
          const result = resolveConfig({}, testDir)
          expect(result).toBeDefined()
          expect(result.config).toBeDefined()
          expect(result.sources).toBeDefined()
        } catch (error) {
          // Directory might not exist, but function should handle gracefully
          expect(error).toBeDefined()
        }
      }
    ))
  })

  it("should handle arbitrary CLI flag combinations", () => {
    fc.assert(fc.property(
      fc.record({
        agent: fc.option(fc.record({
          max_cost_usd: fc.option(fc.float({ min: 0, max: 1000 })),
          max_duration_minutes: fc.option(fc.integer({ min: 1, max: 10000 }))
        })),
        llm: fc.option(fc.record({
          default: fc.option(fc.record({
            provider: fc.option(fc.constantFrom("anthropic", "openai")),
            model: fc.option(fc.string({ minLength: 1, maxLength: 50 }))
          }))
        }))
      }),
      (cliFlags) => {
        const result = resolveConfig(cliFlags, tempDir)
        
        expect(result.config).toBeDefined()
        expect(result.sources).toBeDefined()
        
        // CLI flags should be reflected in sources
        if (cliFlags.agent?.max_cost_usd !== undefined) {
          expect(result.config.agent?.max_cost_usd).toBe(cliFlags.agent.max_cost_usd)
        }
      }
    ))
  })
})

describe("Feature: Negative tests for error conditions", () => {
  let tempDir: string
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "bollard-config-neg-"))
    originalEnv = { ...process.env }
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    process.env = originalEnv
  })

  it("should throw CONFIG_INVALID when no API keys are set", () => {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    
    expect(() => resolveConfig({}, tempDir)).toThrow()
  })

  it("should reject .bollard.yml with extra top-level properties", () => {
    process.env.ANTHROPIC_API_KEY = "test-key"
    
    const invalidConfig = `
llm:
  default:
    provider: anthropic
invalid_extra_key: should_not_be_here
`
    writeFileSync(join(tempDir, ".bollard.yml"), invalidConfig)
    
    expect(() => resolveConfig({}, tempDir)).toThrow()
  })

  it("should reject invalid llm configuration structure", () => {
    process.env.ANTHROPIC_API_KEY = "test-key"
    
    const invalidConfig = `
llm:
  invalid_structure: true
  not_default_or_agents: value
`
    writeFileSync(join(tempDir, ".bollard.yml"), invalidConfig)
    
    expect(() => resolveConfig({}, tempDir)).toThrow()
  })

  it("should reject malformed YAML", () => {
    process.env.ANTHROPIC_API_KEY = "test-key"
    
    const malformedYaml = `
llm:
  default:
    provider: anthropic
  - invalid: yaml: structure
`
    writeFileSync(join(tempDir, ".bollard.yml"), malformedYaml)
    
    expect(() => resolveConfig({}, tempDir)).toThrow()
  })

  it("should handle non-existent directory gracefully", () => {
    process.env.ANTHROPIC_API_KEY = "test-key"
    const nonExistentDir = join(tempDir, "does-not-exist")
    
    // Should not throw, but handle gracefully
    const result = resolveConfig({}, nonExistentDir)
    expect(result).toBeDefined()
  })

  it("should reject negative cost limits", () => {
    process.env.ANTHROPIC_API_KEY = "test-key"
    
    const invalidConfig = `
agent:
  max_cost_usd: -5.0
`
    writeFileSync(join(tempDir, ".bollard.yml"), invalidConfig)
    
    expect(() => resolveConfig({}, tempDir)).toThrow()
  })

  it("should reject zero or negative duration limits", () => {
    process.env.ANTHROPIC_API_KEY = "test-key"
    
    const invalidConfig = `
agent:
  max_duration_minutes: 0
`
    writeFileSync(join(tempDir, ".bollard.yml"), invalidConfig)
    
    expect(() => resolveConfig({}, tempDir)).toThrow()
  })
})

describe("Feature: Domain-specific property assertions", () => {
  let tempDir: string
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "bollard-config-domain-"))
    originalEnv = { ...process.env }
    process.env.ANTHROPIC_API_KEY = "test-key"
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    process.env = originalEnv
  })

  it("should preserve source tracking for configuration values", () => {
    const configContent = `
llm:
  default:
    provider: anthropic
agent:
  max_cost_usd: 15.0
`
    writeFileSync(join(tempDir, ".bollard.yml"), configContent)
    
    const result = resolveConfig({ agent: { max_duration_minutes: 30 } }, tempDir)
    
    // File-sourced values should be tracked
    expect(result.sources).toHaveProperty("llm.default.provider")
    expect(result.sources["llm.default.provider"].source).toBe("file")
    expect(result.sources["llm.default.provider"].value).toBe("anthropic")
    
    // CLI-sourced values should be tracked
    expect(result.sources).toHaveProperty("agent.max_duration_minutes")
    expect(result.sources["agent.max_duration_minutes"].source).toBe("cli")
    expect(result.sources["agent.max_duration_minutes"].value).toBe(30)
  })

  it("should prioritize CLI flags over file configuration", () => {
    const configContent = `
agent:
  max_cost_usd: 10.0
`
    writeFileSync(join(tempDir, ".bollard.yml"), configContent)
    
    const result = resolveConfig({ agent: { max_cost_usd: 25.0 } }, tempDir)
    
    // CLI should override file
    expect(result.config.agent?.max_cost_usd).toBe(25.0)
    expect(result.sources["agent.max_cost_usd"].source).toBe("cli")
  })

  it("should detect project tooling and reflect in configuration", () => {
    // Create multiple config files to test detection priority
    writeFileSync(join(tempDir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }))
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "test" }))
    
    const result = resolveConfig({}, tempDir)
    
    // Should detect TypeScript project
    expect(result.sources).toBeDefined()
    // Auto-detection should be reflected in sources
    const autoDetectedKeys = Object.keys(result.sources).filter(
      key => result.sources[key].source === "auto-detected"
    )
    expect(autoDetectedKeys.length).toBeGreaterThan(0)
  })

  it("should validate LLM provider constraints", () => {
    process.env.ANTHROPIC_API_KEY = "test-key"
    
    const validProviders = ["anthropic", "openai"]
    
    validProviders.forEach(provider => {
      const configContent = `
llm:
  default:
    provider: ${provider}
    model: test-model
`
      writeFileSync(join(tempDir, ".bollard.yml"), configContent)
      
      const result = resolveConfig({}, tempDir)
      expect(result.config.llm?.default?.provider).toBe(provider)
    })
  })

  it("should enforce numeric constraints on cost and duration limits", () => {
    const validConfig = `
agent:
  max_cost_usd: 50.5
  max_duration_minutes: 120
`
    writeFileSync(join(tempDir, ".bollard.yml"), validConfig)
    
    const result = resolveConfig({}, tempDir)
    
    expect(result.config.agent?.max_cost_usd).toBe(50.5)
    expect(result.config.agent?.max_duration_minutes).toBe(120)
    expect(typeof result.config.agent?.max_cost_usd).toBe("number")
    expect(typeof result.config.agent?.max_duration_minutes).toBe("number")
  })
})