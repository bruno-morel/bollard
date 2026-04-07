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

export type MutationToolId = "stryker" | "mutmut" | "go-mutesting" | "cargo-mutants" | "mutant"

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

  mutation?: {
    tool: MutationToolId
    command: string
    changedFilesPlaceholder: string
  }

  sourcePatterns: string[]
  testPatterns: string[]
  ignorePatterns: string[]
  allowedCommands: string[]

  adversarial: AdversarialConfig
}
