import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { detectToolchain } from "@bollard/detect/src/detect.js"
import type { ToolchainProfile, VerificationCommand } from "@bollard/detect/src/types.js"
import type { BollardConfig } from "@bollard/engine/src/context.js"
import { BollardError } from "@bollard/engine/src/errors.js"
import { parse as parseYaml } from "yaml"
import { z } from "zod"

export type ConfigSource = "default" | "auto-detected" | "env" | "file" | "cli"

export interface AnnotatedValue<T> {
  value: T
  source: ConfigSource
  detail?: string
}

const verificationCommandSchema = z.object({
  cmd: z.string(),
  args: z.array(z.string()).optional(),
})

const toolchainYamlSchema = z
  .object({
    language: z.string().optional(),
    checks: z
      .object({
        typecheck: verificationCommandSchema.optional(),
        lint: verificationCommandSchema.optional(),
        test: verificationCommandSchema.optional(),
        audit: verificationCommandSchema.optional(),
      })
      .optional(),
    extra_commands: z.array(z.string()).optional(),
    source_patterns: z.array(z.string()).optional(),
    test_patterns: z.array(z.string()).optional(),
    adversarial: z
      .object({
        mode: z.enum(["blackbox", "in-language", "both"]).optional(),
        runtime_image: z.string().optional(),
        persist: z.boolean().optional(),
      })
      .optional(),
  })
  .strict()

const bollardYamlSchema = z
  .object({
    llm: z
      .object({
        default: z
          .object({ provider: z.string().optional(), model: z.string().optional() })
          .optional(),
        agents: z.record(z.object({ provider: z.string(), model: z.string() })).optional(),
      })
      .optional(),
    agent: z
      .object({
        max_cost_usd: z.number().optional(),
        max_duration_minutes: z.number().optional(),
      })
      .optional(),
    risk: z.record(z.unknown()).optional(),
    toolchain: toolchainYamlSchema.optional(),
  })
  .strict()

const DEFAULTS: BollardConfig = {
  llm: { default: { provider: "anthropic", model: "claude-sonnet-4-20250514" } },
  agent: { max_cost_usd: 50, max_duration_minutes: 30 },
}

export interface ResolvedConfig {
  config: BollardConfig
  profile: ToolchainProfile
  sources: Record<string, AnnotatedValue<unknown>>
}

export async function resolveConfig(
  cliFlags?: Partial<BollardConfig>,
  cwd: string = process.cwd(),
): Promise<ResolvedConfig> {
  const config: BollardConfig = structuredClone(DEFAULTS)
  const sources: Record<string, AnnotatedValue<unknown>> = {
    "llm.default.provider": { value: DEFAULTS.llm.default.provider, source: "default" },
    "llm.default.model": { value: DEFAULTS.llm.default.model, source: "default" },
    "agent.max_cost_usd": { value: DEFAULTS.agent.max_cost_usd, source: "default" },
    "agent.max_duration_minutes": { value: DEFAULTS.agent.max_duration_minutes, source: "default" },
  }

  const profile = await detectToolchain(cwd)
  populateDetectionSources(cwd, profile, sources)

  const yamlOverrides = loadBollardYaml(cwd, config, sources)
  if (yamlOverrides) {
    applyToolchainOverrides(profile, yamlOverrides)
  }

  applyEnvVars(config, sources)

  if (cliFlags?.llm?.default) {
    if (cliFlags.llm.default.provider) {
      config.llm.default.provider = cliFlags.llm.default.provider
      sources["llm.default.provider"] = { value: cliFlags.llm.default.provider, source: "cli" }
    }
    if (cliFlags.llm.default.model) {
      config.llm.default.model = cliFlags.llm.default.model
      sources["llm.default.model"] = { value: cliFlags.llm.default.model, source: "cli" }
    }
  }

  if (cliFlags?.agent) {
    if (cliFlags.agent.max_cost_usd !== undefined) {
      config.agent.max_cost_usd = cliFlags.agent.max_cost_usd
      sources["agent.max_cost_usd"] = { value: cliFlags.agent.max_cost_usd, source: "cli" }
    }
    if (cliFlags.agent.max_duration_minutes !== undefined) {
      config.agent.max_duration_minutes = cliFlags.agent.max_duration_minutes
      sources["agent.max_duration_minutes"] = {
        value: cliFlags.agent.max_duration_minutes,
        source: "cli",
      }
    }
  }

  if (
    !process.env["ANTHROPIC_API_KEY"] &&
    !process.env["OPENAI_API_KEY"] &&
    !process.env["GOOGLE_API_KEY"]
  ) {
    throw new BollardError({
      code: "CONFIG_INVALID",
      message:
        "No LLM API key found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY environment variable.",
    })
  }

  return { config, profile, sources }
}

function populateDetectionSources(
  cwd: string,
  profile: ToolchainProfile,
  sources: Record<string, AnnotatedValue<unknown>>,
): void {
  if (profile.language === "typescript" && existsSync(join(cwd, "tsconfig.json"))) {
    sources["detected.typescript"] = { value: true, source: "auto-detected" }
  }

  if (
    profile.checks.lint?.label === "Biome" &&
    (existsSync(join(cwd, "biome.json")) || existsSync(join(cwd, "biome.jsonc")))
  ) {
    sources["detected.biome"] = { value: true, source: "auto-detected" }
  }

  if (profile.checks.test?.label === "Vitest") {
    sources["detected.vitest"] = { value: true, source: "auto-detected" }
  }

  if (profile.packageManager === "pnpm") {
    sources["detected.pnpm"] = { value: true, source: "auto-detected" }
  }

  sources["detected.language"] = { value: profile.language, source: "auto-detected" }
}

function applyToolchainOverrides(
  profile: ToolchainProfile,
  overrides: z.infer<typeof toolchainYamlSchema>,
): void {
  if (overrides.checks) {
    const checkEntries = Object.entries(overrides.checks) as [
      keyof typeof overrides.checks,
      z.infer<typeof verificationCommandSchema> | undefined,
    ][]
    for (const [key, val] of checkEntries) {
      if (val) {
        const cmd: VerificationCommand = {
          label: val.cmd,
          cmd: val.cmd,
          args: val.args ?? [],
          source: "file",
        }
        profile.checks[key] = cmd
      }
    }
  }

  if (overrides.extra_commands) {
    profile.allowedCommands = [...profile.allowedCommands, ...overrides.extra_commands]
  }

  if (overrides.source_patterns) {
    profile.sourcePatterns = overrides.source_patterns
  }

  if (overrides.test_patterns) {
    profile.testPatterns = overrides.test_patterns
  }

  if (overrides.adversarial) {
    if (overrides.adversarial.mode) {
      profile.adversarial.mode = overrides.adversarial.mode
    }
    if (overrides.adversarial.runtime_image) {
      profile.adversarial.runtimeImage = overrides.adversarial.runtime_image
    }
    if (overrides.adversarial.persist !== undefined) {
      profile.adversarial.persist = overrides.adversarial.persist
    }
  }
}

function loadBollardYaml(
  cwd: string,
  config: BollardConfig,
  sources: Record<string, AnnotatedValue<unknown>>,
): z.infer<typeof toolchainYamlSchema> | undefined {
  const yamlPath = join(cwd, ".bollard.yml")
  if (!existsSync(yamlPath)) return undefined

  const raw = readFileSync(yamlPath, "utf-8")
  const parsed: unknown = parseYaml(raw)
  const result = bollardYamlSchema.safeParse(parsed)

  if (!result.success) {
    throw new BollardError({
      code: "CONFIG_INVALID",
      message: `Invalid .bollard.yml: ${result.error.message}`,
      context: { path: yamlPath },
    })
  }

  const data = result.data
  if (data.llm?.default?.provider) {
    config.llm.default.provider = data.llm.default.provider
    sources["llm.default.provider"] = {
      value: data.llm.default.provider,
      source: "file",
      detail: "file:.bollard.yml",
    }
  }
  if (data.llm?.default?.model) {
    config.llm.default.model = data.llm.default.model
    sources["llm.default.model"] = {
      value: data.llm.default.model,
      source: "file",
      detail: "file:.bollard.yml",
    }
  }
  if (data.llm?.agents) {
    config.llm.agents = data.llm.agents
  }
  if (data.agent?.max_cost_usd !== undefined) {
    config.agent.max_cost_usd = data.agent.max_cost_usd
    sources["agent.max_cost_usd"] = {
      value: data.agent.max_cost_usd,
      source: "file",
      detail: "file:.bollard.yml",
    }
  }
  if (data.agent?.max_duration_minutes !== undefined) {
    config.agent.max_duration_minutes = data.agent.max_duration_minutes
    sources["agent.max_duration_minutes"] = {
      value: data.agent.max_duration_minutes,
      source: "file",
      detail: "file:.bollard.yml",
    }
  }

  return data.toolchain
}

function applyEnvVars(
  config: BollardConfig,
  sources: Record<string, AnnotatedValue<unknown>>,
): void {
  if (process.env["BOLLARD_MODEL"]) {
    config.llm.default.model = process.env["BOLLARD_MODEL"]
    sources["llm.default.model"] = {
      value: process.env["BOLLARD_MODEL"],
      source: "env",
      detail: "env:BOLLARD_MODEL",
    }
  }
  if (process.env["BOLLARD_MAX_COST"]) {
    const cost = Number(process.env["BOLLARD_MAX_COST"])
    if (!Number.isNaN(cost)) {
      config.agent.max_cost_usd = cost
      sources["agent.max_cost_usd"] = {
        value: cost,
        source: "env",
        detail: "env:BOLLARD_MAX_COST",
      }
    }
  }
  if (process.env["BOLLARD_MAX_DURATION"]) {
    const dur = Number(process.env["BOLLARD_MAX_DURATION"])
    if (!Number.isNaN(dur)) {
      config.agent.max_duration_minutes = dur
      sources["agent.max_duration_minutes"] = {
        value: dur,
        source: "env",
        detail: "env:BOLLARD_MAX_DURATION",
      }
    }
  }
}
