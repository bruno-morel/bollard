import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"

export type TestLifecycle = "ephemeral" | "persistent-native" | "persistent-isolated"

export interface AdversarialTestSet {
  featureSlug: string
  runId: string
  lifecycle: TestLifecycle
  testFiles: string[]
  language: string
  framework: string
  createdAt: string
}

export interface TestMetadata {
  blueprintId: string
  runId: string
  task: string
  featureSlug: string
  generatedAt: string
  agentModel: string
  testFramework: string
  testCount: number
  replaces: string | null
}

export function resolveLifecycle(profile?: ToolchainProfile): TestLifecycle {
  if (profile?.adversarial.persist) {
    return "persistent-native"
  }
  return "ephemeral"
}

export function resolveTestOutputDir(
  workDir: string,
  runId: string,
  featureSlug: string,
  lifecycle: TestLifecycle,
  mode: "blackbox" | "native",
): string {
  if (lifecycle === "persistent-native") {
    return join(workDir, ".bollard", "tests", featureSlug)
  }
  return join(workDir, ".bollard", "runs", runId, `adversarial-${mode}`)
}

export async function writeTestMetadata(outputDir: string, metadata: TestMetadata): Promise<void> {
  const metaPath = join(outputDir, "_bollard.json")
  await writeFile(metaPath, JSON.stringify(metadata, null, 2), "utf-8")
}

export interface IntegrationCheck {
  alreadyIntegrated: boolean
  suggestion: string
}

export async function checkTestRunnerIntegration(
  workDir: string,
  profile: ToolchainProfile,
): Promise<IntegrationCheck> {
  const lang = profile.language
  const testLabel = profile.checks.test?.label?.toLowerCase() ?? ""

  if (lang === "go") {
    return { alreadyIntegrated: false, suggestion: "persistent-isolated fallback" }
  }

  if (lang === "python" && (testLabel.includes("pytest") || testLabel === "")) {
    return checkPytestIntegration(workDir)
  }

  if (
    (lang === "typescript" || lang === "javascript") &&
    (testLabel.includes("vitest") || testLabel.includes("jest"))
  ) {
    return {
      alreadyIntegrated: false,
      suggestion: `include .bollard/tests/**/*.test.* in ${testLabel} config`,
    }
  }

  if (lang === "rust") {
    return {
      alreadyIntegrated: false,
      suggestion: "add [[test]] target in Cargo.toml for .bollard/tests/",
    }
  }

  return { alreadyIntegrated: false, suggestion: "manual integration required" }
}

async function checkPytestIntegration(workDir: string): Promise<IntegrationCheck> {
  const pyprojectPath = join(workDir, "pyproject.toml")
  try {
    const content = await readFile(pyprojectPath, "utf-8")
    if (content.includes(".bollard/tests")) {
      return {
        alreadyIntegrated: true,
        suggestion: "pyproject.toml already includes .bollard/tests",
      }
    }
    return {
      alreadyIntegrated: false,
      suggestion: "add .bollard/tests to testpaths in pyproject.toml",
    }
  } catch {
    return {
      alreadyIntegrated: false,
      suggestion: "use --rootdir flag to include .bollard/tests",
    }
  }
}
