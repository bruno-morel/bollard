import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createInterface } from "node:readline"
import {
  applyStagedCurationChanges,
  CURATION_PLAN_FILE,
  type StagedCurationPlan,
} from "@bollard/blueprints/src/curation-helpers.js"
import {
  DOCS_CURATION_PLAN_FILE,
  type StagedDocsPlan,
} from "@bollard/blueprints/src/docs-curation-helpers.js"
import type { BlueprintNode, NodeResult } from "@bollard/engine/src/blueprint.js"
import type { PipelineContext } from "@bollard/engine/src/context.js"
import type { ReviewFinding } from "@bollard/verify/src/review-grounding.js"
import { detectPromotionCandidates, formatPromotionCandidateLabel } from "./promotion-candidates.js"
import { findWorkspaceRoot } from "./workspace-root.js"

function waitForApproval(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  return new Promise((resolve) => {
    rl.question(`\nHUMAN GATE: ${prompt}\n  Approve? (y/n): `, (answer) => {
      rl.close()
      resolve(answer.toLowerCase().startsWith("y"))
    })
  })
}

export async function humanGateHandler(
  node: BlueprintNode,
  ctx: PipelineContext,
): Promise<NodeResult> {
  let prompt = `Node "${node.name}" requires approval.`

  if (node.id === "approve-plan" && ctx.plan) {
    const planStr = typeof ctx.plan === "string" ? ctx.plan : JSON.stringify(ctx.plan, null, 2)
    process.stderr.write(`\n--- Plan ---\n${planStr.slice(0, 3000)}\n--- End Plan ---\n`)
    prompt = "Approve the plan above?"
  }

  if (node.id === "approve-pr") {
    const workDir = findWorkspaceRoot(process.cwd())
    try {
      const candidates = await detectPromotionCandidates(ctx, workDir)
      if (candidates.length > 0) {
        process.stderr.write("\n──────────────────────────────────────────\n")
        process.stderr.write("Promotion candidates\n")
        process.stderr.write("──────────────────────────────────────────\n")
        for (const c of candidates) {
          const label = formatPromotionCandidateLabel(c.scope)
          process.stderr.write(
            `  ✓ ${label} test is passing and not yet promoted:\n    ${c.testFile}\n    Run: bollard promote-test ${c.testFile}\n`,
          )
        }
        process.stderr.write("──────────────────────────────────────────\n")
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`\n  (promotion candidate detection skipped: ${msg})\n`)
    }

    const reviewData = ctx.results["verify-review-grounding"]?.data as
      | { findings?: ReviewFinding[] }
      | undefined
    const findings = reviewData?.findings ?? []
    if (findings.length > 0) {
      process.stderr.write(`\n--- Semantic review (${findings.length} finding(s)) ---\n`)
      for (const f of findings) {
        process.stderr.write(`[${f.severity}] ${f.id} (${f.category}): ${f.finding}\n`)
        if (f.suggestion) {
          process.stderr.write(`  Suggestion: ${f.suggestion}\n`)
        }
      }
      process.stderr.write("--- End semantic review ---\n")
    }

    const diffResult = ctx.results["generate-diff"]
    if (diffResult?.data && typeof diffResult.data === "object" && "diff" in diffResult.data) {
      const diff = String((diffResult.data as { diff: string }).diff)
      process.stderr.write(`\n--- Diff Summary ---\n${diff.slice(0, 3000)}\n--- End Diff ---\n`)
    }
    prompt = "Approve the changes above for PR?"
  }

  if (node.id === "apply-curation-trust-gate") {
    const workDir = findWorkspaceRoot(process.cwd())
    try {
      const raw = await readFile(resolve(workDir, CURATION_PLAN_FILE), "utf-8")
      const plan = JSON.parse(raw) as StagedCurationPlan
      process.stderr.write("\n--- Staged Curation Plan ---\n")
      for (const action of plan.actions) {
        process.stderr.write(`  [${action.action}] ${action.filePath}`)
        if (action.destPath) {
          process.stderr.write(` → ${action.destPath}`)
        }
        process.stderr.write("\n")
      }
      process.stderr.write("--- End Staged Plan ---\n")
    } catch {
      process.stderr.write("\n  (no staged curation plan found)\n")
    }
    prompt = "Apply the staged curation changes above?"
  }

  if (node.id === "apply-docs-trust-gate") {
    const workDir = findWorkspaceRoot(process.cwd())
    try {
      const raw = await readFile(resolve(workDir, DOCS_CURATION_PLAN_FILE), "utf-8")
      const plan = JSON.parse(raw) as StagedDocsPlan
      process.stderr.write("\n--- Staged Docs Curation Plan ---\n")
      for (const edit of plan.edits) {
        process.stderr.write(`  [${edit.id}] ${edit.file}: ${edit.rationale}\n`)
      }
      process.stderr.write("\n--- Diff Previews ---\n")
      for (const [file, diff] of Object.entries(plan.diffs ?? {})) {
        process.stderr.write(`\n### ${file}\n${diff ?? ""}`)
      }
      process.stderr.write("--- End Staged Docs Plan ---\n")
    } catch {
      process.stderr.write("\n  (no staged docs curation plan found)\n")
    }
    prompt = "Apply the staged docs edits above?"
  }

  if (process.env["BOLLARD_AUTO_APPROVE"] === "1") {
    process.stderr.write(`\nHUMAN GATE: ${prompt}\n  Auto-approved (BOLLARD_AUTO_APPROVE=1)\n`)
    if (node.id === "apply-curation-trust-gate") {
      const workDir = findWorkspaceRoot(process.cwd())
      const { applied } = await applyStagedCurationChanges(workDir)
      return { status: "ok", data: { applied, autoApproved: true } }
    }
    if (node.id === "apply-docs-trust-gate") {
      return { status: "ok", data: { approved: true, autoApproved: true } }
    }
    return { status: "ok", data: `Auto-approved at gate "${node.id}"` }
  }

  const approved = await waitForApproval(prompt)

  if (!approved) {
    if (node.id === "apply-curation-trust-gate") {
      return { status: "ok", data: { rejected: true, applied: [] } }
    }
    if (node.id === "apply-docs-trust-gate") {
      return { status: "ok", data: { rejected: true, applied: [] } }
    }
    return {
      status: "block",
      error: { code: "HUMAN_REJECTED", message: `Human rejected at gate "${node.id}"` },
    }
  }

  if (node.id === "apply-curation-trust-gate") {
    const workDir = findWorkspaceRoot(process.cwd())
    const { applied } = await applyStagedCurationChanges(workDir)
    return { status: "ok", data: { applied } }
  }

  if (node.id === "apply-docs-trust-gate") {
    return { status: "ok", data: { approved: true } }
  }

  return { status: "ok", data: `Approved by human at gate "${node.id}"` }
}
