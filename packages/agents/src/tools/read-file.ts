import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { AgentTool } from "../types.js"

export const readFileTool: AgentTool = {
  name: "read_file",
  description: "Read the contents of a file. Returns the file content as a string.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path to the file from the project root" },
    },
    required: ["path"],
  },
  async execute(input, ctx) {
    const filePath = resolve(ctx.workDir, String(input["path"] ?? ""))
    if (!filePath.startsWith(resolve(ctx.workDir))) {
      throw new Error("Path traversal detected: path must be within the project directory")
    }
    const content = await readFile(filePath, "utf-8")
    return content
  },
}
