import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { detectToolchain } from "@bollard/detect/src/detect.js"
import type {
  MutationToolId,
  ToolchainProfile,
  VerificationCommand,
} from "@bollard/detect/src/types.js"
import { DEFAULT_METRICS_CONFIG } from "@bollard/detect/src/types.js"
import type {
  BollardConfig,
  CiPlatformId,
  LocalModelsConfig,
  TakeoverModeConfig,
} from "@bollard/engine/src/context.js"
import { BollardError } from "@bollard/engine/src/errors.js"
import { resolveModelForRole } from "@bollard/llm/src/model-registry.js"
import { isBinaryAvailable } from "@bollard/llm/src/providers/local.js"
import { ROLE_REQUIREMENTS } from "@bollard/llm/src/role-requirements.js"
import type { ObserveProviderConfig } from "@bollard/observe/src/providers/types.js"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import { applyRootAdversarialYaml, type RootAdversarialYaml } from "./adversarial-yaml.js"

export type ConfigSource =
  | "default"
  | "auto-detected"
  | "env"
  | "file"
  | "cli"
  | "capability-resolved"

export interface AnnotatedValue<T> {
  value: T
  source: ConfigSource
  detail?: string
  warning?: string
}

const verificationCommandSchema = z.object({
  cmd: z.string(),
  args: z.array(z.string()).optional(),
})

const concernWeightSchema = z.enum(["high", "medium", "low", "off"])

const concernsPartialSchema = z
  .object({
    correctness: concernWeightSchema.optional(),
    security: concernWeightSchema.optional(),
    performance: concernWeightSchema.optional(),
    resilience: concernWeightSchema.optional(),
  })
  .strict()

const adversarialScopeBlockSchema = z
  .object({
    enabled: z.boolean().optional(),
    integration: z.enum(["integrated", "independent"]).optional(),
    lifecycle: z.enum(["ephemeral", "persistent"]).optional(),
    mode: z.enum(["blackbox", "in-language", "both"]).optional(),
    runtime_image: z.string().optional(),
    framework_capable: z.boolean().optional(),
    concerns: concernsPartialSchema.optional(),
  })
  .strict()

const rootAdversarialYamlSchema = z
  .object({
    concerns: concernsPartialSchema.optional(),
    boundary: adversarialScopeBlockSchema.optional(),
    contract: adversarialScopeBlockSchema.optional(),
    behavioral: adversarialScopeBlockSchema.optional(),
  })
  .strict()

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

const observeSlotSchema = z
  .object({
    provider: z.string().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const observeYamlSchema = z
  .object({
    probes: observeSlotSchema.optional(),
    flags: observeSlotSchema.optional(),
    deployments: observeSlotSchema.optional(),
    drift: observeSlotSchema.optional(),
    metrics: observeSlotSchema
      .extend({
        retentionDays: z.number().optional(),
      })
      .optional(),
    baseUrl: z.string().optional(),
  })
  .strict()

// ─── Stage 6: Lifecycle Ownership (Takeover Mode) ────────────────────────────

const ciPlatformSchema = z.enum(["github-actions", "gitlab-ci", "circleci", "buildkite"])

const takeoverDomainSchema = z
  .object({
    enabled: z.boolean().optional(),
    trust: z.enum(["review", "auto-commit", "silent"]).optional(),
  })
  .strict()

const takeoverYamlSchema = z
  .object({
    tests: takeoverDomainSchema
      .extend({
        minMutationScoreToTrigger: z.number().min(0).max(100).optional(),
        maxFilesPerCycle: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    ci: takeoverDomainSchema
      .extend({
        platforms: z.array(ciPlatformSchema).optional(),
      })
      .strict()
      .optional(),
    deps: takeoverDomainSchema
      .extend({
        securityOnly: z.boolean().optional(),
      })
      .strict()
      .optional(),
    docs: takeoverDomainSchema.optional(),
    monitoring: takeoverDomainSchema.optional(),
  })
  .strict()

// ─────────────────────────────────────────────────────────────────────────────

const localModelsYamlSchema = z
  .object({
    minFreeRamGb: z.number().positive().optional(),
    timeoutSec: z.number().positive().optional(),
    cacheDir: z.string().min(1).optional(),
    cacheSizeGb: z.number().positive().optional(),
    registryUrl: z.string().min(1).optional(),
    patcherModel: z.string().min(1).optional(),
  })
  .strict()

const metricsYamlSchema = z
  .object({
    coverage: z
      .object({
        enabled: z.boolean().optional(),
        thresholdPct: z.number().optional(),
      })
      .strict()
      .optional(),
    complexity: z
      .object({
        enabled: z.boolean().optional(),
        hotspotThreshold: z.number().optional(),
      })
      .strict()
      .optional(),
    sast: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
    churn: z
      .object({
        enabled: z.boolean().optional(),
        highThreshold: z.number().optional(),
      })
      .strict()
      .optional(),
    probePerf: z
      .object({
        enabled: z.boolean().optional(),
        windowResults: z.number().optional(),
      })
      .strict()
      .optional(),
    loadTest: z
      .object({
        enabled: z.boolean().optional(),
        vus: z.number().optional(),
        durationSec: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

const docsYamlSchema = z
  .object({
    homes: z.array(z.string()).optional(),
  })
  .strict()

const bollardYamlSchema = z
  .object({
    llm: z
      .object({
        default: z
          .object({ provider: z.string().optional(), model: z.string().optional() })
          .optional(),
        agents: z
          .record(z.string(), z.object({ provider: z.string(), model: z.string() }))
          .optional(),
        agentBudgets: z.record(z.string(), z.number().positive()).optional(),
      })
      .optional(),
    agent: z
      .object({
        max_cost_usd: z.number().optional(),
        max_duration_minutes: z.number().optional(),
      })
      .optional(),
    risk: z.record(z.string(), z.unknown()).optional(),
    toolchain: toolchainYamlSchema.optional(),
    adversarial: rootAdversarialYamlSchema.optional(),
    mutation: z
      .object({
        enabled: z.boolean().optional(),
        tool: z.string().optional(),
        threshold: z.number().optional(),
        timeoutMs: z.number().optional(),
        concurrency: z.number().optional(),
      })
      .optional(),
    metrics: metricsYamlSchema.optional(),
    observe: observeYamlSchema.optional(),
    localModels: localModelsYamlSchema.optional(),
    takeover: takeoverYamlSchema.optional(),
    docs: docsYamlSchema.optional(),
  })
  .strict()

/**
 * Per-agent LLM defaults are derived from role requirements × model registry
 * (Stage 5e Phase 5). Override per role via `.bollard.yml` `llm.agents`.
 * Sonnet: creative multi-step implementation (coder) and fallback for unknown roles.
 */
const DEFAULTS: BollardConfig = {
  llm: {
    default: { provider: "anthropic", model: "claude-sonnet-4-6" },
  },
  agent: { max_cost_usd: 50, max_duration_minutes: 30 },
}

export interface ResolvedConfig {
  config: BollardConfig
  profile: ToolchainProfile
  sources: Record<string, AnnotatedValue<unknown>>
  observe?: ObserveProviderConfig
}

export interface ResolveConfigOptions {
  /** When false, static-only commands (verify, watch) may run without LLM API keys. Default true. */
  requireApiKey?: boolean
}

export async function resolveConfig(
  cliFlags?: Partial<BollardConfig>,
  cwd: string = process.cwd(),
  options?: ResolveConfigOptions,
): Promise<ResolvedConfig> {
  const requireApiKey = options?.requireApiKey !== false
  const config: BollardConfig = structuredClone(DEFAULTS)
  const sources: Record<string, AnnotatedValue<unknown>> = {
    "llm.default.provider": { value: DEFAULTS.llm.default.provider, source: "default" },
    "llm.default.model": { value: DEFAULTS.llm.default.model, source: "default" },
    "agent.max_cost_usd": { value: DEFAULTS.agent.max_cost_usd, source: "default" },
    "agent.max_duration_minutes": { value: DEFAULTS.agent.max_duration_minutes, source: "default" },
  }

  const profile = await detectToolchain(cwd)
  populateDetectionSources(cwd, profile, sources)

  const yamlResult = loadBollardYaml(cwd, config, sources)
  const observeFromYaml = yamlResult?.observe
  if (yamlResult?.adversarial) {
    applyRootAdversarialYaml(profile, yamlResult.adversarial as RootAdversarialYaml)
  }
  if (yamlResult?.toolchain) {
    applyToolchainOverrides(profile, yamlResult.toolchain, {
      skipLegacyAdversarial: Boolean(yamlResult.adversarial),
    })
  }
  if (yamlResult?.mutation) {
    const ym = yamlResult.mutation
    const tool = typeof ym.tool === "string" ? ym.tool : "stryker"
    profile.mutation = {
      enabled: ym.enabled !== false,
      tool: tool as MutationToolId,
      threshold: typeof ym.threshold === "number" ? ym.threshold : 80,
      timeoutMs: typeof ym.timeoutMs === "number" ? ym.timeoutMs : 300_000,
      concurrency: typeof ym.concurrency === "number" ? ym.concurrency : 2,
    }
  }
  applyMetricsConfig(profile, yamlResult?.metrics)
  applyTakeoverConfig(config, yamlResult?.takeover, sources)
  applyDocsConfig(config, yamlResult?.docs, sources)

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

  for (const [role, assignment] of Object.entries(config.llm.agents ?? {})) {
    const isOverridden = yamlResult?.overriddenAgentRoles?.has(role) ?? false
    sources[`llm.agents.${role}.provider`] = {
      value: assignment.provider,
      source: isOverridden ? "file" : "default",
      ...(isOverridden ? { detail: "file:.bollard.yml" as const } : {}),
    }
    sources[`llm.agents.${role}.model`] = {
      value: assignment.model,
      source: isOverridden ? "file" : "default",
      ...(isOverridden ? { detail: "file:.bollard.yml" as const } : {}),
    }
  }

  for (const role of Object.keys(ROLE_REQUIREMENTS)) {
    const modelKey = `llm.agents.${role}.model`
    if (sources[modelKey] !== undefined) continue

    try {
      const entry = resolveModelForRole(role, config.llm.default.provider)
      if (entry === undefined) continue
      sources[`llm.agents.${role}.provider`] = {
        value: entry.provider,
        source: "capability-resolved",
      }
      sources[modelKey] = {
        value: entry.id,
        source: "capability-resolved",
      }
    } catch (err) {
      if (BollardError.hasCode(err, "MODEL_NOT_AVAILABLE")) {
        process.stderr.write(
          `[bollard] warning: no model available for role "${role}" with provider "${config.llm.default.provider}"\n`,
        )
        continue
      }
      throw err
    }
  }

  if (
    requireApiKey &&
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

  const localAgents = Object.entries(config.llm.agents ?? {})
    .filter(([, v]) => v.provider === "local")
    .map(([k]) => k)

  if (localAgents.length > 0) {
    const available = await isBinaryAvailable()
    if (!available) {
      sources["localModels.binary"] = {
        value: false,
        source: "auto-detected",
        warning: `provider: local configured for agents [${localAgents.join(", ")}] but llama-cli binary not found on PATH. Build the dev-local image: docker compose --profile local build dev-local`,
      }
    }
  }

  return {
    config,
    profile,
    sources,
    ...(observeFromYaml !== undefined ? { observe: observeFromYaml } : {}),
  }
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
  opts?: { skipLegacyAdversarial?: boolean },
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

  if (!opts?.skipLegacyAdversarial && overrides.adversarial) {
    if (overrides.adversarial.mode) {
      profile.adversarial.boundary.mode = overrides.adversarial.mode
    }
    if (overrides.adversarial.runtime_image) {
      profile.adversarial.boundary.runtimeImage = overrides.adversarial.runtime_image
    }
    if (overrides.adversarial.persist !== undefined) {
      profile.adversarial.boundary.lifecycle = overrides.adversarial.persist
        ? "persistent"
        : "ephemeral"
    }
  }
}

interface LoadedBollardYaml {
  toolchain?: z.infer<typeof toolchainYamlSchema>
  adversarial?: z.infer<typeof rootAdversarialYamlSchema>
  mutation?: {
    enabled?: boolean | undefined
    tool?: string | undefined
    threshold?: number | undefined
    timeoutMs?: number | undefined
    concurrency?: number | undefined
  }
  observe?: ObserveProviderConfig
  metrics?: z.infer<typeof metricsYamlSchema>
  takeover?: z.infer<typeof takeoverYamlSchema>
  docs?: z.infer<typeof docsYamlSchema>
  /** Roles whose `llm.agents.<role>` came from `.bollard.yml` (keys of parsed `llm.agents`, not post-merge). */
  overriddenAgentRoles?: Set<string>
}

function applyMetricsConfig(
  profile: ToolchainProfile,
  metricsYaml?: z.infer<typeof metricsYamlSchema>,
): void {
  profile.metrics = {
    coverage: {
      enabled: metricsYaml?.coverage?.enabled ?? DEFAULT_METRICS_CONFIG.coverage.enabled,
      thresholdPct:
        metricsYaml?.coverage?.thresholdPct ?? DEFAULT_METRICS_CONFIG.coverage.thresholdPct,
    },
    complexity: {
      enabled: metricsYaml?.complexity?.enabled ?? DEFAULT_METRICS_CONFIG.complexity.enabled,
      hotspotThreshold:
        metricsYaml?.complexity?.hotspotThreshold ??
        DEFAULT_METRICS_CONFIG.complexity.hotspotThreshold,
    },
    sast: {
      enabled: metricsYaml?.sast?.enabled ?? DEFAULT_METRICS_CONFIG.sast.enabled,
    },
    churn: {
      enabled: metricsYaml?.churn?.enabled ?? DEFAULT_METRICS_CONFIG.churn.enabled,
      highThreshold:
        metricsYaml?.churn?.highThreshold ?? DEFAULT_METRICS_CONFIG.churn.highThreshold,
    },
    probePerf: {
      enabled: metricsYaml?.probePerf?.enabled ?? DEFAULT_METRICS_CONFIG.probePerf.enabled,
      windowResults:
        metricsYaml?.probePerf?.windowResults ?? DEFAULT_METRICS_CONFIG.probePerf.windowResults,
    },
    loadTest: {
      enabled: metricsYaml?.loadTest?.enabled ?? DEFAULT_METRICS_CONFIG.loadTest.enabled,
      vus: metricsYaml?.loadTest?.vus ?? DEFAULT_METRICS_CONFIG.loadTest.vus,
      durationSec:
        metricsYaml?.loadTest?.durationSec ?? DEFAULT_METRICS_CONFIG.loadTest.durationSec,
    },
  }
}

function applyTakeoverConfig(
  config: BollardConfig,
  takeoverYaml: z.infer<typeof takeoverYamlSchema> | undefined,
  sources: Record<string, AnnotatedValue<unknown>>,
): void {
  if (takeoverYaml === undefined) return

  const takeover: TakeoverModeConfig = {}

  if (takeoverYaml.tests !== undefined) {
    takeover.tests = {
      enabled: takeoverYaml.tests.enabled ?? false,
      trust: takeoverYaml.tests.trust ?? "review",
      minMutationScoreToTrigger: takeoverYaml.tests.minMutationScoreToTrigger ?? 0,
      maxFilesPerCycle: takeoverYaml.tests.maxFilesPerCycle ?? 5,
    }
  }
  if (takeoverYaml.ci !== undefined) {
    takeover.ci = {
      enabled: takeoverYaml.ci.enabled ?? false,
      trust: takeoverYaml.ci.trust ?? "review",
      ...(takeoverYaml.ci.platforms !== undefined
        ? { platforms: takeoverYaml.ci.platforms as CiPlatformId[] }
        : {}),
    }
  }
  if (takeoverYaml.deps !== undefined) {
    takeover.deps = {
      enabled: takeoverYaml.deps.enabled ?? false,
      trust: takeoverYaml.deps.trust ?? "review",
      securityOnly: takeoverYaml.deps.securityOnly ?? true,
    }
  }
  if (takeoverYaml.docs !== undefined) {
    takeover.docs = {
      enabled: takeoverYaml.docs.enabled ?? false,
      trust: takeoverYaml.docs.trust ?? "review",
    }
  }
  if (takeoverYaml.monitoring !== undefined) {
    takeover.monitoring = {
      enabled: takeoverYaml.monitoring.enabled ?? false,
      trust: takeoverYaml.monitoring.trust ?? "review",
    }
  }

  config.takeover = takeover
  sources["takeover"] = { value: takeover, source: "file", detail: "file:.bollard.yml" }
}

function applyDocsConfig(
  config: BollardConfig,
  docsYaml: z.infer<typeof docsYamlSchema> | undefined,
  sources: Record<string, AnnotatedValue<unknown>>,
): void {
  if (docsYaml === undefined) return

  config.docs = {
    ...(docsYaml.homes !== undefined ? { homes: docsYaml.homes } : {}),
  }
  if (docsYaml.homes !== undefined) {
    sources["docs.homes"] = {
      value: docsYaml.homes,
      source: "file",
      detail: "file:.bollard.yml",
    }
  }
}

function loadBollardYaml(
  cwd: string,
  config: BollardConfig,
  sources: Record<string, AnnotatedValue<unknown>>,
): LoadedBollardYaml | undefined {
  const yamlPath = join(cwd, ".bollard.yml")
  if (!existsSync(yamlPath)) return undefined

  const raw = readFileSync(yamlPath, "utf-8")
  const parsed: unknown = parseYaml(raw)
  const result = bollardYamlSchema.safeParse(parsed)

  if (!result.success) {
    const msg = result.error.message
    const hasAdversarialKey =
      parsed !== null &&
      typeof parsed === "object" &&
      "adversarial" in (parsed as Record<string, unknown>)
    throw new BollardError({
      code: hasAdversarialKey ? "CONCERN_CONFIG_INVALID" : "CONFIG_INVALID",
      message: `Invalid .bollard.yml: ${msg}`,
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
  const overriddenAgentRoles =
    data.llm?.agents !== undefined ? new Set(Object.keys(data.llm.agents)) : undefined
  if (data.llm?.agents) {
    config.llm.agents = { ...config.llm.agents, ...data.llm.agents }
  }
  if (data.llm?.agentBudgets) {
    config.llm.agentBudgets = { ...(config.llm.agentBudgets ?? {}), ...data.llm.agentBudgets }
    sources["llm.agentBudgets"] = {
      value: config.llm.agentBudgets,
      source: "file",
      detail: "file:.bollard.yml",
    }
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
  if (data.localModels !== undefined) {
    config.localModels = data.localModels as Partial<LocalModelsConfig>
    sources["localModels"] = {
      value: data.localModels,
      source: "file",
      detail: "file:.bollard.yml",
    }
  }

  return {
    ...(data.toolchain !== undefined ? { toolchain: data.toolchain } : {}),
    ...(data.adversarial !== undefined ? { adversarial: data.adversarial } : {}),
    ...(data.mutation !== undefined ? { mutation: data.mutation } : {}),
    ...(data.observe !== undefined ? { observe: data.observe as ObserveProviderConfig } : {}),
    ...(data.metrics !== undefined ? { metrics: data.metrics } : {}),
    ...(data.takeover !== undefined ? { takeover: data.takeover } : {}),
    ...(data.docs !== undefined ? { docs: data.docs } : {}),
    ...(overriddenAgentRoles !== undefined ? { overriddenAgentRoles } : {}),
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
