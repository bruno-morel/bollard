import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
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
  })
  .strict()

const DEFAULTS: BollardConfig = {
  llm: { default: { provider: "anthropic", model: "claude-sonnet-4-20250514" } },
  agent: { max_cost_usd: 50, max_duration_minutes: 30 },
}

export interface ResolvedConfig {
  config: BollardConfig
  sources: Record<string, AnnotatedValue<unknown>>
}

export function resolveConfig(
  cliFlags?: Partial<BollardConfig>,
  cwd: string = process.cwd(),
): ResolvedConfig {
  const config: BollardConfig = structuredClone(DEFAULTS)
  const sources: Record<string, AnnotatedValue<unknown>> = {
    "llm.default.provider": { value: DEFAULTS.llm.default.provider, source: "default" },
    "llm.default.model": { value: DEFAULTS.llm.default.model, source: "default" },
    "agent.max_cost_usd": { value: DEFAULTS.agent.max_cost_usd, source: "default" },
    "agent.max_duration_minutes": { value: DEFAULTS.agent.max_duration_minutes, source: "default" },
  }

  autoDetect(cwd, sources)
  loadBollardYaml(cwd, config, sources)
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

  if (!process.env["ANTHROPIC_API_KEY"] && !process.env["OPENAI_API_KEY"]) {
    throw new BollardError({
      code: "CONFIG_INVALID",
      message:
        "No LLM API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable.",
    })
  }

  return { config, sources }
}

function autoDetect(cwd: string, sources: Record<string, AnnotatedValue<unknown>>): void {
  const detections: Record<string, boolean> = {
    typescript: existsSync(join(cwd, "tsconfig.json")),
    biome: existsSync(join(cwd, "biome.json")),
    vitest: existsSync(join(cwd, "vitest.config.ts")),
    pnpm: existsSync(join(cwd, "pnpm-lock.yaml")),
  }

  for (const [tool, detected] of Object.entries(detections)) {
    if (detected) {
      sources[`detected.${tool}`] = { value: true, source: "auto-detected" }
    }
  }
}

function loadBollardYaml(
  cwd: string,
  config: BollardConfig,
  sources: Record<string, AnnotatedValue<unknown>>,
): void {
  const yamlPath = join(cwd, ".bollard.yml")
  if (!existsSync(yamlPath)) return

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
