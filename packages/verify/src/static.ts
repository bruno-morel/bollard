import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import type { NodeResult } from "@bollard/engine/src/blueprint.js"

const execFileAsync = promisify(execFile)

export interface StaticCheckResult {
  check: string
  passed: boolean
  output: string
  durationMs: number
}

function buildChecksFromProfile(
  profile: ToolchainProfile,
): { name: string; cmd: string; args: string[] }[] {
  const checks: { name: string; cmd: string; args: string[] }[] = []
  if (profile.checks.typecheck) {
    checks.push({
      name: "typecheck",
      cmd: profile.checks.typecheck.cmd,
      args: profile.checks.typecheck.args,
    })
  }
  if (profile.checks.lint) {
    checks.push({
      name: "lint",
      cmd: profile.checks.lint.cmd,
      args: profile.checks.lint.args,
    })
  }
  if (profile.checks.audit) {
    checks.push({
      name: "audit",
      cmd: profile.checks.audit.cmd,
      args: profile.checks.audit.args,
    })
  }
  if (profile.checks.secretScan) {
    checks.push({
      name: "secrets",
      cmd: profile.checks.secretScan.cmd,
      args: profile.checks.secretScan.args,
    })
  }
  return checks
}

async function buildDefaultChecks(
  workDir: string,
): Promise<{ name: string; cmd: string; args: string[] }[]> {
  const checks = [
    { name: "typecheck", cmd: "pnpm", args: ["run", "typecheck"] },
    { name: "lint", cmd: "pnpm", args: ["run", "lint"] },
    { name: "audit", cmd: "pnpm", args: ["audit", "--audit-level=high"] },
  ]

  try {
    await execFileAsync("gitleaks", ["version"], { timeout: 5000 })
    checks.push({
      name: "secrets",
      cmd: "gitleaks",
      args: ["detect", "--source", workDir, "--no-banner"],
    })
  } catch {
    // gitleaks not installed — skip
  }

  return checks
}

export async function runStaticChecks(
  workDir: string,
  profile?: ToolchainProfile,
): Promise<{
  results: StaticCheckResult[]
  allPassed: boolean
}> {
  const checks = profile ? buildChecksFromProfile(profile) : await buildDefaultChecks(workDir)

  const results: StaticCheckResult[] = []

  for (const check of checks) {
    const startMs = Date.now()
    try {
      const { stdout, stderr } = await execFileAsync(check.cmd, check.args, {
        cwd: workDir,
        maxBuffer: 5 * 1024 * 1024,
        timeout: 120_000,
      })
      results.push({
        check: check.name,
        passed: true,
        output: (stdout + stderr).slice(0, 2000),
        durationMs: Date.now() - startMs,
      })
    } catch (err: unknown) {
      const output =
        err && typeof err === "object" && "stderr" in err
          ? String((err as { stderr: string }).stderr)
          : String(err)
      results.push({
        check: check.name,
        passed: false,
        output: output.slice(0, 2000),
        durationMs: Date.now() - startMs,
      })
    }
  }

  return {
    results,
    allPassed: results.every((r) => r.passed),
  }
}

export function createStaticCheckNode(workDir: string, profile?: ToolchainProfile) {
  return {
    id: "static-checks",
    name: "Static Verification",
    type: "deterministic" as const,
    execute: async (): Promise<NodeResult> => {
      const { results, allPassed } = await runStaticChecks(workDir, profile)
      if (!allPassed) {
        const failures = results.filter((r) => !r.passed).map((r) => r.check)
        return {
          status: "fail" as const,
          data: results,
          error: {
            code: "STATIC_CHECK_FAILED",
            message: `Static checks failed: ${failures.join(", ")}`,
          },
        }
      }
      return { status: "ok" as const, data: results }
    },
  }
}
