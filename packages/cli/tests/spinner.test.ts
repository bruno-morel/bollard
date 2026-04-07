import { PassThrough } from "node:stream"
import type { AgentProgressEvent } from "@bollard/agents/src/types.js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createAgentSpinner, toolInputHint } from "../src/spinner.js"

function turnStart(turn = 1, max = 60, role = "coder"): AgentProgressEvent {
  return { type: "turn_start", turn, maxTurns: max, role }
}

function turnEnd(
  turn: number,
  max: number,
  role: string,
  durationMs: number,
  costUsd: number,
  tools: number,
  stop = "end_turn",
): AgentProgressEvent {
  return {
    type: "turn_end",
    turn,
    maxTurns: max,
    role,
    durationMs,
    costUsd,
    inputTokens: 1,
    outputTokens: 1,
    toolCallsThisTurn: tools,
    stopReason: stop,
  }
}

describe("toolInputHint", () => {
  it("truncates long paths", () => {
    const long = "a".repeat(50)
    expect(toolInputHint("read_file", { path: long }).length).toBeLessThanOrEqual(40)
  })

  it("returns command hint for run_command", () => {
    expect(toolInputHint("run_command", { command: "pnpm test" })).toContain("pnpm")
  })
})

describe("createAgentSpinner", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("TTY: ticker advances frames when interval elapses", async () => {
    vi.useFakeTimers()
    const stream = new PassThrough()
    Object.defineProperty(stream, "isTTY", { value: true, configurable: true })
    const chunks: string[] = []
    stream.on("data", (c: Buffer) => chunks.push(c.toString()))
    const spinner = createAgentSpinner({ stream, tty: true, intervalMs: 50 })
    spinner.handleEvent(turnStart(1, 5, "coder"))
    const snapshot1 = chunks.join("")
    await vi.advanceTimersByTimeAsync(200)
    const snapshot2 = chunks.join("")
    expect(snapshot2.length).toBeGreaterThanOrEqual(snapshot1.length)
    expect(snapshot2).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
    spinner.finalize()
  })

  it("TTY: turn_start starts ticker and redraw contains role and turn", async () => {
    vi.useFakeTimers()
    const stream = new PassThrough()
    Object.defineProperty(stream, "isTTY", { value: true, configurable: true })
    const chunks: string[] = []
    stream.on("data", (c: Buffer) => chunks.push(c.toString()))

    const spinner = createAgentSpinner({ stream, tty: true, intervalMs: 99999 })
    spinner.handleEvent(turnStart(3, 60, "planner"))
    await vi.advanceTimersByTimeAsync(0)
    const joined = chunks.join("")
    expect(joined).toContain("planner")
    expect(joined).toContain("turn 3/60")
    spinner.finalize()
  })

  it("TTY: tool_call_start updates line with arrow and tool name", async () => {
    vi.useFakeTimers()
    const stream = new PassThrough()
    Object.defineProperty(stream, "isTTY", { value: true, configurable: true })
    const chunks: string[] = []
    stream.on("data", (c: Buffer) => chunks.push(c.toString()))

    const spinner = createAgentSpinner({ stream, tty: true, intervalMs: 99999 })
    spinner.handleEvent(turnStart(1, 5, "coder"))
    spinner.handleEvent({
      type: "tool_call_start",
      turn: 1,
      tool: "read_file",
      input: { path: "src/x.ts" },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(chunks.join("")).toContain("↪ read_file")
    spinner.finalize()
  })

  it("TTY: turn_end prints summary with checkmark tools and cost", () => {
    const stream = new PassThrough()
    Object.defineProperty(stream, "isTTY", { value: true, configurable: true })
    const chunks: string[] = []
    stream.on("data", (c: Buffer) => chunks.push(c.toString()))

    const spinner = createAgentSpinner({ stream, tty: true, intervalMs: 99999 })
    spinner.handleEvent(turnStart(1, 5, "coder"))
    spinner.handleEvent(turnEnd(1, 5, "coder", 43_000, 0.02, 2, "tool_use"))
    const out = chunks.join("")
    expect(out).toMatch(/✓/)
    expect(out).toContain("turn 1/5")
    expect(out).toContain("2 tools")
    expect(out).toMatch(/\$0\.02/)
    spinner.finalize()
  })

  it("TTY: finalize ignores subsequent events", () => {
    const stream = new PassThrough()
    Object.defineProperty(stream, "isTTY", { value: true, configurable: true })
    const chunks: string[] = []
    stream.on("data", (c: Buffer) => chunks.push(c.toString()))

    const spinner = createAgentSpinner({ stream, tty: true, intervalMs: 99999 })
    spinner.handleEvent(turnStart(1, 5, "coder"))
    spinner.finalize()
    const afterFinalize = chunks.length
    spinner.handleEvent(turnEnd(1, 5, "coder", 1000, 0, 0, "end_turn"))
    expect(chunks.length).toBe(afterFinalize)
  })

  it("non-TTY: no ANSI escapes in output", () => {
    const stream = new PassThrough()
    Object.defineProperty(stream, "isTTY", { value: false, configurable: true })
    const chunks: string[] = []
    stream.on("data", (c: Buffer) => chunks.push(c.toString()))

    const spinner = createAgentSpinner({ stream, tty: false })
    spinner.handleEvent(turnStart(2, 10, "coder"))
    spinner.handleEvent({
      type: "tool_call_end",
      turn: 2,
      tool: "search",
      durationMs: 12,
      ok: true,
    })
    spinner.handleEvent(turnEnd(2, 10, "coder", 125_000, 0.001, 1, "end_turn"))
    const out = chunks.join("")
    expect(out).not.toContain("\u001b")
    expect(out).toContain("starting")
    expect(out).toContain("tool search ok")
    expect(out).toContain("125.0s")
    spinner.finalize()
  })

  it("accumulates cost across turns in TTY summary", () => {
    const stream = new PassThrough()
    Object.defineProperty(stream, "isTTY", { value: true, configurable: true })
    const chunks: string[] = []
    stream.on("data", (c: Buffer) => chunks.push(c.toString()))

    const spinner = createAgentSpinner({ stream, tty: true, intervalMs: 99999 })
    spinner.handleEvent(turnStart(1, 5, "coder"))
    spinner.handleEvent(turnEnd(1, 5, "coder", 1000, 0.01, 0, "end_turn"))
    spinner.handleEvent(turnStart(2, 5, "coder"))
    spinner.handleEvent(turnEnd(2, 5, "coder", 1000, 0.02, 0, "end_turn"))
    const out = chunks.join("")
    expect(out).toMatch(/\$0\.03/)
    spinner.finalize()
  })

  it("formats elapsed 43s as 0:43 and 125s as 2:05 and 600s as 10:00 in TTY turn_end line", () => {
    const stream = new PassThrough()
    Object.defineProperty(stream, "isTTY", { value: true, configurable: true })
    const chunks: string[] = []
    stream.on("data", (c: Buffer) => chunks.push(c.toString()))

    const spinner = createAgentSpinner({ stream, tty: true, intervalMs: 99999 })
    spinner.handleEvent(turnStart(1, 5, "a"))
    spinner.handleEvent(turnEnd(1, 5, "a", 43_000, 0, 0, "end_turn"))
    expect(chunks.join("")).toContain("0:43")
    chunks.length = 0
    spinner.handleEvent(turnStart(2, 5, "a"))
    spinner.handleEvent(turnEnd(2, 5, "a", 125_000, 0, 0, "end_turn"))
    expect(chunks.join("")).toContain("2:05")
    chunks.length = 0
    spinner.handleEvent(turnStart(3, 5, "a"))
    spinner.handleEvent(turnEnd(3, 5, "a", 600_000, 0, 0, "end_turn"))
    expect(chunks.join("")).toContain("10:00")
    spinner.finalize()
  })

  it("shows $0.00 for zero cumulative cost formatting", () => {
    const stream = new PassThrough()
    Object.defineProperty(stream, "isTTY", { value: true, configurable: true })
    const chunks: string[] = []
    stream.on("data", (c: Buffer) => chunks.push(c.toString()))

    const spinner = createAgentSpinner({ stream, tty: true, intervalMs: 99999 })
    spinner.handleEvent(turnStart(1, 5, "coder"))
    spinner.handleEvent(turnEnd(1, 5, "coder", 100, 0, 0, "end_turn"))
    expect(chunks.join("")).toContain("$0.00")
    spinner.finalize()
  })
})
