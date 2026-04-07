import { defaultAdversarialConfig } from "../concerns.js"
import {
  deriveAllowedCommands,
  deriveIgnorePatterns,
  deriveSourcePatterns,
  deriveTestPatterns,
} from "../derive.js"
import type { LanguageId, ToolchainProfile } from "../types.js"

export async function detect(): Promise<Partial<ToolchainProfile> | null> {
  return null
}

export function buildManualProfile(
  language: LanguageId,
  answers: {
    packageManager?: string
    testFramework?: string
    linter?: string
    typeChecker?: string
  },
): ToolchainProfile {
  const extraTools: string[] = []
  if (answers.linter) extraTools.push(answers.linter)
  if (answers.typeChecker) extraTools.push(answers.typeChecker)

  return {
    language,
    checks: {
      ...(answers.typeChecker
        ? {
            typecheck: {
              label: answers.typeChecker,
              cmd: answers.typeChecker,
              args: ["."],
              source: "cli" as const,
            },
          }
        : {}),
      ...(answers.linter
        ? {
            lint: {
              label: answers.linter,
              cmd: answers.linter,
              args: ["."],
              source: "cli" as const,
            },
          }
        : {}),
      ...(answers.testFramework
        ? {
            test: {
              label: answers.testFramework,
              cmd: answers.testFramework,
              args: [],
              source: "cli" as const,
            },
          }
        : {}),
    },
    sourcePatterns: deriveSourcePatterns(language),
    testPatterns: deriveTestPatterns(language),
    ignorePatterns: deriveIgnorePatterns(language),
    allowedCommands: deriveAllowedCommands(language, undefined, extraTools),
    adversarial: defaultAdversarialConfig({ language }),
  }
}
