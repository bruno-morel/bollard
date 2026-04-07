import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defaultAdversarialConfig } from "@bollard/detect/src/concerns.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { fillPromptTemplate } from "./prompt-template.js"
import type { AgentDefinition } from "./types.js"

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = resolve(THIS_DIR, "../prompts/boundary-tester.md")

const FALLBACK_PROFILE: ToolchainProfile = {
  language: "typescript",
  checks: {},
  sourcePatterns: [],
  testPatterns: [],
  ignorePatterns: [],
  allowedCommands: [],
  adversarial: defaultAdversarialConfig({ language: "typescript" }),
}

export async function createBoundaryTesterAgent(
  profile?: ToolchainProfile,
): Promise<AgentDefinition> {
  const template = await readFile(PROMPT_PATH, "utf-8")
  const p = profile ?? FALLBACK_PROFILE
  const systemPrompt = fillPromptTemplate(template, p, p.adversarial.boundary.concerns)

  return {
    role: "boundary-tester",
    systemPrompt,
    tools: [],
    maxTurns: 5,
    temperature: 0.3,
  }
}
