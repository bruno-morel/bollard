import { BollardError } from "@bollard/engine/src/errors.js"
import type {
  LLMContentBlock,
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  LLMTool,
} from "@bollard/llm/src/types.js"
import type {
  AgentContext,
  AgentDefinition,
  AgentProgressEvent,
  AgentResult,
  ExecutorOptions,
} from "./types.js"

const MAX_RETRIES = 3
const BASE_DELAY_MS = 15_000

const MAX_TOOL_RESULT_CHARS = 8_000
const COMPACT_KEEP_RECENT = 6
const COMPACTED_MAX_CHARS = 500

function emitProgress(ctx: AgentContext, ev: AgentProgressEvent): void {
  try {
    ctx.progress?.(ev)
  } catch {
    // Progress listeners must never break the executor
  }
}

async function streamToResponse(
  stream: AsyncIterable<LLMStreamEvent>,
  ctx: AgentContext,
  turn: number,
): Promise<LLMResponse> {
  let totalChars = 0
  for await (const ev of stream) {
    if (ev.type === "text_delta") {
      const chunk = ev.text.length
      totalChars += chunk
      emitProgress(ctx, {
        type: "stream_delta",
        turn,
        tokensThisChunk: chunk,
        totalTokensSoFar: totalChars,
      })
    }
    if (ev.type === "message_complete") {
      return ev.response
    }
  }
  throw new BollardError({
    code: "LLM_INVALID_RESPONSE",
    message: "LLM stream ended without message_complete event",
  })
}

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
  if (!Number.isFinite(agent.maxTurns) || agent.maxTurns < 1) {
    throw new BollardError({
      code: "CONFIG_INVALID",
      message: `Agent "${agent.role}" requires maxTurns to be a positive finite number`,
      context: { agentRole: agent.role, maxTurns: agent.maxTurns },
    })
  }

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
    const capUsd = ctx.pipelineCtx.config.agent.max_cost_usd
    const liveCostUsd = ctx.pipelineCtx.costTracker.total() + totalCostUsd
    if (liveCostUsd > capUsd) {
      throw new BollardError({
        code: "COST_LIMIT_EXCEEDED",
        message: `Cost limit of $${capUsd} exceeded inside agent "${agent.role}" at turn ${turns + 1}`,
        context: {
          agentRole: agent.role,
          turn: turns + 1,
          costUsd: liveCostUsd,
          limitUsd: capUsd,
        },
      })
    }

    const displayTurn = turns + 1
    const turnStartedAt = Date.now()
    emitProgress(ctx, {
      type: "turn_start",
      turn: displayTurn,
      maxTurns: agent.maxTurns,
      role: agent.role,
    })

    const request: LLMRequest = {
      system: agent.systemPrompt,
      messages,
      ...(llmTools.length > 0 ? { tools: llmTools } : {}),
      maxTokens: resolvedMaxTokens,
      temperature: agent.temperature,
      model,
    }

    const response = provider.chatStream
      ? await streamToResponse(provider.chatStream(request), ctx, displayTurn)
      : await chatWithRetry(provider, request, agent.role)

    totalCostUsd += response.costUsd
    const toolCallsThisTurn = response.content.filter((b) => b.type === "tool_use").length

    emitProgress(ctx, {
      type: "turn_end",
      turn: displayTurn,
      maxTurns: agent.maxTurns,
      role: agent.role,
      durationMs: Date.now() - turnStartedAt,
      costUsd: response.costUsd,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      toolCallsThisTurn,
      stopReason: response.stopReason,
    })

    const hasToolUseBlocks = response.content.some((b) => b.type === "tool_use")

    if (response.stopReason !== "tool_use" && !hasToolUseBlocks) {
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("")

      const pastTurnBudget =
        options?.deferPostCompletionVerifyFromTurn !== undefined &&
        turns >= options.deferPostCompletionVerifyFromTurn

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

    const toolTurn = displayTurn
    turns++
    const assistantBlocks = response.content
    const toolResults: LLMContentBlock[] = []

    for (const block of assistantBlocks) {
      if (block.type === "tool_use" && block.toolName && block.toolUseId) {
        const inputSummary = JSON.stringify(block.toolInput ?? {}).slice(0, 120)
        process.stderr.write(
          `\x1b[2m  [${agent.role}] turn ${turns}: ${block.toolName}(${inputSummary})\x1b[0m\n`,
        )

        emitProgress(ctx, {
          type: "tool_call_start",
          turn: toolTurn,
          tool: block.toolName,
          input: block.toolInput ?? {},
        })

        const tool = agent.tools.find((t) => t.name === block.toolName)
        if (!tool) {
          emitProgress(ctx, {
            type: "tool_call_end",
            turn: toolTurn,
            tool: block.toolName,
            durationMs: 0,
            ok: false,
            error: `unknown tool "${block.toolName}"`,
          })
          toolResults.push({
            type: "tool_result",
            toolUseId: block.toolUseId,
            text: `Error: unknown tool "${block.toolName}"`,
          })
          continue
        }

        const toolStartedAt = Date.now()
        try {
          const output = await tool.execute(block.toolInput ?? {}, ctx)
          const durationMs = Date.now() - toolStartedAt
          emitProgress(ctx, {
            type: "tool_call_end",
            turn: toolTurn,
            tool: block.toolName,
            durationMs,
            ok: true,
          })
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
          const durationMs = Date.now() - toolStartedAt
          const msg = err instanceof Error ? err.message : String(err)
          emitProgress(ctx, {
            type: "tool_call_end",
            turn: toolTurn,
            tool: block.toolName,
            durationMs,
            ok: false,
            error: msg,
          })
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
    context: { agentRole: agent.role, maxTurns: agent.maxTurns, turns, totalCostUsd },
  })
}
