import { access } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { detectCIEnvironment, readJUnitResults } from "@bollard/verify/src/ci-environment.js"

export function parseCiPassed(args: string[]): string[] {
  const idx = args.indexOf("--ci-passed")
  if (idx === -1 || idx + 1 >= args.length) return []

  const raw = args[idx + 1] ?? ""
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function resolveArtifactPath(workDir: string, artifactPath: string): string {
  if (artifactPath.startsWith("~/")) {
    return resolve(homedir(), artifactPath.slice(2))
  }
  return resolve(workDir, artifactPath)
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function collectAutoDetectedSkipChecks(workDir: string): Promise<string[]> {
  const ciEnv = detectCIEnvironment(process.env)
  if (ciEnv.provider === "local" || ciEnv.provider === "unknown") {
    return []
  }

  const skipNames: string[] = []

  for (const artifactPath of ciEnv.artifactPaths) {
    const resolved = resolveArtifactPath(workDir, artifactPath)
    if (!(await pathExists(resolved))) continue

    const prior = await readJUnitResults(resolved)
    for (const result of prior) {
      if (result.passed) {
        skipNames.push(result.check)
      }
    }
  }

  return skipNames
}

export async function resolveSkipChecks(workDir: string, args: string[]): Promise<string[]> {
  const explicit = parseCiPassed(args)
  const autoDetected = await collectAutoDetectedSkipChecks(workDir)
  return [...new Set([...explicit, ...autoDetected])]
}

export function formatSkippedChecksNotice(skipChecks: string[]): string {
  return `ⓘ  Skipping checks already passed in CI: ${skipChecks.join(", ")}`
}
