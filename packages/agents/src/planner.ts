import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { READ_ONLY_TOOLS } from "./tools/index.js"
import type { AgentDefinition } from "./types.js"

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = resolve(THIS_DIR, "../prompts/planner.md")

export async function createPlannerAgent(): Promise<AgentDefinition> {
  const systemPrompt = await readFile(PROMPT_PATH, "utf-8")

  return {
    role: "planner",
    systemPrompt,
    tools: READ_ONLY_TOOLS,
    maxTurns: 25,
    temperature: 0.2,
  }
}
