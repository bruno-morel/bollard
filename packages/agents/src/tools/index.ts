import type { AgentTool } from "../types.js"
import { editFileTool } from "./edit-file.js"
import { listDirTool } from "./list-dir.js"
import { readFileTool } from "./read-file.js"
import { runCommandTool } from "./run-command.js"
import { searchTool } from "./search.js"
import { writeFileTool } from "./write-file.js"

export const ALL_TOOLS: AgentTool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  searchTool,
  runCommandTool,
]

export const READ_ONLY_TOOLS: AgentTool[] = [readFileTool, listDirTool, searchTool]
