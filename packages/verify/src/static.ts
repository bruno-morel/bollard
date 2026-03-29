import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { NodeResult } from "@bollard/engine/src/blueprint.js"

const execFileAsync = promisify(execFile)

export interface StaticCheckResult {
  check: string
  passed: boolean
  output: string
  durationMs: number
}

export async function runStaticChecks(workDir: string): Promise<{
  results: StaticCheckResult[]
  allPassed: boolean
}> {
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

export function createStaticCheckNode(workDir: string) {
  return {
    id: "static-checks",
    name: "Static Verification",
    type: "deterministic" as const,
    execute: async (): Promise<NodeResult> => {
      const { results, allPassed } = await runStaticChecks(workDir)
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
