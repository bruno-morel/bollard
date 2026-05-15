import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { AgentTool } from "../types.js"

const MAX_LINES = 200

export const readFileTool: AgentTool = {
  name: "read_file",
  description:
    "Read the contents of a file. Returns up to 200 lines by default. Use offset and limit to read specific ranges of large files.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path to the file from the project root" },
      offset: {
        type: "number",
        description: "Line number to start reading from (1-based, default: 1)",
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to return (default: 200, max: 200)",
      },
    },
    required: ["path"],
  },
  async execute(input, ctx) {
    const filePath = resolve(ctx.workDir, String(input["path"] ?? ""))
    if (!filePath.startsWith(resolve(ctx.workDir))) {
      throw new Error("Path traversal detected: path must be within the project directory")
    }
    const content = await readFile(filePath, "utf-8")
    const lines = content.split("\n")
    const totalLines = lines.length
    const offset = Math.max(0, (Number(input["offset"] ?? 1) || 1) - 1)
    const limit = Math.min(MAX_LINES, Number(input["limit"] ?? MAX_LINES) || MAX_LINES)
    const slice = lines.slice(offset, offset + limit)
    const result = slice.join("\n")
    if (totalLines > offset + limit) {
      return `${result}\n[...truncated: showing lines ${offset + 1}–${offset + limit} of ${totalLines}. Use offset=${offset + limit + 1} to read more.]`
    }
    return result
  },
}
