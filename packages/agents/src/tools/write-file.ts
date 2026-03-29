import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { AgentTool } from "../types.js"

export const writeFileTool: AgentTool = {
  name: "write_file",
  description:
    "Write content to a file. Creates parent directories if needed. Overwrites existing files.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path to the file from the project root" },
      content: { type: "string", description: "The content to write to the file" },
    },
    required: ["path", "content"],
  },
  async execute(input, ctx) {
    const filePath = resolve(ctx.workDir, String(input["path"] ?? ""))
    if (!filePath.startsWith(resolve(ctx.workDir))) {
      throw new Error("Path traversal detected: path must be within the project directory")
    }
    const content = String(input["content"] ?? "")
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, content, "utf-8")
    return `Written ${content.length} bytes to ${String(input["path"])}`
  },
}
