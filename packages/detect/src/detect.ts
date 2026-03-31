import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { detect as detectFallback } from "./languages/fallback.js"
import { detect as detectGo } from "./languages/go.js"
import { detect as detectPython } from "./languages/python.js"
import { detect as detectRust } from "./languages/rust.js"
import { detect as detectTypescript } from "./languages/typescript.js"
import type { ToolchainProfile } from "./types.js"

const execFileAsync = promisify(execFile)

const detectors = [detectTypescript, detectPython, detectGo, detectRust, detectFallback]

async function checkGitleaks(): Promise<boolean> {
  try {
    await execFileAsync("gitleaks", ["version"], { timeout: 5000 })
    return true
  } catch {
    return false
  }
}

const UNKNOWN_PROFILE: ToolchainProfile = {
  language: "unknown",
  checks: {},
  sourcePatterns: [],
  testPatterns: [],
  ignorePatterns: [],
  allowedCommands: ["git"],
  adversarial: { mode: "blackbox" },
}

export async function detectToolchain(cwd: string): Promise<ToolchainProfile> {
  for (const detector of detectors) {
    const partial = await detector(cwd)
    if (partial) {
      const profile: ToolchainProfile = {
        language: partial.language ?? "unknown",
        checks: partial.checks ?? {},
        sourcePatterns: partial.sourcePatterns ?? [],
        testPatterns: partial.testPatterns ?? [],
        ignorePatterns: partial.ignorePatterns ?? [],
        allowedCommands: partial.allowedCommands ?? ["git"],
        adversarial: partial.adversarial ?? { mode: "blackbox" },
        ...(partial.packageManager !== undefined ? { packageManager: partial.packageManager } : {}),
        ...(partial.mutation !== undefined ? { mutation: partial.mutation } : {}),
      }

      const hasGitleaks = await checkGitleaks()
      if (hasGitleaks && !profile.checks.secretScan) {
        profile.checks.secretScan = {
          label: "gitleaks",
          cmd: "gitleaks",
          args: ["detect", "--source", cwd, "--no-banner"],
          source: "auto-detected",
        }
      }

      return profile
    }
  }

  return { ...UNKNOWN_PROFILE }
}
