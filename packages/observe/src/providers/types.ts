import type { ProbeAssertion, ProbeDefinition } from "@bollard/engine/src/blueprint.js"

export type RiskTier = "low" | "medium" | "high" | "critical"

export type RolloutStage = "off" | "canary" | "partial" | "full"

export interface RolloutEvent {
  from: RolloutStage
  to: RolloutStage
  timestamp: number
  trigger: "auto" | "human" | "probe_failure" | "emergency_kill"
  probeResults?: ProbeRunSummary
}

export interface RolloutState {
  flagId: string
  riskTier: RiskTier
  stage: RolloutStage
  percent: number
  startedAt: number
  lastAdvancedAt: number
  probeWindowMs: number
  requiresHumanApproval: boolean
  history: RolloutEvent[]
}

export interface RolloutPlan {
  riskTier: RiskTier
  stages: Array<{ stage: RolloutStage; percent: number }>
  probeWindowMs: number
  requiresHumanApproval: boolean
}

export interface AdvanceDecision {
  advance: boolean
  requiresHuman: boolean
  reason?: string
}

export interface AssertionResult {
  assertion: ProbeAssertion
  passed: boolean
  actual?: unknown
  error?: string
}

export interface ProbeResult {
  probeId: string
  timestamp: number
  status: "pass" | "fail"
  assertions: AssertionResult[]
  latencyMs: number
  deploymentId?: string
  sourceRunId?: string
}

export interface ProbeRunSummary {
  total: number
  passed: number
  failed: number
  results: ProbeResult[]
  duration_ms: number
}

export interface ProbeSummary {
  probeId: string
  windowMs: number
  total: number
  passed: number
  failed: number
  avgLatencyMs: number
  p99LatencyMs: number
}

export interface ProbeExecutor {
  execute(probe: ProbeDefinition, baseUrl: string): Promise<ProbeResult>
}

export interface MetricsStore {
  record(result: ProbeResult): Promise<void>
  query(probeId: string, since: number, limit?: number): Promise<ProbeResult[]>
  summary(probeId: string, windowMs: number): Promise<ProbeSummary>
}

export interface FlagState {
  id: string
  enabled: boolean
  percent: number
  updatedAt: number
  updatedBy: string
}

export interface FlagProvider {
  get(flagId: string): Promise<FlagState | undefined>
  set(flagId: string, state: FlagState): Promise<void>
  list(): Promise<FlagState[]>
}

export interface DeploymentMetadata {
  deploymentId: string
  timestamp: number
  sourceRunIds: string[]
  relatedCommits: string[]
  environment: string
  baselineMetrics?: Record<string, number>
}

export interface DeploymentTracker {
  record(metadata: DeploymentMetadata): Promise<void>
  getCurrent(): Promise<DeploymentMetadata | undefined>
  getHistory(limit?: number): Promise<DeploymentMetadata[]>
}

export interface DriftReport {
  hasDrift: boolean
  deployedSha: string
  verifiedSha: string
  driftedFiles: string[]
  driftedConfigs: string[]
  severity: "low" | "medium" | "high"
  recommendation: "reconcile" | "investigate" | "ignore"
}

export interface DriftDetector {
  check(): Promise<DriftReport>
}

export interface ObserveProviderSlot {
  provider: string
  config?: Record<string, unknown>
}

export interface ObserveProviderConfig {
  probes?: ObserveProviderSlot
  flags?: ObserveProviderSlot
  deployments?: ObserveProviderSlot
  drift?: ObserveProviderSlot
  metrics?: ObserveProviderSlot & { retentionDays?: number }
  baseUrl?: string
}

export interface ResolvedObserveOptions {
  workDir: string
  baseUrl?: string
  retentionDays: number
}

export interface ResolvedProviders {
  probeExecutor: ProbeExecutor
  metricsStore: MetricsStore
  flagProvider: FlagProvider
  deploymentTracker: DeploymentTracker
  driftDetector: DriftDetector
  options: ResolvedObserveOptions
}

export interface ProbeScheduler {
  runOnce(baseUrl: string): Promise<ProbeRunSummary>
  watch(baseUrl: string, onResult: (result: ProbeResult) => void): ProbeWatchHandle
  loadProbes(): Promise<ProbeDefinition[]>
}

export interface ProbeWatchHandle {
  stop(): void
}
