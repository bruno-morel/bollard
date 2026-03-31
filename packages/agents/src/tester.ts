import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { fillPromptTemplate } from "./prompt-template.js"
import type { AgentDefinition } from "./types.js"

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = resolve(THIS_DIR, "../prompts/tester.md")

export async function createTesterAgent(profile?: ToolchainProfile): Promise<AgentDefinition> {
  const template = await readFile(PROMPT_PATH, "utf-8")
  const systemPrompt = profile ? fillPromptTemplate(template, profile) : template

  return {
    role: "tester",
    systemPrompt,
    tools: [],
    maxTurns: 5,
    temperature: 0.3,
  }
}
