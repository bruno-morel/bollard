import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { ALL_TOOLS } from "./tools/index.js"
import type { AgentDefinition } from "./types.js"

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = resolve(THIS_DIR, "../prompts/coder.md")

export async function createCoderAgent(): Promise<AgentDefinition> {
  const systemPrompt = await readFile(PROMPT_PATH, "utf-8")

  return {
    role: "coder",
    systemPrompt,
    tools: ALL_TOOLS,
    maxTurns: 40,
    temperature: 0.3,
    maxTokens: 16384,
  }
}
