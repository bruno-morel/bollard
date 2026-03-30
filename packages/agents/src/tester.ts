import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { AgentDefinition } from "./types.js"

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = resolve(THIS_DIR, "../prompts/tester.md")

export async function createTesterAgent(): Promise<AgentDefinition> {
  const systemPrompt = await readFile(PROMPT_PATH, "utf-8")

  return {
    role: "tester",
    systemPrompt,
    tools: [],
    maxTurns: 5,
    temperature: 0.3,
  }
}
