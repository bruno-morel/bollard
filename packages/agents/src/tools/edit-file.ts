import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { AgentTool } from "../types.js"

export const editFileTool: AgentTool = {
  name: "edit_file",
  description:
    "Replace a specific string in a file with new content. The old_string must appear exactly once in the file. Use this for surgical edits instead of rewriting entire files.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path to the file from the project root",
      },
      old_string: {
        type: "string",
        description:
          "The exact string to find and replace. Must match exactly once in the file. Include enough surrounding context to make the match unique.",
      },
      new_string: {
        type: "string",
        description: "The replacement string. Can be empty to delete the matched content.",
      },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute(input, ctx) {
    const filePath = resolve(ctx.workDir, String(input["path"] ?? ""))
    if (!filePath.startsWith(resolve(ctx.workDir))) {
      throw new Error("Path traversal detected: path must be within the project directory")
    }

    const oldString = String(input["old_string"] ?? "")
    const newString = String(input["new_string"] ?? "")

    if (oldString === "") {
      return "Error: old_string cannot be empty"
    }

    const content = await readFile(filePath, "utf-8")
    const occurrences = content.split(oldString).length - 1

    if (occurrences === 0) {
      return "Error: old_string not found in file"
    }

    if (occurrences > 1) {
      return `Error: old_string appears ${occurrences} times — include more context to make it unique`
    }

    const matchIndex = content.indexOf(oldString)
    const linesBefore = content.slice(0, matchIndex).split("\n")
    const startLine = linesBefore.length
    const oldLines = oldString.split("\n").length
    const newLines = newString.split("\n").length
    const endLine = startLine + newLines - 1

    const updated = content.replace(oldString, newString)
    await writeFile(filePath, updated, "utf-8")

    return `Replaced ${oldLines} line(s) with ${newLines} line(s) at lines ${startLine}-${endLine} in ${String(input["path"])}`
  },
}
