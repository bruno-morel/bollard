import type { AgentProgressEvent } from "@bollard/agents/src/types.js"
import { DIM, GREEN, RESET } from "./terminal-styles.js"

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export interface AgentSpinnerOptions {
  stream?: NodeJS.WritableStream
  tty?: boolean
  intervalMs?: number
}

export interface AgentSpinner {
  handleEvent(event: AgentProgressEvent): void
  finalize(): void
}

function formatMmSsFromMs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, "0")}`
}

function truncatePathLike(s: string, max = 40): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 3)}...`
}

/** Short hint for spinner line only — not full tool input. */
export function toolInputHint(tool: string, input: Record<string, unknown>): string {
  const pathKeys: readonly string[] = ["path", "file_path"]
  for (const k of pathKeys) {
    const v = input[k]
    if (typeof v === "string" && v.length > 0) {
      return truncatePathLike(v)
    }
  }
  if (tool === "run_command") {
    const c = input["command"]
    if (typeof c === "string" && c.length > 0) return truncatePathLike(c)
  }
  if (tool === "list_dir") {
    const p = input["path"]
    if (typeof p === "string" && p.length > 0) return truncatePathLike(p)
  }
  return ""
}

function safeWrite(stream: NodeJS.WritableStream, chunk: string): void {
  try {
    stream.write(chunk)
  } catch {
    /* closed pipe / EPIPE */
  }
}

export function createAgentSpinner(opts?: AgentSpinnerOptions): AgentSpinner {
  const stream = opts?.stream ?? process.stderr
  const isTTY = opts?.tty ?? (stream as NodeJS.WriteStream).isTTY === true
  const intervalMs = opts?.intervalMs ?? 80

  let frameIndex = 0
  let ticker: ReturnType<typeof setInterval> | undefined
  let toolClearTimer: ReturnType<typeof setTimeout> | undefined

  let role = "agent"
  let turn = 1
  let maxTurns = 1
  let turnWallStart = Date.now()
  let cumulativeCostUsd = 0
  let lastToolLabel = "thinking..."
  let finalized = false

  function clearToolResetTimer(): void {
    if (toolClearTimer !== undefined) {
      clearTimeout(toolClearTimer)
      toolClearTimer = undefined
    }
  }

  function stopTicker(): void {
    if (ticker !== undefined) {
      clearInterval(ticker)
      ticker = undefined
    }
  }

  function redrawTTY(): void {
    if (!isTTY || finalized) return
    const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length] ?? "⠋"
    frameIndex++
    const elapsedMs = Date.now() - turnWallStart
    const elapsed = formatMmSsFromMs(elapsedMs)
    const costStr = cumulativeCostUsd.toFixed(2)
    const line = `${frame} ${role} · turn ${turn}/${maxTurns} · ${elapsed} · $${costStr} · ${lastToolLabel}`
    safeWrite(stream, `\r\x1b[2K${DIM}${line}${RESET}`)
  }

  function startTicker(): void {
    stopTicker()
    if (!isTTY || finalized) return
    ticker = setInterval(() => redrawTTY(), intervalMs)
  }

  function clearLineTTY(): void {
    if (isTTY) {
      safeWrite(stream, "\r\x1b[2K")
    }
  }

  function scheduleToolLabelReset(): void {
    clearToolResetTimer()
    toolClearTimer = setTimeout(() => {
      toolClearTimer = undefined
      lastToolLabel = "thinking..."
    }, 500)
  }

  return {
    handleEvent(event: AgentProgressEvent): void {
      if (finalized) return

      if (event.type === "stream_delta") {
        if (isTTY) {
          lastToolLabel = `${event.totalTokensSoFar} tokens`
          redrawTTY()
        }
        return
      }

      if (event.type === "turn_start") {
        clearToolResetTimer()
        role = event.role
        turn = event.turn
        maxTurns = event.maxTurns
        turnWallStart = Date.now()
        lastToolLabel = "thinking..."
        frameIndex = 0

        if (isTTY) {
          startTicker()
          redrawTTY()
        } else {
          safeWrite(stream, `[${event.role}] turn ${event.turn}/${event.maxTurns} starting\n`)
        }
        return
      }

      if (event.type === "turn_end") {
        stopTicker()
        clearToolResetTimer()
        cumulativeCostUsd += event.costUsd
        role = event.role
        turn = event.turn
        maxTurns = event.maxTurns

        if (isTTY) {
          clearLineTTY()
          const elapsed = formatMmSsFromMs(event.durationMs)
          const costStr = cumulativeCostUsd.toFixed(2)
          safeWrite(
            stream,
            `  ${GREEN}✓${RESET} ${DIM}${event.role} turn ${event.turn}/${event.maxTurns} · ${elapsed} · $${costStr} · ${event.toolCallsThisTurn} tools${RESET}\n`,
          )
        } else {
          const elapsedSec = (event.durationMs / 1000).toFixed(1)
          safeWrite(
            stream,
            `[${event.role}] turn ${event.turn}/${event.maxTurns} done in ${elapsedSec}s · $${cumulativeCostUsd.toFixed(2)} · ${event.toolCallsThisTurn} tools · stop=${event.stopReason}\n`,
          )
        }
        return
      }

      if (event.type === "tool_call_start") {
        clearToolResetTimer()
        const hint = toolInputHint(event.tool, event.input)
        lastToolLabel = hint ? `↪ ${event.tool} ${hint}` : `↪ ${event.tool}`
        if (isTTY) {
          redrawTTY()
        }
        return
      }

      if (event.type === "tool_call_end") {
        if (isTTY) {
          lastToolLabel = event.ok
            ? `✓ ${event.tool} ${event.durationMs}ms`
            : `✗ ${event.tool} ${event.durationMs}ms`
          redrawTTY()
          scheduleToolLabelReset()
        } else {
          safeWrite(
            stream,
            `[${role}] turn ${event.turn} tool ${event.tool} ${event.ok ? "ok" : "FAILED"} ${event.durationMs}ms${event.error ? ` ${event.error}` : ""}\n`,
          )
        }
      }
    },

    finalize(): void {
      if (finalized) return
      finalized = true
      clearToolResetTimer()
      stopTicker()
      clearLineTTY()
    },
  }
}
