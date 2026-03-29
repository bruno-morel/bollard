import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { Blueprint, NodeResult } from "@bollard/engine/src/blueprint.js"
import type { PipelineContext } from "@bollard/engine/src/context.js"
import { createStaticCheckNode } from "@bollard/verify/src/static.js"

const execFileAsync = promisify(execFile)

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
        id: "run-tests",
        name: "Run Tests",
        type: "deterministic",
        execute: async (): Promise<NodeResult> => {
          try {
            const { stdout, stderr } = await execFileAsync(
              "pnpm",
              ["run", "test", "--reporter=verbose"],
              {
                cwd: workDir,
                maxBuffer: 5 * 1024 * 1024,
                timeout: 300_000,
              },
            )
            return { status: "ok", data: { output: (stdout + stderr).slice(0, 5000) } }
          } catch (err: unknown) {
            const output =
              err && typeof err === "object" && "stdout" in err
                ? String((err as { stdout: string }).stdout)
                : String(err)
            return {
              status: "fail",
              error: { code: "TEST_FAILED", message: output.slice(0, 2000) },
            }
          }
        },
        maxRetries: 1,
        onFailure: "stop",
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
