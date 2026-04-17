import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import type { DeploymentTracker, DriftDetector, DriftReport } from "./providers/types.js"

const execFileAsync = promisify(execFile)

export interface GitDriftDetectorOptions {
  workDir: string
  deploymentTracker: DeploymentTracker
  verifiedRelativePath?: string
}

function classifyFile(path: string): "test" | "config" | "source" {
  const lower = path.toLowerCase()
  if (
    lower.includes("/tests/") ||
    lower.includes(".test.") ||
    lower.includes(".spec.") ||
    lower.endsWith("_test.go")
  ) {
    return "test"
  }
  if (
    lower.endsWith(".yml") ||
    lower.endsWith(".yaml") ||
    lower.includes("dockerfile") ||
    lower.includes("compose") ||
    lower.endsWith(".tf") ||
    lower.includes("terraform") ||
    lower.includes("infra/") ||
    lower.includes(".bollard.yml")
  ) {
    return "config"
  }
  return "source"
}

export class GitDriftDetector implements DriftDetector {
  private readonly workDir: string
  private readonly deploymentTracker: DeploymentTracker
  private readonly verifiedPath: string

  constructor(opts: GitDriftDetectorOptions) {
    this.workDir = opts.workDir
    this.deploymentTracker = opts.deploymentTracker
    this.verifiedPath = join(
      opts.workDir,
      opts.verifiedRelativePath ?? ".bollard/observe/last-verified.json",
    )
  }

  async check(): Promise<DriftReport> {
    const deployed = await this.deploymentTracker.getCurrent()
    const deployedSha = deployed?.deploymentId ?? ""

    let verifiedSha = ""
    try {
      const raw = await readFile(this.verifiedPath, "utf-8")
      const parsed = JSON.parse(raw) as { sha?: string }
      verifiedSha = typeof parsed.sha === "string" ? parsed.sha : ""
    } catch {
      verifiedSha = ""
    }

    if (!deployedSha || !verifiedSha) {
      return {
        hasDrift: false,
        deployedSha,
        verifiedSha,
        driftedFiles: [],
        driftedConfigs: [],
        severity: "low",
        recommendation: "ignore",
      }
    }

    if (deployedSha === verifiedSha) {
      return {
        hasDrift: false,
        deployedSha,
        verifiedSha,
        driftedFiles: [],
        driftedConfigs: [],
        severity: "low",
        recommendation: "ignore",
      }
    }

    let names: string
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", this.workDir, "diff", "--name-only", verifiedSha, deployedSha],
        { maxBuffer: 10 * 1024 * 1024 },
      )
      names = stdout
    } catch {
      return {
        hasDrift: true,
        deployedSha,
        verifiedSha,
        driftedFiles: [],
        driftedConfigs: [],
        severity: "high",
        recommendation: "investigate",
      }
    }

    const files = names
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)

    const driftedFiles: string[] = []
    const driftedConfigs: string[] = []
    let maxSev: "low" | "medium" | "high" = "low"

    for (const f of files) {
      const c = classifyFile(f)
      if (c === "test") {
        driftedFiles.push(f)
        maxSev = maxRank(maxSev, "low")
      } else if (c === "config") {
        driftedConfigs.push(f)
        maxSev = maxRank(maxSev, "high")
      } else {
        driftedFiles.push(f)
        maxSev = maxRank(maxSev, "medium")
      }
    }

    const recommendation: DriftReport["recommendation"] =
      maxSev === "low" ? "ignore" : maxSev === "medium" ? "reconcile" : "investigate"

    return {
      hasDrift: files.length > 0,
      deployedSha,
      verifiedSha,
      driftedFiles,
      driftedConfigs,
      severity: maxSev,
      recommendation,
    }
  }
}

function maxRank(
  a: "low" | "medium" | "high",
  b: "low" | "medium" | "high",
): "low" | "medium" | "high" {
  const o = { low: 0, medium: 1, high: 2 }
  return o[a] >= o[b] ? a : b
}
