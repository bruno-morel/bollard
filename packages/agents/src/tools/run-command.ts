import { execFile } from "node:child_process"
import { resolve, sep } from "node:path"
import { promisify } from "node:util"
import type { AgentTool } from "../types.js"

const execFileAsync = promisify(execFile)

const DEFAULT_ALLOWED_COMMANDS = [
  "pnpm",
  "npx",
  "node",
  "tsc",
  "biome",
  "git",
  "cat",
  "head",
  "tail",
  "wc",
  "diff",
  "rm",
]

export const runCommandTool: AgentTool = {
  name: "run_command",
  description:
    "Execute a shell command. Only whitelisted commands are allowed. Returns stdout and stderr.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run (e.g. 'pnpm run test')" },
      cwd: {
        type: "string",
        description: "Working directory relative to project root (default: root)",
      },
    },
    required: ["command"],
  },
  async execute(input, ctx) {
    const cmdStr = String(input["command"] ?? "")
    const parts = cmdStr.split(/\s+/)
    const executable = parts[0]
    const allowed = ctx.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS

    if (!executable || !allowed.includes(executable)) {
      throw new Error(`Command "${executable}" is not allowed. Allowed: ${allowed.join(", ")}`)
    }

    const cwd = resolve(ctx.workDir, String(input["cwd"] ?? "."))
    if (!cwd.startsWith(resolve(ctx.workDir))) {
      throw new Error("Path traversal detected")
    }

    if (executable === "rm") {
      if (parts.includes("-rf") || parts.includes("-r")) {
        throw new Error("Recursive rm is not allowed. Delete files individually.")
      }
      const workRoot = resolve(ctx.workDir)
      const rmTargets = parts.slice(1).filter((arg) => !arg.startsWith("-"))
      for (const target of rmTargets) {
        const resolvedTarget = resolve(cwd, target)
        const inside = resolvedTarget === workRoot || resolvedTarget.startsWith(workRoot + sep)
        if (!inside) {
          throw new Error(`rm target "${target}" is outside the work directory`)
        }
      }
    }

    try {
      const { stdout, stderr } = await execFileAsync(executable, parts.slice(1), {
        cwd,
        maxBuffer: 2 * 1024 * 1024,
        timeout: 180_000,
        env: { ...process.env, NODE_ENV: "test" },
      })
      let result = ""
      if (stdout) result += `stdout:\n${stdout}\n`
      if (stderr) result += `stderr:\n${stderr}\n`
      return result || "(no output)"
    } catch (err: unknown) {
      if (err && typeof err === "object" && "stdout" in err) {
        const e = err as { stdout: string; stderr: string; code: number }
        return `Command failed (exit ${String(e.code)}):\nstdout:\n${e.stdout}\nstderr:\n${e.stderr}`
      }
      throw err
    }
  },
}
