import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { promisify } from "node:util"
import type { Blueprint, NodeResult } from "@bollard/engine/src/blueprint.js"
import type { PipelineContext } from "@bollard/engine/src/context.js"
import { BollardError } from "@bollard/engine/src/errors.js"
import { runTests } from "@bollard/verify/src/dynamic.js"
import { runStaticChecks } from "@bollard/verify/src/static.js"
import {
  extractPrivateIdentifiers,
  extractSignaturesFromFiles,
} from "@bollard/verify/src/type-extractor.js"

const execFileAsync = promisify(execFile)

function getAffectedSourceFiles(ctx: PipelineContext): string[] {
  const plan = ctx.plan
  if (!plan || typeof plan !== "object") return []
  const af = (plan as Record<string, unknown>)["affected_files"] as
    | Record<string, string[]>
    | undefined
  if (!af) return []

  const allFiles = [...(af["modify"] ?? []), ...(af["create"] ?? [])]
  const profile = ctx.toolchainProfile

  if (profile) {
    const srcExts = profile.sourcePatterns
      .filter((p) => p.startsWith("**/*."))
      .map((p) => p.replace("**/*", ""))
    const testExts = profile.testPatterns
      .filter((p) => p.startsWith("**/*."))
      .map((p) => p.replace("**/*", ""))

    return allFiles.filter((f) => {
      if (testExts.some((ext) => f.endsWith(ext))) return false
      if (f.includes(".test.") || f.includes(".spec.") || f.includes("test_")) return false
      return srcExts.length === 0 || srcExts.some((ext) => f.endsWith(ext))
    })
  }

  return allFiles.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
}

export function createImplementFeatureBlueprint(workDir: string): Blueprint {
  return {
    id: "implement-feature",
    name: "Implement Feature",
    nodes: [
      {
        id: "create-branch",
        name: "Create Git Branch",
        type: "deterministic",
        execute: async (ctx: PipelineContext): Promise<NodeResult> => {
          const branchName = `bollard/${ctx.runId}`
          try {
            await execFileAsync("git", ["checkout", "-b", branchName], { cwd: workDir })
            ctx.gitBranch = branchName
            return { status: "ok", data: { branch: branchName } }
          } catch (err: unknown) {
            return {
              status: "fail",
              error: {
                code: "NODE_EXECUTION_FAILED",
                message: err instanceof Error ? err.message : String(err),
              },
            }
          }
        },
      },

      {
        id: "generate-plan",
        name: "Generate Plan",
        type: "agentic",
        agent: "planner",
      },

      {
        id: "approve-plan",
        name: "Approve Plan",
        type: "human_gate",
      },

      {
        id: "implement",
        name: "Implement Code",
        type: "agentic",
        agent: "coder",
        maxRetries: 1,
        onFailure: "stop",
      },

      {
        id: "static-checks",
        name: "Static Verification",
        type: "deterministic",
        execute: async (ctx: PipelineContext): Promise<NodeResult> => {
          const { results, allPassed } = await runStaticChecks(workDir, ctx.toolchainProfile)
          if (!allPassed) {
            const failures = results.filter((r) => !r.passed).map((r) => r.check)
            return {
              status: "fail",
              data: results,
              error: {
                code: "STATIC_CHECK_FAILED",
                message: `Static checks failed: ${failures.join(", ")}`,
              },
            }
          }
          return { status: "ok", data: results }
        },
      },

      {
        id: "extract-signatures",
        name: "Extract Type Signatures",
        type: "deterministic",
        execute: async (ctx: PipelineContext): Promise<NodeResult> => {
          const profile = ctx.toolchainProfile
          if (profile && profile.language !== "typescript") {
            // TODO: Stage 2 -- add signature extraction for non-TS languages
            return { status: "ok", data: { filesExtracted: 0, signatures: [] } }
          }

          const files = getAffectedSourceFiles(ctx)
          if (files.length === 0) {
            return { status: "ok", data: { filesExtracted: 0, signatures: [] } }
          }

          const fullPaths = files.map((f) => resolve(workDir, f))
          const signatures = await extractSignaturesFromFiles(fullPaths)

          return {
            status: "ok",
            data: {
              filesExtracted: files.length,
              signatures,
            },
          }
        },
      },

      {
        id: "generate-tests",
        name: "Generate Adversarial Tests",
        type: "agentic",
        agent: "tester",
      },

      {
        id: "write-tests",
        name: "Write Adversarial Test Files",
        type: "deterministic",
        execute: async (ctx: PipelineContext): Promise<NodeResult> => {
          const testerResult = ctx.results["generate-tests"]
          const testerOutput = typeof testerResult?.data === "string" ? testerResult.data : ""

          if (!testerOutput) {
            return {
              status: "fail",
              error: {
                code: "NODE_EXECUTION_FAILED",
                message: "No test output from tester agent",
              },
            }
          }

          const files = getAffectedSourceFiles(ctx)
          const leakedTokens: string[] = []

          for (const filePath of files) {
            try {
              const source = await readFile(resolve(workDir, filePath), "utf-8")
              const privateIds = extractPrivateIdentifiers(filePath, source)
              for (const id of privateIds) {
                if (testerOutput.includes(id)) {
                  leakedTokens.push(id)
                }
              }
            } catch {
              // File might not exist yet (newly created) — skip
            }
          }

          if (leakedTokens.length > 0) {
            const unique = [...new Set(leakedTokens)]
            throw new BollardError({
              code: "POSTCONDITION_FAILED",
              message: `Information leak detected in adversarial tests: [${unique.join(", ")}]`,
              context: { leakedTokens: unique, sourceFiles: files },
            })
          }

          const firstFile = files[0]
          if (!firstFile) {
            return {
              status: "fail",
              error: {
                code: "NODE_EXECUTION_FAILED",
                message: "No affected files to generate tests for",
              },
            }
          }

          const testPath = firstFile.replace(/\.ts$/, ".adversarial.test.ts")
          const fullPath = resolve(workDir, testPath)
          await mkdir(dirname(fullPath), { recursive: true })
          await writeFile(fullPath, testerOutput, "utf-8")

          return {
            status: "ok",
            data: { testFile: testPath, bytesWritten: testerOutput.length },
          }
        },
      },

      {
        id: "run-tests",
        name: "Run Tests",
        type: "deterministic",
        execute: async (ctx: PipelineContext): Promise<NodeResult> => {
          const result = await runTests(workDir, undefined, ctx.toolchainProfile)
          if (result.failed > 0) {
            return {
              status: "fail",
              data: result,
              error: {
                code: "TEST_FAILED",
                message: `${result.failed}/${result.total} tests failed: ${result.failedTests.join(", ")}`,
              },
            }
          }
          return { status: "ok", data: result }
        },
      },

      {
        id: "generate-diff",
        name: "Generate Diff Summary",
        type: "deterministic",
        execute: async (): Promise<NodeResult> => {
          try {
            const { stdout } = await execFileAsync("git", ["diff", "--stat", "main"], {
              cwd: workDir,
              maxBuffer: 2 * 1024 * 1024,
            })
            return { status: "ok", data: { diff: stdout } }
          } catch (err: unknown) {
            return {
              status: "fail",
              error: {
                code: "NODE_EXECUTION_FAILED",
                message: err instanceof Error ? err.message : String(err),
              },
            }
          }
        },
      },

      {
        id: "approve-pr",
        name: "Review & Approve Changes",
        type: "human_gate",
      },
    ],
    maxCostUsd: 15,
    maxDurationMinutes: 30,
  }
}
