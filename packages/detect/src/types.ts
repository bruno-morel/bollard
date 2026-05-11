export type LanguageId =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "kotlin"
  | "ruby"
  | "csharp"
  | "elixir"
  | "unknown"

export type PackageManagerId =
  | "pnpm"
  | "npm"
  | "yarn"
  | "bun"
  | "poetry"
  | "pipenv"
  | "uv"
  | "pip"
  | "go"
  | "cargo"
  | "bundler"
  | "gradle"
  | "maven"

export type MutationToolId =
  | "stryker"
  | "mutmut"
  | "go-mutesting"
  | "cargo-mutants"
  | "mutant"
  | "pitest"

export type ConfigSource = "default" | "auto-detected" | "env" | "file" | "cli"

export type AdversarialScope = "boundary" | "contract" | "behavioral"

export type AdversarialConcern = "correctness" | "security" | "performance" | "resilience"

export type ConcernWeight = "high" | "medium" | "low" | "off"

export interface ConcernConfig {
  correctness: ConcernWeight
  security: ConcernWeight
  performance: ConcernWeight
  resilience: ConcernWeight
}

export interface AdversarialScopeConfig {
  enabled: boolean
  integration: "integrated" | "independent"
  lifecycle: "ephemeral" | "persistent"
  concerns: ConcernConfig
  frameworkCapable?: boolean
  runtimeImage?: string
  /** Boundary scope only — blackbox vs in-language adversarial tests */
  mode?: "blackbox" | "in-language" | "both"
}

export interface AdversarialConfig {
  boundary: AdversarialScopeConfig
  contract: AdversarialScopeConfig
  behavioral: AdversarialScopeConfig
}

export interface VerificationCommand {
  label: string
  cmd: string
  args: string[]
  source: ConfigSource
}

export interface MutationConfig {
  enabled: boolean
  tool: MutationToolId
  threshold: number
  timeoutMs: number
  concurrency: number
}

export interface MetricsConfig {
  coverage: { enabled: boolean; thresholdPct: number }
  complexity: { enabled: boolean; hotspotThreshold: number }
  sast: { enabled: boolean }
  churn: { enabled: boolean; highThreshold: number }
  probePerf: { enabled: boolean; windowResults: number }
  loadTest: { enabled: boolean; vus: number; durationSec: number }
}

export const DEFAULT_METRICS_CONFIG: MetricsConfig = {
  coverage: { enabled: true, thresholdPct: 60 },
  complexity: { enabled: true, hotspotThreshold: 5 },
  sast: { enabled: true },
  churn: { enabled: true, highThreshold: 30 },
  probePerf: { enabled: true, windowResults: 100 },
  loadTest: { enabled: false, vus: 10, durationSec: 30 },
}

export interface ToolchainProfile {
  language: LanguageId
  packageManager?: PackageManagerId

  checks: {
    typecheck?: VerificationCommand
    lint?: VerificationCommand
    test?: VerificationCommand
    audit?: VerificationCommand
    secretScan?: VerificationCommand
  }

  mutation?: MutationConfig
  metrics?: MetricsConfig

  sourcePatterns: string[]
  testPatterns: string[]
  ignorePatterns: string[]
  allowedCommands: string[]

  adversarial: AdversarialConfig
}
