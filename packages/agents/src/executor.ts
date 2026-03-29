import { BollardError } from "@bollard/engine/src/errors.js"
import type { LLMContentBlock, LLMMessage, LLMProvider, LLMTool } from "@bollard/llm/src/types.js"
import type { AgentContext, AgentDefinition, AgentResult } from "./types.js"

export async function executeAgent(
  agent: AgentDefinition,
  userMessage: string,
  provider: LLMProvider,
  model: string,
  ctx: AgentContext,
): Promise<AgentResult> {
  const startMs = Date.now()
  let totalCostUsd = 0
  let turns = 0
  const toolCallHistory: AgentResult["toolCalls"] = []

  const llmTools: LLMTool[] = agent.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }))

  const messages: LLMMessage[] = [{ role: "user", content: userMessage }]

  const resolvedMaxTokens = agent.maxTokens ?? 4096

  while (turns < agent.maxTurns) {
    const response = await provider.chat({
      system: agent.systemPrompt,
      messages,
      ...(llmTools.length > 0 ? { tools: llmTools } : {}),
      maxTokens: resolvedMaxTokens,
      temperature: agent.temperature,
      model,
    })

    totalCostUsd += response.costUsd

    const hasToolUseBlocks = response.content.some((b) => b.type === "tool_use")

    if (response.stopReason !== "tool_use" && !hasToolUseBlocks) {
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("")

      return {
        response: text,
        totalCostUsd,
        totalDurationMs: Date.now() - startMs,
        turns,
        toolCalls: toolCallHistory,
      }
    }

    turns++
    const assistantBlocks = response.content
    const toolResults: LLMContentBlock[] = []

    for (const block of assistantBlocks) {
      if (block.type === "tool_use" && block.toolName && block.toolUseId) {
        const inputSummary = JSON.stringify(block.toolInput ?? {}).slice(0, 120)
        process.stderr.write(
          `\x1b[2m  [${agent.role}] turn ${turns}: ${block.toolName}(${inputSummary})\x1b[0m\n`,
        )

        const tool = agent.tools.find((t) => t.name === block.toolName)
        if (!tool) {
          toolResults.push({
            type: "tool_result",
            toolUseId: block.toolUseId,
            text: `Error: unknown tool "${block.toolName}"`,
          })
          continue
        }

        try {
          const output = await tool.execute(block.toolInput ?? {}, ctx)
          toolCallHistory.push({
            tool: block.toolName,
            input: block.toolInput ?? {},
            output: output.slice(0, 2000),
          })
          toolResults.push({
            type: "tool_result",
            toolUseId: block.toolUseId,
            text: output,
          })
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          process.stderr.write(`\x1b[31m  [${agent.role}] tool error: ${msg}\x1b[0m\n`)
          toolResults.push({
            type: "tool_result",
            toolUseId: block.toolUseId,
            text: `Error: ${msg}`,
          })
        }
      }
    }

    messages.push({ role: "assistant", content: assistantBlocks })
    messages.push({ role: "user", content: toolResults })
  }

  throw new BollardError({
    code: "NODE_EXECUTION_FAILED",
    message: `Agent "${agent.role}" exceeded max turns (${agent.maxTurns})`,
    context: { agentRole: agent.role, maxTurns: agent.maxTurns, turns },
  })
}
