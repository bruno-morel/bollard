import type { Blueprint, BlueprintNode, NodeResult } from "@bollard/engine/src/blueprint.js"
import type { PipelineContext } from "@bollard/engine/src/context.js"
import { BollardError } from "@bollard/engine/src/errors.js"
import { runBlueprint } from "@bollard/engine/src/runner.js"
import { LLMClient } from "@bollard/llm/src/client.js"
import { resolveConfig } from "./config.js"

function createAgenticHandler(config: ReturnType<typeof resolveConfig>["config"]) {
  const llmClient = new LLMClient(config)

  return async (node: BlueprintNode, ctx: PipelineContext): Promise<NodeResult> => {
    const agentRole = node.agent ?? "default"
    const startMs = Date.now()

    const { provider, model } = llmClient.forAgent(agentRole)
    const response = await provider.chat({
      system: `You are the "${agentRole}" agent in a Bollard pipeline run.`,
      messages: [
        {
          role: "user",
          content: `Task: ${ctx.task}\nNode: ${node.name}\nBlueprint: ${ctx.blueprintId}`,
        },
      ],
      maxTokens: 1024,
      temperature: 0.3,
      model,
    })

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")

    return {
      status: "ok",
      data: text,
      cost_usd: response.costUsd,
      duration_ms: Date.now() - startMs,
    }
  }
}

const demoBlueprint: Blueprint = {
  id: "demo",
  name: "Demo Blueprint",
  nodes: [
    {
      id: "greet",
      name: "Deterministic Greeting",
      type: "deterministic",
      execute: async (ctx) => {
        ctx.log.info(`Hello from deterministic node! Task: ${ctx.task}`)
        return { status: "ok", data: `Greeted for task: ${ctx.task}` }
      },
    },
    {
      id: "llm-hello",
      name: "Agentic Hello",
      type: "agentic",
      agent: "default",
    },
  ],
  maxCostUsd: 1,
  maxDurationMinutes: 5,
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2)
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs
  const command = args[0]

  if (command === "run") {
    const blueprintName = args[1]
    const taskIdx = args.indexOf("--task")
    const task = taskIdx !== -1 ? args[taskIdx + 1] : undefined

    if (!blueprintName || !task) {
      process.stderr.write("Usage: bollard run <blueprint> --task <task>\n")
      process.exit(1)
    }

    if (blueprintName !== "demo") {
      process.stderr.write("Custom blueprints not yet supported (Stage 1)\n")
      process.exit(1)
    }

    const { config } = resolveConfig()
    const handler = createAgenticHandler(config)
    const result = await runBlueprint(demoBlueprint, task, config, handler)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exit(result.status === "success" ? 0 : 1)
  }

  if (command === "config" && args[1] === "show") {
    const { config, sources } = resolveConfig()
    const showSources = args.includes("--sources")
    const output = showSources ? { config, sources } : config
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
    return
  }

  if (command === "init") {
    const { sources } = resolveConfig()
    process.stdout.write("Detected project configuration:\n")
    for (const [key, val] of Object.entries(sources)) {
      if (val.source === "auto-detected") {
        process.stdout.write(`  ${key}: detected\n`)
      }
    }
    return
  }

  if (command === "eval") {
    const agentFilter = args[1]
    process.stdout.write(
      `${JSON.stringify(
        {
          command: "eval",
          agent: agentFilter ?? "all",
          status: "no_eval_sets",
          message: "No eval sets found. Eval sets are added at Stage 1 alongside agent prompts.",
          usage: "Place eval files in packages/agents/evals/{agent}/*.eval.ts",
        },
        null,
        2,
      )}\n`,
    )
    return
  }

  process.stderr.write("Usage: bollard <run|config show|init|eval> [options]\n")
  process.exit(1)
}

main().catch((err: unknown) => {
  if (BollardError.is(err)) {
    process.stderr.write(`[${err.code}] ${err.message}\n`)
  } else {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  }
  process.exit(1)
})
