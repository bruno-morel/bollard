import { readdir, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { AgentTool } from "../types.js"

export const listDirTool: AgentTool = {
  name: "list_dir",
  description:
    "List the contents of a directory. Returns file names with type indicators (/ for directories).",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path to the directory (default: project root)",
      },
    },
  },
  async execute(input, ctx) {
    const dirPath = resolve(ctx.workDir, String(input["path"] ?? "."))
    if (!dirPath.startsWith(resolve(ctx.workDir))) {
      throw new Error("Path traversal detected")
    }
    const entries = await readdir(dirPath)
    const results: string[] = []
    for (const entry of entries) {
      const entryPath = join(dirPath, entry)
      const s = await stat(entryPath)
      results.push(s.isDirectory() ? `${entry}/` : entry)
    }
    return results.join("\n")
  },
}
