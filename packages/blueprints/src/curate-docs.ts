import { auditDocs } from "@bollard/engine/src/audit-docs.js"
import type { Blueprint, BlueprintNode, NodeResult } from "@bollard/engine/src/blueprint.js"
import type { BollardConfig } from "@bollard/engine/src/context.js"
import {
  buildDocsCurationCorpus,
  type DocsEdit,
  parseDocsCurationPlan,
  verifyDocsCurationGrounding,
} from "@bollard/engine/src/docs-curation.js"
import type { DriftCandidate } from "@bollard/engine/src/docs-drift-signals.js"
import { selectDriftCandidates } from "@bollard/engine/src/docs-drift-signals.js"
import { resolveCurateScope } from "@bollard/engine/src/docs-resolver.js"
import { detectManagedFileConflicts, FileOwnershipStore } from "@bollard/engine/src/ownership.js"
import {
  applyDocsEdits,
  buildDocsGroundingReport,
  stageDocsEdits,
  writeDocsGroundingReport,
} from "./docs-curation-helpers.js"

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

export async function assessDocsDriftForWorkDir(
  workDir: string,
  docHomes?: string[],
  opts?: { all?: boolean },
): Promise<{
  corpus: string
  fileContents: Record<string, string>
  editable: string[]
  detectOnly: string[]
  allowedFiles: Set<string>
  auditResult: Awaited<ReturnType<typeof auditDocs>>
  auditFailures: string[]
  candidates: DriftCandidate[]
  candidatePaths: string[]
  detectOnlyDrift: DriftCandidate[]
}> {
  const scopeOpts = docHomes !== undefined ? { homes: docHomes } : undefined
  const { editable, detectOnly } = await resolveCurateScope(workDir, scopeOpts)
  const auditResult = await auditDocs(workDir, {
    ...(docHomes !== undefined ? { docHomes } : {}),
  })

  const gitTimeCache = new Map<string, number | null>()
  const driftOpts = { auditResult, gitTimeCache }

  const candidates = await selectDriftCandidates(workDir, editable, {
    ...driftOpts,
    ...(opts?.all === true ? { all: true } : {}),
  })
  const detectOnlyDrift = await selectDriftCandidates(workDir, detectOnly, driftOpts)
  const candidatePaths = candidates.map((c) => c.path)

  const built = await buildDocsCurationCorpus({
    workDir,
    ...(docHomes !== undefined ? { docHomes } : {}),
    contentPaths: candidatePaths,
    auditResult,
    scope: { editable, detectOnly },
  })

  const auditFailures = auditResult.checks.filter((c) => !c.passed).map((c) => c.id)
  return {
    ...built,
    editable,
    detectOnly,
    auditFailures,
    candidates,
    candidatePaths,
    detectOnlyDrift,
  }
}

export function createCurateDocsBlueprint(
  workDir: string,
  config: BollardConfig,
  opts?: { all?: boolean },
): Blueprint {
  const trust = config.takeover?.docs?.trust ?? "review"
  const deferSilentApply = trust === "silent" || trust === "auto-commit"

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

  const detectDocsConflictsNode: BlueprintNode = {
    id: "detect-docs-conflicts",
    name: "Detect Docs Conflicts",
    type: "deterministic",
    onFailure: "skip",
    execute: async (ctx): Promise<NodeResult> => {
      const manifestData = ctx.results["read-ownership-manifest"]?.data as
        | Awaited<ReturnType<FileOwnershipStore["read"]>>
        | undefined
      const manifest = manifestData ?? (await new FileOwnershipStore(workDir).read())

      const scopeOpts =
        ctx.config.docs?.homes !== undefined ? { homes: ctx.config.docs.homes } : undefined
      const { editable } = await resolveCurateScope(workDir, scopeOpts)
      const managedDocs = manifest.bollardManaged.filter((e) => editable.includes(e.path))
      if (managedDocs.length === 0) {
        return { status: "ok", data: { conflicts: [], skipped: true } }
      }

      const scopedManifest = {
        ...manifest,
        bollardManaged: managedDocs,
      }
      const conflicts = await detectManagedFileConflicts(scopedManifest, workDir)
      if (conflicts.length > 0) {
        ctx.log.warn("managed docs file conflicts detected (continuing)", {
          count: conflicts.length,
          paths: conflicts.map((c) => c.filePath),
        })
      }
      return { status: "ok", data: { conflicts } }
    },
  }

  const assessDocsDriftNode: BlueprintNode = {
    id: "assess-docs-drift",
    name: "Assess Docs Drift",
    type: "deterministic",
    execute: async (ctx): Promise<NodeResult> => {
      if (deferSilentApply) {
        ctx.log.warn("docs silent/auto-commit deferred to Phase 2 — human gate required", {
          trust,
        })
      }
      const result = await assessDocsDriftForWorkDir(workDir, ctx.config.docs?.homes, {
        ...(opts?.all === true ? { all: true } : {}),
      })
      return { status: "ok", data: result }
    },
  }

  const generateDocsEditsNode: BlueprintNode = {
    id: "generate-docs-edits",
    name: "Generate Docs Edits",
    type: "agentic",
    agent: "docs-curator",
  }

  const verifyDocsGroundingNode: BlueprintNode = {
    id: "verify-docs-grounding",
    name: "Verify Docs Grounding",
    type: "deterministic",
    onFailure: "skip",
    execute: async (ctx): Promise<NodeResult> => {
      const driftData = ctx.results["assess-docs-drift"]?.data as
        | Awaited<ReturnType<typeof assessDocsDriftForWorkDir>>
        | undefined
      if (driftData === undefined) {
        return { status: "ok", data: { kept: [], dropped: [], skipped: true } }
      }

      const agentResult = ctx.results["generate-docs-edits"]
      const raw =
        typeof agentResult?.data === "string"
          ? agentResult.data
          : JSON.stringify(agentResult?.data ?? { edits: [] })

      let plan: { edits: DocsEdit[] }
      try {
        plan = parseDocsCurationPlan(raw)
      } catch (err: unknown) {
        ctx.log.warn("docs curation plan parse failed", {
          error: err instanceof Error ? err.message : String(err),
        })
        return { status: "ok", data: { kept: [], dropped: [], skipped: true } }
      }

      const result = verifyDocsCurationGrounding(
        plan,
        driftData.corpus,
        driftData.fileContents,
        driftData.allowedFiles,
      )
      ctx.log.info("docs_curation_grounding_result", {
        proposed: plan.edits.length,
        grounded: result.kept.length,
        dropped: result.dropped.length,
      })

      try {
        const report = buildDocsGroundingReport(ctx.runId, driftData.candidates, plan.edits, result)
        await writeDocsGroundingReport(workDir, report)
      } catch (err: unknown) {
        ctx.log.warn("failed to write docs grounding report", {
          error: err instanceof Error ? err.message : String(err),
        })
      }

      if (result.kept.length === 0) {
        return {
          status: "ok",
          data: { kept: [], dropped: result.dropped, skipped: true },
        }
      }

      return { status: "ok", data: { kept: result.kept, dropped: result.dropped } }
    },
  }

  const stageDocsChangesNode: BlueprintNode = {
    id: "stage-docs-changes",
    name: "Stage Docs Changes",
    type: "deterministic",
    execute: async (ctx): Promise<NodeResult> => {
      const groundingData = ctx.results["verify-docs-grounding"]?.data as
        | { kept?: DocsEdit[]; skipped?: boolean }
        | undefined
      const driftData = ctx.results["assess-docs-drift"]?.data as
        | Awaited<ReturnType<typeof assessDocsDriftForWorkDir>>
        | undefined

      if (groundingData?.skipped || !groundingData?.kept?.length || driftData === undefined) {
        return { status: "ok", data: { skipped: true, edits: [] } }
      }

      const staged = await stageDocsEdits(workDir, groundingData.kept, driftData.fileContents)
      return { status: "ok", data: { edits: staged.edits, diffs: staged.diffs } }
    },
  }

  const applyDocsTrustGateNode: BlueprintNode = {
    id: "apply-docs-trust-gate",
    name: "Apply Docs Trust Gate",
    type: "human_gate",
  }

  const applyDocsChangesNode: BlueprintNode = {
    id: "apply-docs-changes",
    name: "Apply Docs Changes",
    type: "deterministic",
    execute: async (ctx): Promise<NodeResult> => {
      const gateData = ctx.results["apply-docs-trust-gate"]?.data as
        | { rejected?: boolean; approved?: boolean; skipped?: boolean }
        | undefined
      if (gateData?.rejected) {
        return { status: "ok", data: { applied: [], rejected: true } }
      }

      const groundingData = ctx.results["verify-docs-grounding"]?.data as
        | { kept?: DocsEdit[]; skipped?: boolean }
        | undefined
      if (groundingData?.skipped || !groundingData?.kept?.length) {
        ctx.log.info("docs curation no progress", { reason: "no grounded edits" })
        return { status: "ok", data: { applied: [], skipped: true } }
      }

      const { applied, skipped } = await applyDocsEdits(workDir, groundingData.kept)
      if (skipped.length > 0) {
        ctx.log.warn("some docs edits skipped during apply", { skipped })
      }
      return { status: "ok", data: { applied, skipped } }
    },
  }

  const verifyPostApplyNode: BlueprintNode = {
    id: "verify-post-apply",
    name: "Verify Post Apply",
    type: "deterministic",
    execute: async (ctx): Promise<NodeResult> => {
      const applyData = ctx.results["apply-docs-changes"]?.data as
        | { applied?: DocsEdit[]; rejected?: boolean; skipped?: boolean }
        | undefined

      if (applyData?.rejected || applyData?.skipped) {
        return { status: "ok", data: { skipped: true } }
      }

      const applied = applyData?.applied ?? []
      if (applied.length === 0) {
        return { status: "ok", data: { skipped: true, reason: "nothing applied" } }
      }

      const auditResult = await auditDocs(workDir, {
        ...(ctx.config.docs?.homes !== undefined ? { docHomes: ctx.config.docs.homes } : {}),
      })
      if (!auditResult.allPassed) {
        const failing = auditResult.checks.filter((c) => !c.passed).map((c) => c.id)
        return {
          status: "fail",
          error: {
            code: "CURATION_OUTPUT_INVALID",
            message: `Post-apply audit-docs failed: ${failing.join(", ")}`,
          },
          data: { auditResult },
        }
      }

      const store = new FileOwnershipStore(workDir)
      const headSha = await getHeadSha(workDir)
      const filesUpdated = new Set<string>()
      for (const edit of applied) {
        filesUpdated.add(edit.file)
      }
      for (const file of filesUpdated) {
        await store.claim(file, "docs", ctx.runId, headSha)
      }

      const manifest = await store.read()
      ctx.ownershipManifest = manifest
      return {
        status: "ok",
        data: { auditPassed: true, updated: filesUpdated.size, manifest },
      }
    },
  }

  return {
    id: "curate-docs",
    name: "Curate Docs",
    nodes: [
      readOwnershipManifestNode,
      detectDocsConflictsNode,
      assessDocsDriftNode,
      generateDocsEditsNode,
      verifyDocsGroundingNode,
      stageDocsChangesNode,
      applyDocsTrustGateNode,
      applyDocsChangesNode,
      verifyPostApplyNode,
    ],
    maxCostUsd: 2,
    maxDurationMinutes: 10,
  }
}
