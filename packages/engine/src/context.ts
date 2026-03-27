import type { CostTracker } from "./cost-tracker.js"

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
  results: Record<string, unknown>
  changedFiles: string[]
  gitBranch?: string
  plan?: string
  mutationScore?: number
  generatedProbes?: unknown[]
  deploymentManifest?: unknown
  costTracker: CostTracker
  log: {
    debug: (message: string, data?: Record<string, unknown>) => void
    info: (message: string, data?: Record<string, unknown>) => void
    warn: (message: string, data?: Record<string, unknown>) => void
    error: (message: string, data?: Record<string, unknown>) => void
  }
  upgradeRunId: (taskSlug: string) => void
}

export function createContext(
  _task: string,
  _blueprintId: string,
  _config: BollardConfig,
): PipelineContext {
  const ctx = {} as PipelineContext
  return ctx
}
