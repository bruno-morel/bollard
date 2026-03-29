import { createCoderAgent } from "@bollard/agents/src/coder.js"
import { executeAgent } from "@bollard/agents/src/executor.js"
import { createPlannerAgent } from "@bollard/agents/src/planner.js"
import type { AgentContext } from "@bollard/agents/src/types.js"
import type { BlueprintNode, NodeResult } from "@bollard/engine/src/blueprint.js"
import type { BollardConfig, PipelineContext } from "@bollard/engine/src/context.js"
import { LLMClient } from "@bollard/llm/src/client.js"

function parsePlanResponse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // LLMs often wrap JSON in markdown fences — strip them and retry
    const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1])
      } catch {
        return { raw: text }
      }
    }
    return { raw: text }
  }
}

export async function createAgenticHandler(
  config: BollardConfig,
  workDir: string,
): Promise<(node: BlueprintNode, ctx: PipelineContext) => Promise<NodeResult>> {
  const llmClient = new LLMClient(config)
  const agents = {
    planner: await createPlannerAgent(),
    coder: await createCoderAgent(),
  }

  return async (node: BlueprintNode, ctx: PipelineContext): Promise<NodeResult> => {
    const agentRole = node.agent ?? "default"
    const agent = agents[agentRole as keyof typeof agents]

    if (!agent) {
      const { provider, model } = llmClient.forAgent(agentRole)
      const startMs = Date.now()
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

    const { provider, model } = llmClient.forAgent(agentRole)
    const agentCtx: AgentContext = {
      pipelineCtx: ctx,
      workDir,
    }

    let userMessage = `Task: ${ctx.task}`
    if (agentRole === "coder" && ctx.plan) {
      userMessage = `Task: ${ctx.task}\n\nApproved Plan:\n${JSON.stringify(ctx.plan, null, 2)}`
    }

    const startMs = Date.now()
    const result = await executeAgent(agent, userMessage, provider, model, agentCtx)

    if (agentRole === "planner") {
      ctx.plan = parsePlanResponse(result.response)
    }

    return {
      status: "ok",
      data: result.response,
      cost_usd: result.totalCostUsd,
      duration_ms: Date.now() - startMs,
    }
  }
}
