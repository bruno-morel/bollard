import { randomUUID } from "node:crypto"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import type { Blueprint } from "@bollard/engine/src/blueprint.js"
import type { PipelineContext } from "@bollard/engine/src/context.js"
import {
  type NodeSummary,
  RUN_HISTORY_SCHEMA_VERSION,
  type RunRecord,
  type ScopeResult,
  type VerifyRecord,
  type VerifyRecordSource,
} from "@bollard/engine/src/run-history.js"
import type { RunResult } from "@bollard/engine/src/runner.js"
import type { StaticCheckResult } from "@bollard/verify/src/static.js"

const TEST_NODE_IDS = ["run-tests", "run-contract-tests", "run-behavioral-tests"] as const

function isTestRunData(data: unknown): data is { passed: number; failed: number; total: number } {
  if (data === null || typeof data !== "object") return false
  const o = data as Record<string, unknown>
  return (
    typeof o["passed"] === "number" &&
    typeof o["failed"] === "number" &&
    typeof o["total"] === "number"
  )
}

export function extractTestCount(nodeResults: RunResult["nodeResults"]): {
  passed: number
  skipped: number
  failed: number
} {
  let passed = 0
  let failed = 0
  let skipped = 0
  for (const id of TEST_NODE_IDS) {
    const nr = nodeResults[id]
    const data = nr?.data
    if (!isTestRunData(data)) continue
    passed += data.passed
    failed += data.failed
    skipped += Math.max(0, data.total - data.passed - data.failed)
  }
  return { passed, skipped, failed }
}

function readGroundingClaims(data: unknown): {
  proposed?: number
  grounded?: number
  dropped?: number
} {
  if (data === null || typeof data !== "object") return {}
  const o = data as Record<string, unknown>
  if (o["skipped"] === true) return {}
  const claims = Array.isArray(o["claims"]) ? o["claims"] : []
  const dropped = Array.isArray(o["dropped"]) ? o["dropped"] : []
  if (claims.length === 0 && dropped.length === 0 && !("claims" in o) && !("dropped" in o)) {
    return {}
  }
  const grounded = claims.length
  const droppedCount = dropped.length
  return {
    proposed: grounded + droppedCount,
    grounded,
    dropped: droppedCount,
  }
}

export function extractScopeResults(
  ctx: PipelineContext,
  nodeResults: RunResult["nodeResults"],
): ScopeResult[] {
  const profile = ctx.toolchainProfile

  const boundaryEnabled = profile?.adversarial.boundary.enabled ?? false
  const writeTests = nodeResults["write-tests"]?.data as { testFile?: string } | undefined
  const runTests = nodeResults["run-tests"]?.data
  const boundary: ScopeResult = {
    scope: "boundary",
    enabled: boundaryEnabled,
    ...(writeTests?.testFile !== undefined ? { testFile: writeTests.testFile } : {}),
    ...(boundaryEnabled && isTestRunData(runTests)
      ? { testsPassed: runTests.passed, testsFailed: runTests.failed }
      : {}),
  }

  const contractEnabled = profile?.adversarial.contract.enabled ?? false
  const contractGround = readGroundingClaims(nodeResults["verify-claim-grounding"]?.data)
  const contractRun = nodeResults["run-contract-tests"]?.data
  const contract: ScopeResult = {
    scope: "contract",
    enabled: contractEnabled,
    ...(contractGround.proposed !== undefined ? { claimsProposed: contractGround.proposed } : {}),
    ...(contractGround.grounded !== undefined ? { claimsGrounded: contractGround.grounded } : {}),
    ...(contractGround.dropped !== undefined ? { claimsDropped: contractGround.dropped } : {}),
    ...(contractEnabled && isTestRunData(contractRun)
      ? { testsPassed: contractRun.passed, testsFailed: contractRun.failed }
      : {}),
  }

  const behavioralEnabled = profile?.adversarial.behavioral.enabled ?? false
  const behGround = readGroundingClaims(nodeResults["verify-behavioral-grounding"]?.data)
  const behRun = nodeResults["run-behavioral-tests"]?.data
  const behavioral: ScopeResult = {
    scope: "behavioral",
    enabled: behavioralEnabled,
    ...(behGround.proposed !== undefined ? { claimsProposed: behGround.proposed } : {}),
    ...(behGround.grounded !== undefined ? { claimsGrounded: behGround.grounded } : {}),
    ...(behGround.dropped !== undefined ? { claimsDropped: behGround.dropped } : {}),
    ...(behavioralEnabled && isTestRunData(behRun)
      ? { testsPassed: behRun.passed, testsFailed: behRun.failed }
      : {}),
  }

  return [boundary, contract, behavioral]
}

export function extractNodeSummaries(
  blueprint: Blueprint,
  nodeResults: RunResult["nodeResults"],
): NodeSummary[] {
  return blueprint.nodes.map((node) => {
    const nr = nodeResults[node.id]
    const status = nr?.status ?? "block"
    const base: NodeSummary = {
      id: node.id,
      name: node.name,
      type: node.type,
      status,
    }
    if (nr?.cost_usd !== undefined) base.costUsd = nr.cost_usd
    if (nr?.duration_ms !== undefined) base.durationMs = nr.duration_ms
    if (nr?.error !== undefined) base.error = nr.error
    return base
  })
}

export function buildRunRecord(
  ctx: PipelineContext,
  result: RunResult,
  blueprint: Blueprint,
  gitSha: string | undefined,
): RunRecord {
  const testCount = extractTestCount(result.nodeResults)
  const scopes = extractScopeResults(ctx, result.nodeResults)
  const nodes = extractNodeSummaries(blueprint, result.nodeResults)
  const probes = ctx.generatedProbes
  const probeCount = Array.isArray(probes) ? probes.length : undefined

  const record: RunRecord = {
    type: "run",
    schemaVersion: RUN_HISTORY_SCHEMA_VERSION,
    runId: result.runId,
    blueprintId: blueprint.id,
    task: ctx.task,
    timestamp: ctx.startedAt,
    status: result.status,
    totalCostUsd: result.totalCostUsd,
    totalDurationMs: result.totalDurationMs,
    nodes,
    testCount,
    scopes,
  }

  if (result.error !== undefined) {
    record.error = result.error
  }
  if (ctx.mutationScore !== undefined) {
    record.mutationScore = ctx.mutationScore
  }
  if (ctx.toolchainProfile !== undefined) {
    record.toolchainProfile = {
      language: ctx.toolchainProfile.language,
      ...(ctx.toolchainProfile.packageManager !== undefined
        ? { packageManager: ctx.toolchainProfile.packageManager }
        : {}),
    }
  }
  if (ctx.gitBranch !== undefined) {
    record.gitBranch = ctx.gitBranch
  }
  if (gitSha !== undefined) {
    record.gitSha = gitSha
  }
  if (probeCount !== undefined) {
    record.probeCount = probeCount
  }

  return record
}

export function buildVerifyRecord(input: {
  workDir: string
  profile: ToolchainProfile
  results: StaticCheckResult[]
  allPassed: boolean
  startedAt: number
  source?: VerifyRecordSource
  gitSha?: string
}): VerifyRecord {
  const checks = input.results.map((r) => ({
    name: r.check,
    passed: r.passed,
    durationMs: r.durationMs,
  }))
  const totalDurationMs = checks.reduce((s, c) => s + c.durationMs, 0)
  const record: VerifyRecord = {
    type: "verify",
    schemaVersion: RUN_HISTORY_SCHEMA_VERSION,
    runId: `verify-${randomUUID()}`,
    timestamp: input.startedAt,
    workDir: input.workDir,
    source: input.source ?? "cli",
    checks,
    allPassed: input.allPassed,
    totalDurationMs,
    language: input.profile.language,
  }
  if (input.gitSha !== undefined) {
    record.gitSha = input.gitSha
  }
  return record
}
