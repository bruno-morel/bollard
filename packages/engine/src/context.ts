import { randomBytes } from "node:crypto"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import type { NodeResult } from "./blueprint.js"
import { CostTracker } from "./cost-tracker.js"

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface LogEntry {
  level: LogLevel
  message: string
  runId: string
  node?: string
  timestamp: string
  data?: Record<string, unknown>
}

export interface BollardConfig {
  llm: {
    default: { provider: string; model: string }
    agents?: Record<string, { provider: string; model: string }>
  }
  agent: {
    max_cost_usd: number
    max_duration_minutes: number
  }
}

export interface PipelineContext {
  runId: string
  task: string
  blueprintId: string
  config: BollardConfig
  currentNode?: string
  results: Record<string, NodeResult>
  changedFiles: string[]
  gitBranch?: string
  plan?: unknown
  mutationScore?: number
  generatedProbes?: unknown[]
  deploymentManifest?: unknown
  toolchainProfile?: ToolchainProfile
  costTracker: CostTracker
  log: {
    debug: (message: string, data?: Record<string, unknown>) => void
    info: (message: string, data?: Record<string, unknown>) => void
    warn: (message: string, data?: Record<string, unknown>) => void
    error: (message: string, data?: Record<string, unknown>) => void
  }
  upgradeRunId: (taskSlug: string) => void
  startedAt: number
}

function randRunSuffixHex(): string {
  return randomBytes(3).toString("hex")
}

function formatDatePrefix(): string {
  const now = new Date()
  const yyyy = now.getFullYear().toString()
  const mm = (now.getMonth() + 1).toString().padStart(2, "0")
  const dd = now.getDate().toString().padStart(2, "0")
  const hh = now.getHours().toString().padStart(2, "0")
  const min = now.getMinutes().toString().padStart(2, "0")
  return `${yyyy}${mm}${dd}-${hh}${min}`
}

function generateTempRunId(): string {
  return `${formatDatePrefix()}-run-${randRunSuffixHex()}`
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
}

function createLogger(ctx: PipelineContext): PipelineContext["log"] {
  const emit = (level: LogLevel, message: string, data?: Record<string, unknown>) => {
    const entry: LogEntry = {
      level,
      message,
      runId: ctx.runId,
      timestamp: new Date().toISOString(),
      ...(ctx.currentNode !== undefined ? { node: ctx.currentNode } : {}),
      ...(data !== undefined ? { data } : {}),
    }
    const json = JSON.stringify(entry)
    if (level === "warn" || level === "error") {
      process.stderr.write(`${json}\n`)
    } else {
      process.stdout.write(`${json}\n`)
    }
  }

  return {
    debug: (message, data) => emit("debug", message, data),
    info: (message, data) => emit("info", message, data),
    warn: (message, data) => emit("warn", message, data),
    error: (message, data) => emit("error", message, data),
  }
}

export function createContext(
  task: string,
  blueprintId: string,
  config: BollardConfig,
): PipelineContext {
  const ctx: PipelineContext = {
    runId: generateTempRunId(),
    task,
    blueprintId,
    config,
    results: {},
    changedFiles: [],
    costTracker: new CostTracker(config.agent.max_cost_usd),
    startedAt: Date.now(),
    log: undefined as unknown as PipelineContext["log"],
    upgradeRunId(taskSlug: string) {
      const slug = slugify(taskSlug)
      const prefix = blueprintId.slice(0, 8)
      ctx.runId = `${formatDatePrefix()}-${prefix}-${slug}-${randRunSuffixHex()}`
    },
  }

  ctx.log = createLogger(ctx)
  return ctx
}

export { slugify as _slugify, generateTempRunId as _generateTempRunId }
