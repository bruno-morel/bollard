import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import type { Blueprint, BlueprintNode, NodeResult } from "@bollard/engine/src/blueprint.js"
import type { BollardConfig } from "@bollard/engine/src/context.js"
import { detectManagedFileConflicts, FileOwnershipStore } from "@bollard/engine/src/ownership.js"
import { FileRunHistoryStore } from "@bollard/engine/src/run-history.js"
import { readPromotedManifest } from "@bollard/engine/src/test-fingerprint.js"
import {
  assessTestQuality,
  buildCurationCorpus,
  derivePromotionDestPath,
  parseCurationPlan,
  promoteAdversarialTests,
  pruneRedundantTests,
  verifyCurationGrounding,
} from "@bollard/engine/src/test-quality.js"
import { runTests } from "@bollard/verify/src/dynamic.js"
import {
  applyStagedCurationChanges,
  CURATION_PLAN_FILE,
  CURATION_STAGING_DIR,
  type StagedCurationAction,
  type StagedCurationPlan,
  stagingPathForSource,
} from "./curation-helpers.js"

async function getHeadSha(workDir: string): Promise<string> {
  try {
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const execFileAsync = promisify(execFile)
    const { stdout } = await execFileAsync("git", ["-C", workDir, "rev-parse", "HEAD"], {
      maxBuffer: 64 * 1024,
    })
    const sha = stdout.trim()
    return sha.length > 0 ? sha : "unknown"
  } catch {
    return "unknown"
  }
}

export async function assessTestQualityForWorkDir(workDir: string): Promise<{
  scores: import("@bollard/engine/src/test-quality.js").TestQualityScore[]
  promotionCandidates: string[]
  pruneCandidates: string[]
  manifest: Awaited<ReturnType<FileOwnershipStore["read"]>>
  skipped: boolean
}> {
  const store = new FileOwnershipStore(workDir)
  const manifest = await store.read()
  const promoted = await readPromotedManifest(workDir)
  const historyStore = new FileRunHistoryStore(workDir)
  const records = (await historyStore.query({ limit: 10 })).filter(
    (r): r is import("@bollard/engine/src/run-history.js").RunRecord => r.type === "run",
  )

  const promotionCandidates = promoteAdversarialTests(manifest, promoted)
  const pruneCandidates = pruneRedundantTests(manifest.bollardManaged, promoted)

  const scores = manifest.bollardManaged.map((entry) =>
    assessTestQuality(entry.path, manifest, promoted, records),
  )

  const skipped = manifest.bollardManaged.length === 0 && promotionCandidates.length === 0

  return { scores, promotionCandidates, pruneCandidates, manifest, skipped }
}

export function createCurateTestsBlueprint(workDir: string, config: BollardConfig): Blueprint {
  const trust = config.takeover?.tests?.trust ?? "review"
  const useSilentApply = trust === "silent"

  const readOwnershipManifestNode: BlueprintNode = {
    id: "read-ownership-manifest",
    name: "Read Ownership Manifest",
    type: "deterministic",
    execute: async (ctx): Promise<NodeResult> => {
      const store = new FileOwnershipStore(workDir)
      const manifest = await store.read()
      ctx.ownershipManifest = manifest
      return { status: "ok", data: manifest }
    },
  }

  const detectTestConflictsNode: BlueprintNode = {
    id: "detect-test-conflicts",
    name: "Detect Test Conflicts",
    type: "deterministic",
    onFailure: "skip",
    execute: async (ctx): Promise<NodeResult> => {
      const manifestData = ctx.results["read-ownership-manifest"]?.data as
        | Awaited<ReturnType<FileOwnershipStore["read"]>>
        | undefined
      const manifest = manifestData ?? (await new FileOwnershipStore(workDir).read())

      if (manifest.bollardManaged.length === 0) {
        return { status: "ok", data: { conflicts: [], skipped: true } }
      }

      const conflicts = await detectManagedFileConflicts(manifest, workDir)
      if (conflicts.length > 0) {
        ctx.log.warn("managed file conflicts detected (continuing)", {
          count: conflicts.length,
          paths: conflicts.map((c) => c.filePath),
        })
      }
      return { status: "ok", data: { conflicts } }
    },
  }

  const assessTestQualityNode: BlueprintNode = {
    id: "assess-test-quality",
    name: "Assess Test Quality",
    type: "deterministic",
    execute: async (): Promise<NodeResult> => {
      const result = await assessTestQualityForWorkDir(workDir)
      if (result.skipped) {
        return {
          status: "ok",
          data: {
            scores: [],
            promotionCandidates: [],
            pruneCandidates: [],
            skipped: true,
          },
        }
      }
      return {
        status: "ok",
        data: {
          scores: result.scores,
          promotionCandidates: result.promotionCandidates,
          pruneCandidates: result.pruneCandidates,
        },
      }
    },
  }

  const generateCurationCandidatesNode: BlueprintNode = {
    id: "generate-curation-candidates",
    name: "Generate Curation Candidates",
    type: "agentic",
    agent: "test-curator",
  }

  const verifyCurationGroundingNode: BlueprintNode = {
    id: "verify-curation-grounding",
    name: "Verify Curation Grounding",
    type: "deterministic",
    onFailure: "skip",
    execute: async (ctx): Promise<NodeResult> => {
      const assessData = ctx.results["assess-test-quality"]?.data as
        | {
            scores?: import("@bollard/engine/src/test-quality.js").TestQualityScore[]
            skipped?: boolean
          }
        | undefined
      if (assessData?.skipped) {
        return { status: "ok", data: { kept: [], dropped: [], skipped: true } }
      }

      const agentResult = ctx.results["generate-curation-candidates"]
      const raw =
        typeof agentResult?.data === "string"
          ? agentResult.data
          : JSON.stringify(agentResult?.data ?? { candidates: [] })

      const manifest = ctx.ownershipManifest ?? (await new FileOwnershipStore(workDir).read())
      const scores = assessData?.scores ?? []
      const corpus = buildCurationCorpus(scores, manifest)

      let plan: import("@bollard/engine/src/test-quality.js").CurationPlan
      try {
        plan = parseCurationPlan(raw)
      } catch (err: unknown) {
        ctx.log.warn("curation plan parse failed", {
          error: err instanceof Error ? err.message : String(err),
        })
        return { status: "ok", data: { kept: [], dropped: [], skipped: true } }
      }

      const result = verifyCurationGrounding(plan, corpus)
      ctx.log.info("curation_grounding_result", {
        proposed: plan.candidates.length,
        grounded: result.kept.length,
        dropped: result.dropped.length,
      })

      if (result.kept.length === 0) {
        return {
          status: "ok",
          data: { kept: [], dropped: result.dropped, skipped: true },
        }
      }

      return { status: "ok", data: { kept: result.kept, dropped: result.dropped } }
    },
  }

  const stageCurationChangesNode: BlueprintNode = {
    id: "stage-curation-changes",
    name: "Stage Curation Changes",
    type: "deterministic",
    execute: async (ctx): Promise<NodeResult> => {
      const groundingData = ctx.results["verify-curation-grounding"]?.data as
        | {
            kept?: import("@bollard/engine/src/test-quality.js").CurationCandidate[]
            skipped?: boolean
          }
        | undefined

      if (groundingData?.skipped || !groundingData?.kept?.length) {
        return { status: "ok", data: { actions: [], skipped: true } }
      }

      const stagingRoot = resolve(workDir, CURATION_STAGING_DIR)
      await mkdir(stagingRoot, { recursive: true })

      const actions: StagedCurationAction[] = []

      for (const candidate of groundingData.kept) {
        if (candidate.action === "promote") {
          const sourceFull = resolve(workDir, candidate.filePath)
          const stagedRel = stagingPathForSource(candidate.filePath)
          const stagedFull = resolve(workDir, stagedRel)
          await mkdir(dirname(stagedFull), { recursive: true })
          const content = await readFile(sourceFull, "utf-8")
          await writeFile(stagedFull, content, "utf-8")
          actions.push({
            id: candidate.id,
            action: "promote",
            filePath: candidate.filePath,
            destPath: derivePromotionDestPath(candidate.filePath),
            stagedPath: stagedRel,
          })
        } else if (candidate.action === "prune") {
          const markerRel = join(CURATION_STAGING_DIR, `${basename(candidate.filePath)}.prune`)
          await writeFile(resolve(workDir, markerRel), candidate.filePath, "utf-8")
          actions.push({
            id: candidate.id,
            action: "prune",
            filePath: candidate.filePath,
          })
        } else if (candidate.action === "rewrite") {
          const sourceFull = resolve(workDir, candidate.filePath)
          const stagedRel = join(CURATION_STAGING_DIR, `${basename(candidate.filePath)}.staged`)
          const stagedFull = resolve(workDir, stagedRel)
          const original = await readFile(sourceFull, "utf-8")
          const header = `// @bollard-curation-staged — rewrite pending (run ${ctx.runId})\n`
          await writeFile(stagedFull, header + original, "utf-8")
          actions.push({
            id: candidate.id,
            action: "rewrite",
            filePath: candidate.filePath,
            stagedPath: stagedRel,
          })
        }
      }

      const plan: StagedCurationPlan = { actions }
      await writeFile(resolve(workDir, CURATION_PLAN_FILE), JSON.stringify(plan, null, 2), "utf-8")

      return { status: "ok", data: { actions } }
    },
  }

  const runStagedTestsNode: BlueprintNode = {
    id: "run-staged-tests",
    name: "Run Staged Tests",
    type: "deterministic",
    onFailure: "skip",
    execute: async (ctx): Promise<NodeResult> => {
      const stageData = ctx.results["stage-curation-changes"]?.data as
        | { actions?: StagedCurationAction[]; skipped?: boolean }
        | undefined

      if (stageData?.skipped || !stageData?.actions?.length) {
        return { status: "ok", data: { skipped: true } }
      }

      const promoteActions = stageData.actions.filter((a) => a.action === "promote")
      if (promoteActions.length === 0) {
        return { status: "ok", data: { skipped: true, reason: "no promote actions" } }
      }

      const backups: Array<{ dest: string; backup: string | null }> = []

      try {
        for (const action of promoteActions) {
          if (!action.destPath || !action.stagedPath) continue
          const destFull = resolve(workDir, action.destPath)
          const stagedFull = resolve(workDir, action.stagedPath)
          let backup: string | null = null
          try {
            const existing = await readFile(destFull, "utf-8")
            backup = existing
          } catch {
            backup = null
          }
          backups.push({ dest: destFull, backup })
          await mkdir(dirname(destFull), { recursive: true })
          await copyFile(stagedFull, destFull)
        }

        const testFiles = promoteActions
          .map((a) => a.destPath)
          .filter((p): p is string => p !== undefined)

        const result = await runTests(workDir, testFiles, ctx.toolchainProfile)
        return {
          status: result.failed === 0 ? "ok" : "fail",
          data: {
            passed: result.passed,
            failed: result.failed,
            testFiles,
          },
        }
      } finally {
        for (const { dest, backup } of backups) {
          if (backup !== null) {
            await writeFile(dest, backup, "utf-8")
          } else {
            try {
              const { unlink } = await import("node:fs/promises")
              await unlink(dest)
            } catch {
              // ignore
            }
          }
        }
      }
    },
  }

  const applyCurationTrustGateSilentNode: BlueprintNode = {
    id: "apply-curation-trust-gate",
    name: "Apply Curation Trust Gate",
    type: "deterministic",
    execute: async (): Promise<NodeResult> => {
      const { applied } = await applyStagedCurationChanges(workDir)
      return { status: "ok", data: { applied, autoApplied: true } }
    },
  }

  const applyCurationTrustGateReviewNode: BlueprintNode = {
    id: "apply-curation-trust-gate",
    name: "Apply Curation Trust Gate",
    type: "human_gate",
  }

  const updateOwnershipManifestNode: BlueprintNode = {
    id: "update-ownership-manifest",
    name: "Update Ownership Manifest",
    type: "deterministic",
    execute: async (ctx): Promise<NodeResult> => {
      const applyData = ctx.results["apply-curation-trust-gate"]?.data as
        | { applied?: StagedCurationAction[]; skipped?: boolean; rejected?: boolean }
        | undefined

      if (applyData?.rejected || applyData?.skipped) {
        return { status: "ok", data: { skipped: true } }
      }

      const applied = applyData?.applied ?? []
      if (applied.length === 0) {
        return { status: "ok", data: { skipped: true, reason: "nothing applied" } }
      }

      const store = new FileOwnershipStore(workDir)
      const headSha = await getHeadSha(workDir)

      for (const action of applied) {
        if (action.action === "prune") {
          await store.release(action.filePath)
        } else if (action.action === "promote") {
          const claimPath = action.destPath ?? derivePromotionDestPath(action.filePath)
          await store.claim(claimPath, "tests", ctx.runId, headSha)
        } else if (action.action === "rewrite") {
          await store.claim(action.filePath, "tests", ctx.runId, headSha)
        }
      }

      const manifest = await store.read()
      ctx.ownershipManifest = manifest
      return { status: "ok", data: { updated: applied.length, manifest } }
    },
  }

  const applyNode = useSilentApply
    ? applyCurationTrustGateSilentNode
    : applyCurationTrustGateReviewNode

  return {
    id: "curate-tests",
    name: "Curate Tests",
    nodes: [
      readOwnershipManifestNode,
      detectTestConflictsNode,
      assessTestQualityNode,
      generateCurationCandidatesNode,
      verifyCurationGroundingNode,
      stageCurationChangesNode,
      runStagedTestsNode,
      applyNode,
      updateOwnershipManifestNode,
    ],
    maxCostUsd: 2,
    maxDurationMinutes: 10,
  }
}
