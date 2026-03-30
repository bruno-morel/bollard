import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { promisify } from "node:util"
import type { Blueprint, NodeResult } from "@bollard/engine/src/blueprint.js"
import type { PipelineContext } from "@bollard/engine/src/context.js"
import { BollardError } from "@bollard/engine/src/errors.js"
import { createTestRunNode } from "@bollard/verify/src/dynamic.js"
import { createStaticCheckNode } from "@bollard/verify/src/static.js"
import {
  extractPrivateIdentifiers,
  extractSignaturesFromFiles,
} from "@bollard/verify/src/type-extractor.js"

const execFileAsync = promisify(execFile)

function getAffectedTsFiles(plan: unknown): string[] {
  if (!plan || typeof plan !== "object") return []
  const af = (plan as Record<string, unknown>)["affected_files"] as
    | Record<string, string[]>
    | undefined
  if (!af) return []
  return [...(af["modify"] ?? []), ...(af["create"] ?? [])].filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
  )
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

      createStaticCheckNode(workDir),

      {
        id: "extract-signatures",
        name: "Extract Type Signatures",
        type: "deterministic",
        execute: async (ctx: PipelineContext): Promise<NodeResult> => {
          const files = getAffectedTsFiles(ctx.plan)
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

          const files = getAffectedTsFiles(ctx.plan)
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

      createTestRunNode(workDir),

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
