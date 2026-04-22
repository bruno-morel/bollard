import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { detectToolchain } from "@bollard/detect/src/detect.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { BOLD, DIM, GREEN, RED, RESET } from "./terminal-styles.js"

const execFileAsync = promisify(execFile)

export type DoctorCheckStatus = "pass" | "fail"

export type DoctorCheckId = "docker" | "llm-key" | "toolchain"

export interface DoctorCheck {
  id: DoctorCheckId
  label: string
  status: DoctorCheckStatus
  detail: string
}

export type DoctorConfigNote = "custom config" | "using defaults"

export interface DoctorReport {
  allPassed: boolean
  checks: DoctorCheck[]
  configNote: DoctorConfigNote
}

const LLM_KEY_NAMES = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY"] as const

function countVerificationChecks(checks: ToolchainProfile["checks"]): number {
  return Object.values(checks).filter((c) => c !== undefined).length
}

async function checkDocker(): Promise<DoctorCheck> {
  const label = "Docker"
  try {
    const { stdout } = await execFileAsync("docker", ["compose", "version"], { timeout: 5000 })
    const firstLine = stdout.trim().split("\n")[0] ?? stdout.trim()
    return {
      id: "docker",
      label,
      status: "pass",
      detail: firstLine.length > 0 ? firstLine : "docker compose version",
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      id: "docker",
      label,
      status: "fail",
      detail: message,
    }
  }
}

function checkLlmKeys(env: NodeJS.ProcessEnv): DoctorCheck {
  const label = "LLM API key"
  const found = LLM_KEY_NAMES.filter((name) => {
    const v = env[name]
    return typeof v === "string" && v.trim().length > 0
  })
  if (found.length > 0) {
    return {
      id: "llm-key",
      label,
      status: "pass",
      detail: `set: ${found.join(", ")}`,
    }
  }
  return {
    id: "llm-key",
    label,
    status: "fail",
    detail: "set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY",
  }
}

async function checkToolchain(workDir: string): Promise<DoctorCheck> {
  const label = "Toolchain"
  try {
    const profile = await detectToolchain(workDir)
    const n = countVerificationChecks(profile.checks)
    const ok = profile.language !== "unknown" && n >= 1
    return {
      id: "toolchain",
      label,
      status: ok ? "pass" : "fail",
      detail: ok
        ? `${profile.language}, ${n} verification check(s)`
        : profile.language === "unknown"
          ? "no language detected"
          : "no verification checks detected",
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      id: "toolchain",
      label,
      status: "fail",
      detail: message,
    }
  }
}

function resolveConfigNote(workDir: string): DoctorConfigNote {
  return existsSync(join(workDir, ".bollard.yml")) ? "custom config" : "using defaults"
}

export async function runDoctor(
  workDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DoctorReport> {
  const [dockerCheck, toolchainCheck] = await Promise.all([checkDocker(), checkToolchain(workDir)])
  const llmCheck = checkLlmKeys(env)
  const checks = [dockerCheck, llmCheck, toolchainCheck]
  const allPassed = checks.every((c) => c.status === "pass")
  return {
    allPassed,
    checks,
    configNote: resolveConfigNote(workDir),
  }
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = []
  for (const c of report.checks) {
    const icon = c.status === "pass" ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`
    lines.push(`  ${icon} ${BOLD}${c.label}${RESET} ${DIM}—${RESET} ${c.detail}`)
  }
  lines.push("")
  lines.push(`  ${DIM}Config:${RESET} ${report.configNote}`)
  return lines.join("\n")
}
