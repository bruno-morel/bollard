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

type ParsedSummary = Pick<TestRunResult, "passed" | "failed" | "total" | "failedTests">

function parseVitestSummary(clean: string): ParsedSummary | null {
  const testsLine = clean.match(/Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed\s*\((\d+)\)/)
  if (!testsLine) return null
  const failed = testsLine[1] ? Number(testsLine[1]) : 0
  const passed = Number(testsLine[2])
  const total = Number(testsLine[3])
  return { passed, failed, total, failedTests: [] }
}

function parsePytestSummary(clean: string): ParsedSummary | null {
  const summaryMatch = clean.match(/=+\s+(.*?)\s+in\s+[\d.]+s\s*=+/)
  if (!summaryMatch) return null
  const summary = summaryMatch[1] ?? ""
  const passedMatch = summary.match(/(\d+)\s+passed/)
  const failedMatch = summary.match(/(\d+)\s+failed/)
  const passed = passedMatch ? Number(passedMatch[1]) : 0
  const failed = failedMatch ? Number(failedMatch[1]) : 0
  const total = passed + failed
  const failedNames: string[] = []
  const failedTests = clean.matchAll(/FAILED\s+(\S+)/g)
  for (const m of failedTests) {
    if (m[1]) failedNames.push(m[1])
  }
  return { passed, failed, total, failedTests: failedNames }
}

function parseGoTestSummary(clean: string): ParsedSummary | null {
  const okMatches = [...clean.matchAll(/^ok\s+\S+/gm)]
  const failMatches = [...clean.matchAll(/^FAIL\s+(\S+)/gm)]
  if (okMatches.length === 0 && failMatches.length === 0) return null
  const failedNames: string[] = []
  const individualFails = clean.matchAll(/---\s+FAIL:\s+(\S+)/g)
  for (const m of individualFails) {
    if (m[1]) failedNames.push(m[1])
  }
  const passLines = [...clean.matchAll(/---\s+PASS:\s+/g)].length
  const passed = passLines || okMatches.length
  const failed = failedNames.length || failMatches.length
  return { passed, failed, total: passed + failed, failedTests: failedNames }
}

function parseCargoTestSummary(clean: string): ParsedSummary | null {
  const resultMatch = clean.match(/test result:\s+\S+\.\s+(\d+)\s+passed;\s+(\d+)\s+failed/)
  if (!resultMatch) return null
  const passed = Number(resultMatch[1])
  const failed = Number(resultMatch[2])
  const failedNames: string[] = []
  const failedTests = clean.matchAll(/test\s+(\S+)\s+\.\.\.\s+FAILED/g)
  for (const m of failedTests) {
    if (m[1]) failedNames.push(m[1])
  }
  return { passed, failed, total: passed + failed, failedTests: failedNames }
}

export function parseSummary(output: string): ParsedSummary {
  const clean = stripAnsi(output)

  const vitest = parseVitestSummary(clean)
  if (vitest) return vitest

  const pytest = parsePytestSummary(clean)
  if (pytest) return pytest

  const goTest = parseGoTestSummary(clean)
  if (goTest) return goTest

  const cargo = parseCargoTestSummary(clean)
  if (cargo) return cargo

  const failedNames: string[] = []
  const failMatch = clean.matchAll(/FAIL\s+(\S+\.test\.ts)/g)
  for (const m of failMatch) {
    if (m[1]) failedNames.push(m[1])
  }
  return { passed: 0, failed: failedNames.length || 0, total: 0, failedTests: failedNames }
}

function pathsTouchBollardGeneratedTests(testFiles: string[] | undefined): boolean {
  if (!testFiles || testFiles.length === 0) return false
  return testFiles.some((f) => f.replace(/\\/g, "/").includes(".bollard/"))
}

export async function runTests(
  workDir: string,
  testFiles?: string[],
  profile?: ToolchainProfile,
): Promise<TestRunResult> {
  let cmd: string
  let args: string[]

  if (pathsTouchBollardGeneratedTests(testFiles)) {
    cmd = "pnpm"
    args = ["exec", "vitest", "run", "-c", "vitest.contract.config.ts", ...(testFiles ?? [])]
  } else if (profile?.checks.test) {
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
