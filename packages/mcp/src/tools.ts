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
  const { detectToolchain } = await import("@bollard/detect/src/detect.js")
  return detectToolchain(dir)
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
    description: "Detect and show the toolchain profile for the workspace",
    inputSchema: zodToJsonSchema(profileInputSchema),
    handler: handleProfile,
  },
]
