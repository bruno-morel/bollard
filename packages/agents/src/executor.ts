import { BollardError } from "@bollard/engine/src/errors.js"
import type {
  LLMContentBlock,
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMTool,
} from "@bollard/llm/src/types.js"
import type { AgentContext, AgentDefinition, AgentResult, ExecutorOptions } from "./types.js"

const MAX_RETRIES = 3
const BASE_DELAY_MS = 15_000

const MAX_TOOL_RESULT_CHARS = 8_000
const COMPACT_KEEP_RECENT = 6
const COMPACTED_MAX_CHARS = 500

async function chatWithRetry(
  provider: LLMProvider,
  request: LLMRequest,
  agentRole: string,
): Promise<LLMResponse> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await provider.chat(request)
    } catch (err: unknown) {
      const isRetryable = BollardError.is(err) && err.retryable
      if (!isRetryable || attempt === MAX_RETRIES) throw err

      const delayMs = BASE_DELAY_MS * 2 ** attempt
      process.stderr.write(
        `\x1b[33m  [${agentRole}] rate limited, retrying in ${(delayMs / 1000).toFixed(0)}s (attempt ${attempt + 1}/${MAX_RETRIES})...\x1b[0m\n`,
      )
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw new BollardError({
    code: "LLM_PROVIDER_ERROR",
    message: "Exhausted retries",
  })
}

export function compactOlderTurns(messages: LLMMessage[]): void {
  const compactBefore = messages.length - COMPACT_KEEP_RECENT
  if (compactBefore <= 1) return

  for (let i = 1; i < compactBefore; i++) {
    const msg = messages[i]
    if (!msg || typeof msg.content === "string") continue

    for (const block of msg.content) {
      if (block.type === "tool_result" && block.text && block.text.length > COMPACTED_MAX_CHARS) {
        block.text = `${block.text.slice(0, COMPACTED_MAX_CHARS)}\n[...truncated for token efficiency]`
      }
      if (block.type === "tool_use" && block.toolName === "write_file" && block.toolInput) {
        const content = block.toolInput["content"]
        if (typeof content === "string" && content.length > 200) {
          block.toolInput["content"] = `${content.slice(0, 200)}\n[...file content truncated]`
        }
      }
      if (block.type === "tool_use" && block.toolName === "edit_file" && block.toolInput) {
        const oldStr = block.toolInput["old_string"]
        if (typeof oldStr === "string" && oldStr.length > 200) {
          block.toolInput["old_string"] = `${oldStr.slice(0, 200)}\n[...truncated]`
        }
        const newStr = block.toolInput["new_string"]
        if (typeof newStr === "string" && newStr.length > 200) {
          block.toolInput["new_string"] = `${newStr.slice(0, 200)}\n[...truncated]`
        }
      }
    }
  }
}

export async function executeAgent(
  agent: AgentDefinition,
  userMessage: string,
  provider: LLMProvider,
  model: string,
  ctx: AgentContext,
  options?: ExecutorOptions,
): Promise<AgentResult> {
  const startMs = Date.now()
  let totalCostUsd = 0
  let turns = 0
  let verificationRetries = 0
  const maxVerificationRetries = options?.maxVerificationRetries ?? 3
  const toolCallHistory: AgentResult["toolCalls"] = []

  const llmTools: LLMTool[] = agent.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }))

  const messages: LLMMessage[] = [{ role: "user", content: userMessage }]

  const resolvedMaxTokens = agent.maxTokens ?? 4096

  while (turns < agent.maxTurns) {
    const response = await chatWithRetry(
      provider,
      {
        system: agent.systemPrompt,
        messages,
        ...(llmTools.length > 0 ? { tools: llmTools } : {}),
        maxTokens: resolvedMaxTokens,
        temperature: agent.temperature,
        model,
      },
      agent.role,
    )

    totalCostUsd += response.costUsd

    const hasToolUseBlocks = response.content.some((b) => b.type === "tool_use")

    if (response.stopReason !== "tool_use" && !hasToolUseBlocks) {
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("")

      const pastTurnBudget =
        options?.skipVerificationAfterTurn !== undefined &&
        turns >= options.skipVerificationAfterTurn

      if (
        options?.postCompletionHook &&
        verificationRetries < maxVerificationRetries &&
        !pastTurnBudget
      ) {
        try {
          const feedback = await options.postCompletionHook(text)
          if (feedback) {
            verificationRetries++
            process.stderr.write(
              `\x1b[33m  [${agent.role}] verification failed (attempt ${verificationRetries}/${maxVerificationRetries}), sending feedback...\x1b[0m\n`,
            )
            messages.push({ role: "assistant", content: response.content })
            messages.push({ role: "user", content: feedback })
            compactOlderTurns(messages)
            turns++
            continue
          }
        } catch (hookErr: unknown) {
          process.stderr.write(
            `\x1b[31m  [${agent.role}] verification hook error: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}\x1b[0m\n`,
          )
        }
      }

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
          const cappedOutput =
            output.length > MAX_TOOL_RESULT_CHARS
              ? `${output.slice(0, MAX_TOOL_RESULT_CHARS)}\n[...output truncated at 8000 chars]`
              : output
          toolCallHistory.push({
            tool: block.toolName,
            input: block.toolInput ?? {},
            output: output.slice(0, 2000),
          })
          toolResults.push({
            type: "tool_result",
            toolUseId: block.toolUseId,
            text: cappedOutput,
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
    compactOlderTurns(messages)
  }

  throw new BollardError({
    code: "NODE_EXECUTION_FAILED",
    message: `Agent "${agent.role}" exceeded max turns (${agent.maxTurns})`,
    context: { agentRole: agent.role, maxTurns: agent.maxTurns, turns },
  })
}
