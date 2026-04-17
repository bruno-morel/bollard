import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { promisify } from "node:util"
import type { AgentTool } from "../types.js"

const execFileAsync = promisify(execFile)

export const searchTool: AgentTool = {
  name: "search",
  description:
    "Search for a pattern in files using ripgrep. By default searches for literal strings. Set regex: true for regex patterns. Returns matching lines with file paths and line numbers.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "The pattern to search for (literal string by default)",
      },
      path: {
        type: "string",
        description: "Directory or file to search in (default: project root)",
      },
      glob: { type: "string", description: "File glob pattern to filter (e.g. '*.ts')" },
      regex: {
        type: "boolean",
        description: "Treat pattern as regex instead of fixed string (default: false)",
      },
    },
    required: ["pattern"],
  },
  async execute(input, ctx) {
    const searchPath = resolve(ctx.workDir, String(input["path"] ?? "."))
    if (!searchPath.startsWith(resolve(ctx.workDir))) {
      throw new Error("Path traversal detected")
    }
    const isRegex = input["regex"] === true
    const args = [
      "-n",
      "--no-heading",
      ...(isRegex ? [] : ["--fixed-strings"]),
      "--glob",
      "!node_modules",
      "--glob",
      "!dist",
      "--glob",
      "!.git",
      ...(input["glob"] ? ["--glob", String(input["glob"])] : []),
      "--max-count",
      "100",
      String(input["pattern"]),
      searchPath,
    ]
    try {
      const { stdout } = await execFileAsync("rg", args, {
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
