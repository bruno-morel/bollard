import { z } from "zod"

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (input: Record<string, unknown>, workDir: string) => Promise<unknown>
}

const verifyInputSchema = z.object({
  workDir: z.string().optional(),
})

const planInputSchema = z.object({
  task: z.string(),
  workDir: z.string().optional(),
})

const implementInputSchema = z.object({
  task: z.string(),
  workDir: z.string().optional(),
})

const evalInputSchema = z.object({
  agent: z.string().optional(),
})

const configInputSchema = z.object({
  showSources: z.boolean().optional(),
})

const profileInputSchema = z.object({
  workDir: z.string().optional(),
})

async function handleVerify(input: Record<string, unknown>, workDir: string): Promise<unknown> {
  const parsed = verifyInputSchema.parse(input)
  const dir = parsed.workDir ?? workDir
  const { runStaticChecks } = await import("@bollard/verify/src/static.js")
  return runStaticChecks(dir)
}

async function handlePlan(input: Record<string, unknown>, _workDir: string): Promise<unknown> {
  const parsed = planInputSchema.parse(input)
  return {
    status: "ok",
    message: `Plan requested for task: ${parsed.task}`,
    note: "Full planner agent requires ANTHROPIC_API_KEY and runs via the CLI",
  }
}

async function handleImplement(input: Record<string, unknown>, _workDir: string): Promise<unknown> {
  const parsed = implementInputSchema.parse(input)
  return {
    status: "ok",
    message: `Implementation requested for task: ${parsed.task}`,
    note: "Full implement-feature pipeline requires API key and runs via the CLI",
  }
}

async function handleEval(input: Record<string, unknown>, _workDir: string): Promise<unknown> {
  const parsed = evalInputSchema.parse(input)
  const { loadEvalCases, availableAgents } = await import("@bollard/agents/src/eval-loader.js")
  const cases = loadEvalCases(parsed.agent)
  return {
    caseCount: cases.length,
    availableAgents: availableAgents(),
    agent: parsed.agent ?? "all",
  }
}

async function handleConfig(input: Record<string, unknown>, _workDir: string): Promise<unknown> {
  const parsed = configInputSchema.parse(input)
  const { resolveConfig } = await import("@bollard/cli/src/config.js")
  try {
    const { config, profile, sources } = await resolveConfig()
    return parsed.showSources ? { config, profile, sources } : config
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

async function handleProfile(input: Record<string, unknown>, workDir: string): Promise<unknown> {
  const parsed = profileInputSchema.parse(input)
  const dir = parsed.workDir ?? workDir
  const { resolveConfig } = await import("@bollard/cli/src/config.js")
  const { profile } = await resolveConfig(undefined, dir)
  return profile
}

const contractInputSchema = z.object({
  workDir: z.string().optional(),
  plan: z.string().optional(),
})

async function handleContract(input: Record<string, unknown>, workDir: string): Promise<unknown> {
  const parsed = contractInputSchema.parse(input)
  const dir = parsed.workDir ?? workDir
  const plan = parsed.plan?.trim() ? (JSON.parse(parsed.plan) as unknown) : undefined
  const { resolveConfig } = await import("@bollard/cli/src/config.js")
  const { collectAffectedPathsFromPlan } = await import("@bollard/cli/src/contract-plan.js")
  const { buildContractContext } = await import("@bollard/verify/src/contract-extractor.js")
  const { profile } = await resolveConfig(undefined, dir)
  const affected = collectAffectedPathsFromPlan(plan)
  return buildContractContext(affected, profile, dir)
}

const behavioralInputSchema = z.object({
  workDir: z.string().optional(),
})

async function handleBehavioral(input: Record<string, unknown>, workDir: string): Promise<unknown> {
  const parsed = behavioralInputSchema.parse(input)
  const dir = parsed.workDir ?? workDir
  const { resolveConfig } = await import("@bollard/cli/src/config.js")
  const { buildBehavioralContext } = await import("@bollard/verify/src/behavioral-extractor.js")
  const { profile } = await resolveConfig(undefined, dir)
  return buildBehavioralContext(profile, dir)
}

const probeRunInputSchema = z.object({
  workDir: z.string().optional(),
  url: z.string().optional(),
  probeId: z.string().optional(),
})

async function handleProbeRun(input: Record<string, unknown>, workDir: string): Promise<unknown> {
  const parsed = probeRunInputSchema.parse(input)
  const dir = parsed.workDir ?? workDir
  const { resolveConfig } = await import("@bollard/cli/src/config.js")
  const { resolveProviders } = await import("@bollard/observe/src/providers/resolve.js")
  const { DefaultProbeScheduler } = await import("@bollard/observe/src/probe-scheduler.js")
  const { observe } = await resolveConfig(undefined, dir)
  const providers = resolveProviders(observe, dir)
  const baseUrl =
    parsed.url ??
    providers.options.baseUrl ??
    process.env["BOLLARD_PROBE_BASE_URL"] ??
    "http://127.0.0.1:3000"
  const scheduler = new DefaultProbeScheduler({ workDir: dir, executor: providers.probeExecutor })
  const all = await scheduler.loadProbes()
  const probes = parsed.probeId ? all.filter((p) => p.id === parsed.probeId) : all
  const results = []
  for (const probe of probes) {
    const r = await providers.probeExecutor.execute(probe, baseUrl)
    await providers.metricsStore.record(r)
    results.push(r)
  }
  return { baseUrl, results }
}

const deployRecordInputSchema = z.object({
  workDir: z.string().optional(),
  sha: z.string().optional(),
  environment: z.string().optional(),
})

async function handleDeployRecord(
  input: Record<string, unknown>,
  workDir: string,
): Promise<unknown> {
  const parsed = deployRecordInputSchema.parse(input)
  const dir = parsed.workDir ?? workDir
  const { resolveConfig } = await import("@bollard/cli/src/config.js")
  const { resolveProviders } = await import("@bollard/observe/src/providers/resolve.js")
  const { observe } = await resolveConfig(undefined, dir)
  const { deploymentTracker } = resolveProviders(observe, dir)
  const sha = parsed.sha ?? process.env["GITHUB_SHA"] ?? process.env["GIT_SHA"] ?? "unknown"
  const meta = {
    deploymentId: sha,
    timestamp: Date.now(),
    sourceRunIds: [] as string[],
    relatedCommits: [sha],
    environment: parsed.environment ?? "production",
  }
  await deploymentTracker.record(meta)
  return { recorded: meta }
}

const flagSetInputSchema = z.object({
  workDir: z.string().optional(),
  flagId: z.string(),
  value: z.string(),
})

async function handleFlagSet(input: Record<string, unknown>, workDir: string): Promise<unknown> {
  const parsed = flagSetInputSchema.parse(input)
  const dir = parsed.workDir ?? workDir
  const { resolveConfig } = await import("@bollard/cli/src/config.js")
  const { resolveProviders } = await import("@bollard/observe/src/providers/resolve.js")
  const { observe } = await resolveConfig(undefined, dir)
  const { flagProvider } = resolveProviders(observe, dir)
  const val = parsed.value
  let enabled = false
  let percent = 0
  if (val === "on") {
    enabled = true
    percent = 100
  } else if (val === "off") {
    enabled = false
    percent = 0
  } else {
    const n = Number(val.replace(/%$/, ""))
    percent = Number.isNaN(n) ? 0 : Math.min(100, Math.max(0, n))
    enabled = percent > 0
  }
  await flagProvider.set(parsed.flagId, {
    id: parsed.flagId,
    enabled,
    percent,
    updatedAt: Date.now(),
    updatedBy: "human",
  })
  return { flagId: parsed.flagId, enabled, percent }
}

const driftCheckInputSchema = z.object({
  workDir: z.string().optional(),
})

async function handleDriftCheck(input: Record<string, unknown>, workDir: string): Promise<unknown> {
  const parsed = driftCheckInputSchema.parse(input)
  const dir = parsed.workDir ?? workDir
  const { resolveConfig } = await import("@bollard/cli/src/config.js")
  const { resolveProviders } = await import("@bollard/observe/src/providers/resolve.js")
  const { observe } = await resolveConfig(undefined, dir)
  const { driftDetector } = resolveProviders(observe, dir)
  return driftDetector.check()
}

function zodToJsonSchema(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const shape = schema.shape
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const [key, value] of Object.entries(shape)) {
    const zodType = value as z.ZodTypeAny
    const isOptional = zodType.isOptional()
    if (!isOptional) {
      required.push(key)
    }

    const inner =
      isOptional && "unwrap" in zodType
        ? (zodType as z.ZodOptional<z.ZodTypeAny>).unwrap()
        : zodType
    if (inner instanceof z.ZodString) {
      properties[key] = { type: "string" }
    } else if (inner instanceof z.ZodBoolean) {
      properties[key] = { type: "boolean" }
    } else {
      properties[key] = { type: "string" }
    }
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

export const tools: McpToolDefinition[] = [
  {
    name: "bollard_verify",
    description: "Run static verification (typecheck, lint, audit) on the workspace",
    inputSchema: zodToJsonSchema(verifyInputSchema),
    handler: handleVerify,
  },
  {
    name: "bollard_plan",
    description: "Generate a plan for a task using the planner agent",
    inputSchema: zodToJsonSchema(planInputSchema),
    handler: handlePlan,
  },
  {
    name: "bollard_implement",
    description: "Run the full implement-feature pipeline (plan, code, verify, test)",
    inputSchema: zodToJsonSchema(implementInputSchema),
    handler: handleImplement,
  },
  {
    name: "bollard_eval",
    description: "Run agent eval sets to measure prompt quality",
    inputSchema: zodToJsonSchema(evalInputSchema),
    handler: handleEval,
  },
  {
    name: "bollard_config",
    description: "Show resolved Bollard configuration",
    inputSchema: zodToJsonSchema(configInputSchema),
    handler: handleConfig,
  },
  {
    name: "bollard_profile",
    description: "Resolve toolchain profile for the workspace (detection + .bollard.yml)",
    inputSchema: zodToJsonSchema(profileInputSchema),
    handler: handleProfile,
  },
  {
    name: "bollard_contract",
    description: "Build contract-scope context (module graph + edges) as JSON",
    inputSchema: zodToJsonSchema(contractInputSchema),
    handler: handleContract,
  },
  {
    name: "bollard_behavioral",
    description:
      "Build behavioral-scope context (endpoints, config, dependencies, failure modes) as JSON",
    inputSchema: zodToJsonSchema(behavioralInputSchema),
    handler: handleBehavioral,
  },
  {
    name: "bollard_probe_run",
    description: "Execute stored HTTP probes against a base URL and record metrics",
    inputSchema: zodToJsonSchema(probeRunInputSchema),
    handler: handleProbeRun,
  },
  {
    name: "bollard_deploy_record",
    description: "Append a deployment record to the built-in deployment tracker",
    inputSchema: zodToJsonSchema(deployRecordInputSchema),
    handler: handleDeployRecord,
  },
  {
    name: "bollard_flag_set",
    description: "Set a feature flag in the built-in file provider (on|off|percent)",
    inputSchema: zodToJsonSchema(flagSetInputSchema),
    handler: handleFlagSet,
  },
  {
    name: "bollard_drift_check",
    description: "Run git-based drift detection vs last verified SHA",
    inputSchema: zodToJsonSchema(driftCheckInputSchema),
    handler: handleDriftCheck,
  },
]
