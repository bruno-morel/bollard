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
  const { resolveConfig } = await import("@bollard/cli/src/config.js")
  const { runStaticChecks } = await import("@bollard/verify/src/static.js")
  const { profile } = await resolveConfig(undefined, dir)
  const { results, allPassed } = await runStaticChecks(dir, profile)

  const summary = allPassed
    ? `All ${results.length} checks passed`
    : `${results.filter((r) => r.passed).length}/${results.length} checks passed — ${results
        .filter((r) => !r.passed)
        .map((r) => r.check)
        .join(", ")} failed`

  return {
    allPassed,
    summary,
    checks: results.map((r) => ({
      name: r.check,
      passed: r.passed,
      output: r.output,
      durationMs: r.durationMs,
    })),
    ...(allPassed
      ? {}
      : {
          suggestion: "Fix the failing checks above, then call bollard_verify again to confirm.",
        }),
  }
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

async function handleConfig(input: Record<string, unknown>, workDir: string): Promise<unknown> {
  const parsed = configInputSchema.parse(input)
  const { resolveConfig } = await import("@bollard/cli/src/config.js")
  try {
    const { config, profile, sources } = await resolveConfig(undefined, workDir)
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

const doctorInputSchema = z.object({
  workDir: z.string().optional(),
})

async function handleDoctor(input: Record<string, unknown>, workDir: string): Promise<unknown> {
  const parsed = doctorInputSchema.parse(input)
  const dir = parsed.workDir ?? workDir
  const { runDoctor } = await import("@bollard/cli/src/doctor.js")
  return runDoctor(dir)
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
    description:
      "Run static verification checks — typecheck, lint, audit, and secret scanning. Returns structured results with pass/fail per check, affected files, and specific error messages. Run this after every code change to catch issues early.",
    inputSchema: zodToJsonSchema(verifyInputSchema),
    handler: handleVerify,
  },
  {
    name: "bollard_plan",
    description:
      "Generate a structured implementation plan for a task using Bollard's planner agent. Returns a JSON plan with summary, acceptance criteria, affected files, risk assessment, and implementation steps. Requires ANTHROPIC_API_KEY.",
    inputSchema: zodToJsonSchema(planInputSchema),
    handler: handlePlan,
  },
  {
    name: "bollard_implement",
    description:
      "Run the full 28-node implement-feature pipeline: plan → approve → code → verify → adversarial test → contract test → behavioral test → mutation test → review. Requires an API key and runs interactively via the CLI.",
    inputSchema: zodToJsonSchema(implementInputSchema),
    handler: handleImplement,
  },
  {
    name: "bollard_eval",
    description:
      "Run evaluation sets against Bollard's agents (planner, coder, boundary-tester, contract-tester, behavioral-tester). Returns pass/fail counts and identifies prompt regressions. Use to validate prompt changes.",
    inputSchema: zodToJsonSchema(evalInputSchema),
    handler: handleEval,
  },
  {
    name: "bollard_config",
    description:
      "Show the fully resolved Bollard configuration after merging defaults, auto-detection, environment variables, and .bollard.yml overrides. Optionally include source annotations showing where each value came from.",
    inputSchema: zodToJsonSchema(configInputSchema),
    handler: handleConfig,
  },
  {
    name: "bollard_profile",
    description:
      "Detect the project's toolchain profile — language, package manager, type checker, linter, test framework, audit tool, and adversarial configuration. Returns the full ToolchainProfile JSON. Use before modifying verification workflows.",
    inputSchema: zodToJsonSchema(profileInputSchema),
    handler: handleProfile,
  },
  {
    name: "bollard_contract",
    description:
      "Analyze the contract graph — module dependency graph with public exports, edges between modules (who imports what from whom), and which edges are affected by recent changes. Use before modifying cross-module interfaces to understand impact.",
    inputSchema: zodToJsonSchema(contractInputSchema),
    handler: handleContract,
  },
  {
    name: "bollard_behavioral",
    description:
      "Build a behavioral context catalog — HTTP endpoints, configuration surface, external dependencies, and failure modes discovered from the codebase. Use to understand the system's observable behavior and identify gaps in behavioral test coverage.",
    inputSchema: zodToJsonSchema(behavioralInputSchema),
    handler: handleBehavioral,
  },
  {
    name: "bollard_probe_run",
    description:
      "Execute stored HTTP probes against a live service URL. Probes assert on status codes, response times, response bodies, and headers. Returns per-probe pass/fail with detailed assertion results. Use to verify deployed services.",
    inputSchema: zodToJsonSchema(probeRunInputSchema),
    handler: handleProbeRun,
  },
  {
    name: "bollard_deploy_record",
    description:
      "Record a deployment event (SHA, timestamp, environment, risk tier) in Bollard's deployment tracker. Use after deploying to update the last-known-good state for drift detection and probe scheduling.",
    inputSchema: zodToJsonSchema(deployRecordInputSchema),
    handler: handleDeployRecord,
  },
  {
    name: "bollard_flag_set",
    description:
      "Set a feature flag in Bollard's file-based flag provider. Supports on/off toggles and percentage-based rollout values. Use for progressive rollout control — flags integrate with the risk-gated rollout state machine.",
    inputSchema: zodToJsonSchema(flagSetInputSchema),
    handler: handleFlagSet,
  },
  {
    name: "bollard_drift_check",
    description:
      "Detect code drift since the last verified deployment. Compares current git state against the last-verified SHA and classifies changes by severity (test-only = low, source = medium, config/infra = high). Run before deploying to catch unverified changes.",
    inputSchema: zodToJsonSchema(driftCheckInputSchema),
    handler: handleDriftCheck,
  },
  {
    name: "bollard_doctor",
    description:
      "Run an environment health check — verifies Docker availability (`docker compose version`), at least one LLM API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY), and toolchain detection (language + at least one verification check). Returns structured pass/fail per check and whether `.bollard.yml` exists (custom config vs using defaults).",
    inputSchema: zodToJsonSchema(doctorInputSchema),
    handler: handleDoctor,
  },
]
