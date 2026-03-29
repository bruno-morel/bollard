import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { promisify } from "node:util"
import type { AgentTool } from "../types.js"

const execFileAsync = promisify(execFile)

export const searchTool: AgentTool = {
  name: "search",
  description:
    "Search for a pattern in files using grep. Returns matching lines with file paths and line numbers.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The regex pattern to search for" },
      path: {
        type: "string",
        description: "Directory or file to search in (default: project root)",
      },
      glob: { type: "string", description: "File glob pattern to filter (e.g. '*.ts')" },
    },
    required: ["pattern"],
  },
  async execute(input, ctx) {
    const searchPath = resolve(ctx.workDir, String(input["path"] ?? "."))
    if (!searchPath.startsWith(resolve(ctx.workDir))) {
      throw new Error("Path traversal detected")
    }
    const args = [
      "-rn",
      "--exclude-dir=node_modules",
      "--exclude-dir=dist",
      "--exclude-dir=.git",
      "--include",
      String(input["glob"] ?? "*"),
      "-e",
      String(input["pattern"]),
      searchPath,
    ]
    try {
      const { stdout } = await execFileAsync("grep", args, {
        maxBuffer: 1024 * 1024,
        timeout: 10_000,
      })
      const lines = stdout.split("\n").slice(0, 100)
      return lines.join("\n") || "No matches found."
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && err.code === 1) {
        return "No matches found."
      }
      throw err
    }
  },
}
