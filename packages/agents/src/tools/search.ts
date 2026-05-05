import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { promisify } from "node:util"
import type { AgentTool } from "../types.js"

const execFileAsync = promisify(execFile)

const AUTO_FALLBACK_PREFIX = "[auto-fallback: regex parse error, searched as literal string]"

function buildRgArgs(
  pattern: string,
  searchPath: string,
  glob: string | undefined,
  fixedStrings: boolean,
): string[] {
  return [
    "-n",
    "--no-heading",
    ...(fixedStrings ? ["--fixed-strings"] : []),
    "--glob",
    "!node_modules",
    "--glob",
    "!dist",
    "--glob",
    "!.git",
    ...(glob ? ["--glob", glob] : []),
    "--max-count",
    "100",
    pattern,
    searchPath,
  ]
}

function isExitCode(err: unknown, code: number): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: unknown }).code === code
  )
}

export const searchTool: AgentTool = {
  name: "search",
  description:
    "Search for a pattern in files using ripgrep. By default searches for literal strings (recommended for most searches). " +
    "Set regex: true ONLY when you need regex features like \\d, .*, or alternation. " +
    "WARNING: With regex: true, characters like [ ] ( ) { } $ . + * ? | ^ must be escaped with \\. " +
    "If your search fails with a parse error, retry WITHOUT regex: true.",
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
        description:
          "Treat pattern as regex instead of fixed string (default: false). " +
          "Only use when you need regex features. Brackets, parens, dots, and $ must be escaped.",
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
    const pattern = String(input["pattern"])
    const glob = input["glob"] ? String(input["glob"]) : undefined
    const args = buildRgArgs(pattern, searchPath, glob, !isRegex)

    const renderOutput = (stdout: string): string => {
      const lines = stdout.split("\n").slice(0, 100)
      return lines.join("\n") || "No matches found."
    }

    try {
      const { stdout } = await execFileAsync("rg", args, {
        maxBuffer: 1024 * 1024,
        timeout: 10_000,
      })
      return renderOutput(stdout)
    } catch (err: unknown) {
      if (isExitCode(err, 1)) {
        return "No matches found."
      }
      if (isRegex && isExitCode(err, 2)) {
        const fallbackArgs = buildRgArgs(pattern, searchPath, glob, true)
        try {
          const { stdout } = await execFileAsync("rg", fallbackArgs, {
            maxBuffer: 1024 * 1024,
            timeout: 10_000,
          })
          return `${AUTO_FALLBACK_PREFIX}\n${renderOutput(stdout)}`
        } catch (fallbackErr: unknown) {
          if (isExitCode(fallbackErr, 1)) {
            return `${AUTO_FALLBACK_PREFIX}\nNo matches found.`
          }
          throw fallbackErr
        }
      }
      throw err
    }
  },
}
