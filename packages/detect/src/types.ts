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

  adversarial: {
    mode: "blackbox" | "in-language" | "both"
    runtimeImage?: string
    persist?: boolean
  }
}
