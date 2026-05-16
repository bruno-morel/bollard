import { readFile } from "node:fs/promises"

export type CIProvider =
  | "github-actions"
  | "gitlab-ci"
  | "circleci"
  | "jenkins"
  | "buildkite"
  | "google-cloud-build"
  | "aws-codebuild"
  | "azure-pipelines"
  | "travis-ci"
  | "drone"
  | "local"
  | "unknown"

export interface PriorCheckResult {
  check: "typecheck" | "lint" | "test" | "audit" | "secretScan"
  source: "junit-xml" | "ci-step" | "injected"
  passed: boolean
  timestamp: number
  detail?: string
}

export interface CIEnvironment {
  provider: CIProvider
  priorResults: PriorCheckResult[]
  artifactPaths: string[]
}

const ARTIFACT_PATHS_BY_PROVIDER: Record<CIProvider, string[]> = {
  "github-actions": ["test-results", "junit.xml", ".bollard/junit.xml"],
  "gitlab-ci": ["junit.xml", "test-results/junit.xml"],
  circleci: ["~/test-results", "junit.xml"],
  jenkins: ["junit.xml"],
  buildkite: ["junit.xml"],
  "google-cloud-build": ["junit.xml", "test-results/junit.xml"],
  "aws-codebuild": ["junit.xml", "test-results/junit.xml"],
  "azure-pipelines": ["junit.xml", "test-results/**/*.xml"],
  "travis-ci": ["junit.xml"],
  drone: ["junit.xml"],
  local: [],
  unknown: ["junit.xml"],
}

function isCiSet(env: NodeJS.ProcessEnv): boolean {
  const ci = env["CI"]
  if (ci === undefined || ci === "") return false
  if (ci === "false") return false
  return true
}

export function detectCIEnvironment(env: NodeJS.ProcessEnv = process.env): CIEnvironment {
  let provider: CIProvider

  if (env["GITHUB_ACTIONS"] === "true") {
    provider = "github-actions"
  } else if (env["GITLAB_CI"] === "true") {
    provider = "gitlab-ci"
  } else if (env["CIRCLECI"] === "true") {
    provider = "circleci"
  } else if (env["JENKINS_URL"] !== undefined && env["JENKINS_URL"] !== "") {
    provider = "jenkins"
  } else if (env["BUILDKITE"] === "true") {
    provider = "buildkite"
  } else if (env["CLOUD_BUILD_ID"] !== undefined && env["CLOUD_BUILD_ID"] !== "") {
    provider = "google-cloud-build"
  } else if (env["CODEBUILD_BUILD_ID"] !== undefined && env["CODEBUILD_BUILD_ID"] !== "") {
    provider = "aws-codebuild"
  } else if (env["TF_BUILD"] === "True") {
    provider = "azure-pipelines"
  } else if (env["TRAVIS"] === "true") {
    provider = "travis-ci"
  } else if (env["DRONE"] === "true") {
    provider = "drone"
  } else if (isCiSet(env)) {
    provider = "unknown"
  } else {
    provider = "local"
  }

  return {
    provider,
    priorResults: [],
    artifactPaths: ARTIFACT_PATHS_BY_PROVIDER[provider],
  }
}

const TESTSUITE_ATTR_RE =
  /<testsuite\b[^>]*\btests="(\d+)"[^>]*\bfailures="(\d+)"[^>]*\berrors="(\d+)"[^>]*\bskipped="(\d+)"[^>]*(?:\btimestamp="([^"]*)")?/gi

function parseIntAttr(value: string | undefined): number {
  if (value === undefined || value === "") return 0
  const n = Number.parseInt(value, 10)
  return Number.isNaN(n) ? 0 : n
}

function parseJUnitXml(content: string): PriorCheckResult[] {
  let totalTests = 0
  let totalFailures = 0
  let totalErrors = 0
  let totalSkipped = 0
  let latestTimestamp = Number.NaN

  for (const match of content.matchAll(TESTSUITE_ATTR_RE)) {
    totalTests += parseIntAttr(match[1])
    totalFailures += parseIntAttr(match[2])
    totalErrors += parseIntAttr(match[3])
    totalSkipped += parseIntAttr(match[4])
    const ts = match[5]
    if (ts !== undefined && ts !== "") {
      const parsed = Date.parse(ts)
      if (!Number.isNaN(parsed)) {
        latestTimestamp = Number.isNaN(latestTimestamp) ? parsed : Math.max(latestTimestamp, parsed)
      }
    }
  }

  if (totalTests === 0 && totalFailures === 0 && totalErrors === 0 && totalSkipped === 0) {
    return []
  }

  const passed = totalFailures === 0 && totalErrors === 0
  const passedCount = totalTests - totalFailures - totalErrors - totalSkipped
  const failedCount = totalFailures + totalErrors

  return [
    {
      check: "test",
      source: "junit-xml",
      passed,
      timestamp: Number.isNaN(latestTimestamp) ? Date.now() : latestTimestamp,
      detail: `${passedCount} passed, ${failedCount} failed, ${totalSkipped} skipped`,
    },
  ]
}

export async function readJUnitResults(xmlPath: string): Promise<PriorCheckResult[]> {
  try {
    const content = await readFile(xmlPath, "utf-8")
    return parseJUnitXml(content)
  } catch {
    return []
  }
}
