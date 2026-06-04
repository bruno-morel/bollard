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

export interface LocalModelsConfig {
  /** Minimum free RAM in GB before attempting local inference. Default: 3 */
  minFreeRamGb: number
  /** Hard timeout per inference call in seconds. Default: 60 */
  timeoutSec: number
  /** Named Docker volume mount path for model files. Default: /var/cache/bollard/models */
  cacheDir: string
  /** Max volume size in GB before LRU eviction (informational only in Phase 4). Default: 5 */
  cacheSizeGb: number
  /**
   * URL prefix for pulling model files on first use.
   * Supports BOLLARD_MODEL_REGISTRY_URL env override.
   * Default: https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main
   */
  registryUrl: string
  /** Model id used by the Phase 2 patcher. Default: DEFAULT_MODEL_ID from `@bollard/llm` local provider. */
  patcherModel?: string
}

// ─── Stage 6: Lifecycle Ownership (Takeover Mode) ────────────────────────────

/**
 * How Bollard commits changes when it owns a lifecycle domain.
 * - `review`: changes staged in `.bollard/curation/`, presented at a human gate before writing
 * - `auto-commit`: committed to a `bollard/curate-<domain>-<runId>` branch; PR opened automatically
 * - `silent`: written directly to workspace; CI validates (no human gate)
 */
export type TakeoverTrustLevel = "review" | "auto-commit" | "silent"

/** CI platforms Bollard can generate and maintain workflow configs for. */
export type CiPlatformId = "github-actions" | "gitlab-ci" | "circleci" | "buildkite"

/** Base config shared by every takeover domain. */
export interface TakeoverDomainConfig {
  enabled: boolean
  /** How Bollard commits ownership changes. Default: `review`. */
  trust: TakeoverTrustLevel
}

export interface TakeoverTestsConfig extends TakeoverDomainConfig {
  /**
   * Only initiate curation when the file's mutation score is below this threshold.
   * Set to 0 to curate unconditionally every cycle. Default: 0.
   */
  minMutationScoreToTrigger: number
  /** Maximum number of test files promoted, pruned, or rewritten per curation run. Default: 5. */
  maxFilesPerCycle: number
}

export interface TakeoverCiConfig extends TakeoverDomainConfig {
  /** CI platforms to generate/update configs for. Defaults to the auto-detected platform. */
  platforms?: CiPlatformId[]
}

export interface TakeoverDepsConfig extends TakeoverDomainConfig {
  /**
   * When true (default), only apply security-patch-level updates (CVE advisories).
   * Set to false to also allow major/minor version bumps.
   */
  securityOnly: boolean
}

/**
 * Lifecycle ownership configuration (Stage 6).
 * Each domain is independently opt-in. All default to `enabled: false`.
 *
 * Ownership state is tracked in `.bollard/ownership.json` — the TestOwnershipManifest —
 * which records managed vs user-owned files, per-file mutation scores, and last-commit SHAs
 * for conflict detection (`TAKEOVER_CONFLICT`).
 */
export interface TakeoverModeConfig {
  /**
   * Test curation: Bollard promotes adversarial tests to the main suite,
   * prunes redundant low-value tests, and scores test quality after each pipeline run.
   * New blueprint: `curate-tests`.
   */
  tests?: TakeoverTestsConfig
  /**
   * CI/CD ownership: Bollard generates and keeps CI workflow files in sync with
   * the project's toolchain and adversarial configuration. Runs when `bollard verify`
   * detects drift between `.bollard.yml` adversarial config and the current CI workflows.
   * New blueprint: `curate-ci`.
   */
  ci?: TakeoverCiConfig
  /**
   * Dependency hygiene: Bollard audits and auto-updates dependencies,
   * opening PRs for security patches (and optionally version bumps).
   * New blueprint: `curate-deps`.
   */
  deps?: TakeoverDepsConfig
  /**
   * Documentation: Bollard updates docstrings and README API sections when
   * public signatures change (triggered by contract scope export changes).
   * New blueprint: `curate-docs`.
   */
  docs?: TakeoverDomainConfig
  /**
   * Monitoring: Bollard continuously manages `.bollard/probes/` — updating probe
   * definitions and assertion thresholds as behavioral context and metrics evolve.
   * New blueprint: `curate-monitoring`.
   */
  monitoring?: TakeoverDomainConfig
}

// ─────────────────────────────────────────────────────────────────────────────

export interface BollardConfig {
  llm: {
    default: { provider: string; model: string }
    agents?: Record<string, { provider: string; model: string }>
    /**
     * Optional per-agent hard cost caps in USD. Parsed, surfaced in `config show --sources`,
     * and enforced at runtime (Stage 5d Phase 13 — shipped).
     */
    agentBudgets?: Record<string, number>
  }
  agent: {
    max_cost_usd: number
    max_duration_minutes: number
  }
  /** Optional overrides; omitted fields use LocalProvider defaults. */
  localModels?: Partial<LocalModelsConfig>
  /**
   * Lifecycle ownership configuration (Stage 6).
   * Each domain defaults to disabled. Opt in per-domain via `.bollard.yml` `takeover:`.
   */
  takeover?: TakeoverModeConfig
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
  /** SHA of HEAD at branch creation — rollback target on coder failure. */
  rollbackSha?: string
  plan?: unknown
  mutationScore?: number
  generatedProbes?: unknown[]
  deploymentManifest?: unknown
  toolchainProfile?: ToolchainProfile
  /** Checks to skip in static-checks node (CI-injected via --ci-passed). */
  skipChecks?: string[]
  /** Ownership manifest loaded by curate-* blueprints (Stage 6). */
  ownershipManifest?: unknown
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
