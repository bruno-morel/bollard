import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { AgentTool } from "../types.js"

export const editFileTool: AgentTool = {
  name: "edit_file",
  description:
    "Edit a file. Two modes:\n" +
    "1. String replacement: provide old_string + new_string. old_string must match exactly once.\n" +
    "2. Line range: provide start_line + end_line + new_string. Replaces lines start_line through end_line (1-based, inclusive).\n" +
    "Prefer line-range mode when you know the line numbers (e.g. from search results).",
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
          "The exact string to find and replace. Must match exactly once in the file. " +
          "Include enough surrounding context to make the match unique. " +
          "Not needed when using start_line/end_line mode.",
      },
      new_string: {
        type: "string",
        description: "The replacement string. Can be empty to delete content.",
      },
      start_line: {
        type: "number",
        description:
          "First line to replace (1-based, inclusive). Use with end_line instead of old_string.",
      },
      end_line: {
        type: "number",
        description:
          "Last line to replace (1-based, inclusive). Use with start_line instead of old_string.",
      },
    },
    required: ["path", "new_string"],
  },
  async execute(input, ctx) {
    const filePath = resolve(ctx.workDir, String(input["path"] ?? ""))
    if (!filePath.startsWith(resolve(ctx.workDir))) {
      throw new Error("Path traversal detected: path must be within the project directory")
    }

    const newString = String(input["new_string"] ?? "")
    const content = await readFile(filePath, "utf-8")

    const startLine = input["start_line"]
    const endLine = input["end_line"]

    // Line-range mode
    if (typeof startLine === "number" && typeof endLine === "number") {
      const lines = content.split("\n")
      const totalLines = lines.length

      if (startLine < 1 || endLine < startLine || startLine > totalLines) {
        return `Error: invalid line range ${startLine}-${endLine} (file has ${totalLines} lines)`
      }

      const cappedEnd = Math.min(endLine, totalLines)
      const before = lines.slice(0, startLine - 1)
      const after = lines.slice(cappedEnd)
      const removedCount = cappedEnd - startLine + 1
      const newLines = newString === "" ? [] : newString.split("\n")
      const updated = [...before, ...newLines, ...after].join("\n")

      await writeFile(filePath, updated, "utf-8")

      return `Replaced lines ${startLine}-${cappedEnd} (${removedCount} line(s)) with ${newLines.length} line(s) in ${String(input["path"])}`
    }

    // String-replacement mode (original behavior)
    const oldString = String(input["old_string"] ?? "")
    if (oldString === "") {
      return "Error: provide either old_string or start_line+end_line"
    }

    const occurrences = content.split(oldString).length - 1

    if (occurrences === 0) {
      return "Error: old_string not found in file. Use search to find the exact text, or use start_line/end_line mode with line numbers from search results."
    }

    if (occurrences > 1) {
      return `Error: old_string appears ${occurrences} times — include more context to make it unique, or use start_line/end_line mode.`
    }

    const matchIndex = content.indexOf(oldString)
    const linesBefore = content.slice(0, matchIndex).split("\n")
    const editStartLine = linesBefore.length
    const oldLines = oldString.split("\n").length
    const newLines = newString.split("\n").length
    const editEndLine = editStartLine + newLines - 1

    const updated = content.replace(oldString, newString)
    await writeFile(filePath, updated, "utf-8")

    return `Replaced ${oldLines} line(s) with ${newLines} line(s) at lines ${editStartLine}-${editEndLine} in ${String(input["path"])}`
  },
}
