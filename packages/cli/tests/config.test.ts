import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BollardError } from "@bollard/engine/src/errors.js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolveConfig } from "../src/config.js"

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "bollard-test-"))
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-test-fake-key")
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe("resolveConfig", () => {
  it("returns default values when no overrides exist", async () => {
    const { config, sources } = await resolveConfig(undefined, tempDir)

    expect(config.llm.default.provider).toBe("anthropic")
    expect(config.llm.default.model).toBe("claude-sonnet-4-20250514")
    expect(config.agent.max_cost_usd).toBe(50)
    expect(config.agent.max_duration_minutes).toBe(30)
    expect(sources["llm.default.provider"]?.source).toBe("default")
  })

  it("overrides model from BOLLARD_MODEL env var", async () => {
    vi.stubEnv("BOLLARD_MODEL", "claude-haiku-3-5-20241022")

    const { config, sources } = await resolveConfig(undefined, tempDir)

    expect(config.llm.default.model).toBe("claude-haiku-3-5-20241022")
    expect(sources["llm.default.model"]?.source).toBe("env")
    expect(sources["llm.default.model"]?.detail).toBe("env:BOLLARD_MODEL")
  })

  it("auto-detects tsconfig.json", async () => {
    writeFileSync(join(tempDir, "tsconfig.json"), "{}")

    const { sources } = await resolveConfig(undefined, tempDir)

    expect(sources["detected.typescript"]?.source).toBe("auto-detected")
    expect(sources["detected.typescript"]?.value).toBe(true)
  })

  it("auto-detects biome.json", async () => {
    writeFileSync(join(tempDir, "tsconfig.json"), "{}")
    writeFileSync(join(tempDir, "biome.json"), "{}")

    const { sources } = await resolveConfig(undefined, tempDir)

    expect(sources["detected.biome"]?.source).toBe("auto-detected")
    expect(sources["detected.biome"]?.value).toBe(true)
  })

  it("parses .bollard.yml and merges values", async () => {
    const yaml = [
      "llm:",
      "  default:",
      "    provider: mock",
      "    model: test-model",
      "agent:",
      "  max_cost_usd: 25",
    ].join("\n")
    writeFileSync(join(tempDir, ".bollard.yml"), yaml)

    const { config, sources } = await resolveConfig(undefined, tempDir)

    expect(config.llm.default.provider).toBe("mock")
    expect(config.llm.default.model).toBe("test-model")
    expect(config.agent.max_cost_usd).toBe(25)
    expect(sources["llm.default.provider"]?.source).toBe("file")
  })

  it("rejects invalid .bollard.yml with unknown keys", async () => {
    writeFileSync(join(tempDir, ".bollard.yml"), "unknown_key: true\n")

    await expect(resolveConfig(undefined, tempDir)).rejects.toThrow(BollardError)
    try {
      await resolveConfig(undefined, tempDir)
    } catch (err) {
      expect(BollardError.hasCode(err, "CONFIG_INVALID")).toBe(true)
    }
  })

  it("env var overrides .bollard.yml value", async () => {
    const yaml = ["llm:", "  default:", "    model: yaml-model"].join("\n")
    writeFileSync(join(tempDir, ".bollard.yml"), yaml)
    vi.stubEnv("BOLLARD_MODEL", "env-model")

    const { config } = await resolveConfig(undefined, tempDir)

    expect(config.llm.default.model).toBe("env-model")
  })

  it("throws CONFIG_INVALID when no API key is set", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "")
    vi.stubEnv("OPENAI_API_KEY", "")

    await expect(resolveConfig(undefined, tempDir)).rejects.toThrow(BollardError)
    try {
      await resolveConfig(undefined, tempDir)
    } catch (err) {
      expect(BollardError.hasCode(err, "CONFIG_INVALID")).toBe(true)
    }
  })

  it("includes ToolchainProfile in resolved config", async () => {
    writeFileSync(join(tempDir, "tsconfig.json"), "{}")
    writeFileSync(join(tempDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'")

    const { profile } = await resolveConfig(undefined, tempDir)

    expect(profile.language).toBe("typescript")
    expect(profile.packageManager).toBe("pnpm")
    expect(profile.checks.typecheck?.label).toBe("tsc")
  })

  it("applies .bollard.yml toolchain overrides", async () => {
    writeFileSync(join(tempDir, "tsconfig.json"), "{}")
    writeFileSync(join(tempDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'")
    const yaml = ["toolchain:", "  extra_commands:", '    - "make"', '    - "docker"'].join("\n")
    writeFileSync(join(tempDir, ".bollard.yml"), yaml)

    const { profile } = await resolveConfig(undefined, tempDir)

    expect(profile.allowedCommands).toContain("make")
    expect(profile.allowedCommands).toContain("docker")
  })

  it("merges root adversarial: scope concern overrides global (spec §4)", async () => {
    writeFileSync(join(tempDir, "tsconfig.json"), "{}")
    const yaml = [
      "adversarial:",
      "  concerns:",
      "    security: off",
      "  boundary:",
      "    concerns:",
      "      security: high",
    ].join("\n")
    writeFileSync(join(tempDir, ".bollard.yml"), yaml)

    const { profile } = await resolveConfig(undefined, tempDir)

    expect(profile.adversarial.boundary.concerns.security).toBe("high")
    expect(profile.adversarial.contract.concerns.security).toBe("off")
  })

  it("behavioral.enabled stays false by default after YAML merge", async () => {
    writeFileSync(join(tempDir, "tsconfig.json"), "{}")
    writeFileSync(join(tempDir, ".bollard.yml"), "adversarial:\n  boundary:\n    mode: blackbox\n")

    const { profile } = await resolveConfig(undefined, tempDir)

    expect(profile.adversarial.behavioral.enabled).toBe(false)
  })

  it("rejects invalid adversarial concern weight with CONCERN_CONFIG_INVALID", async () => {
    writeFileSync(join(tempDir, "tsconfig.json"), "{}")
    writeFileSync(
      join(tempDir, ".bollard.yml"),
      ["adversarial:", "  concerns:", "    security: ultra-high"].join("\n"),
    )

    try {
      await resolveConfig(undefined, tempDir)
      expect.fail("expected throw")
    } catch (err) {
      expect(BollardError.hasCode(err, "CONCERN_CONFIG_INVALID")).toBe(true)
    }
  })

  it("legacy toolchain.adversarial applies when root adversarial absent", async () => {
    writeFileSync(join(tempDir, "tsconfig.json"), "{}")
    const yaml = ["toolchain:", "  adversarial:", "    mode: blackbox", "    persist: true"].join(
      "\n",
    )
    writeFileSync(join(tempDir, ".bollard.yml"), yaml)

    const { profile } = await resolveConfig(undefined, tempDir)

    expect(profile.adversarial.boundary.mode).toBe("blackbox")
    expect(profile.adversarial.boundary.lifecycle).toBe("persistent")
  })

  it("skips legacy toolchain.adversarial when root adversarial present", async () => {
    writeFileSync(join(tempDir, "tsconfig.json"), "{}")
    const yaml = [
      "adversarial:",
      "  boundary:",
      "    mode: in-language",
      "toolchain:",
      "  adversarial:",
      "    mode: blackbox",
    ].join("\n")
    writeFileSync(join(tempDir, ".bollard.yml"), yaml)

    const { profile } = await resolveConfig(undefined, tempDir)

    expect(profile.adversarial.boundary.mode).toBe("in-language")
  })
})
