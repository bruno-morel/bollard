import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import type { NodeResult } from "@bollard/engine/src/blueprint.js"

const execFileAsync = promisify(execFile)

export interface TestRunResult {
  passed: number
  failed: number
  total: number
  duration_ms: number
  output: string
  failedTests: string[]
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g")

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "")
}

// Stage 3: add deterministic parsers for pytest, go test, cargo test output.
// Currently parseSummary only handles Vitest output format.
// Non-Vitest test runners still work (profile-driven cmd execution) — only the
// parsed summary (passed/failed counts) falls back to zero/error detection.
function parseSummary(
  output: string,
): Pick<TestRunResult, "passed" | "failed" | "total" | "failedTests"> {
  const clean = stripAnsi(output)
  const testsLine = clean.match(/Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed\s*\((\d+)\)/)
  if (testsLine) {
    const failed = testsLine[1] ? Number(testsLine[1]) : 0
    const passed = Number(testsLine[2])
    const total = Number(testsLine[3])
    return { passed, failed, total, failedTests: [] }
  }

  const failedNames: string[] = []
  const failMatch = clean.matchAll(/FAIL\s+(\S+\.test\.ts)/g)
  for (const m of failMatch) {
    if (m[1]) failedNames.push(m[1])
  }

  return { passed: 0, failed: failedNames.length || 0, total: 0, failedTests: failedNames }
}

export async function runTests(
  workDir: string,
  testFiles?: string[],
  profile?: ToolchainProfile,
): Promise<TestRunResult> {
  let cmd: string
  let args: string[]

  if (profile?.checks.test) {
    cmd = profile.checks.test.cmd
    args = [...profile.checks.test.args]
    if (testFiles && testFiles.length > 0) {
      args.push(...testFiles)
    }
  } else {
    cmd = "pnpm"
    args = ["exec", "vitest", "run"]
    if (testFiles && testFiles.length > 0) {
      args.push(...testFiles)
    }
  }

  const startMs = Date.now()
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: workDir,
      maxBuffer: 5 * 1024 * 1024,
      timeout: 300_000,
    })

    const combined = `${stdout}\n${stderr}`
    const summary = parseSummary(combined)
    return {
      ...summary,
      duration_ms: Date.now() - startMs,
      output: combined.slice(0, 5000),
    }
  } catch (err: unknown) {
    const stdout =
      err && typeof err === "object" && "stdout" in err
        ? String((err as { stdout: string }).stdout)
        : ""
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: string }).stderr)
        : String(err)

    const combined = `${stdout}\n${stderr}`
    const summary = parseSummary(combined)

    if (summary.total > 0) {
      return { ...summary, duration_ms: Date.now() - startMs, output: combined.slice(0, 5000) }
    }

    return {
      passed: 0,
      failed: 1,
      total: 1,
      duration_ms: Date.now() - startMs,
      output: combined.slice(0, 5000),
      failedTests: ["(test execution failed)"],
    }
  }
}

export function createTestRunNode(
  workDir: string,
  testFiles?: string[],
  profile?: ToolchainProfile,
) {
  return {
    id: "run-tests",
    name: "Run Tests",
    type: "deterministic" as const,
    execute: async (): Promise<NodeResult> => {
      const result = await runTests(workDir, testFiles, profile)
      if (result.failed > 0) {
        return {
          status: "fail" as const,
          data: result,
          error: {
            code: "TEST_FAILED",
            message: `${result.failed}/${result.total} tests failed: ${result.failedTests.join(", ")}`,
          },
        }
      }
      return { status: "ok" as const, data: result }
    },
  }
}
