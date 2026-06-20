import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import type { AgentDefinition } from "./types.js"

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = resolve(THIS_DIR, "../prompts/docs-curator.md")

export async function createDocsCuratorAgent(
  _profile?: ToolchainProfile,
): Promise<AgentDefinition> {
  const systemPrompt = await readFile(PROMPT_PATH, "utf-8")
  return {
    role: "docs-curator",
    systemPrompt,
    tools: [],
    maxTurns: 10,
    maxTokens: 8192,
    temperature: 0.3,
  }
}
