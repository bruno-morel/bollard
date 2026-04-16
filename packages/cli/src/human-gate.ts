import { createInterface } from "node:readline"
import type { BlueprintNode, NodeResult } from "@bollard/engine/src/blueprint.js"
import type { PipelineContext } from "@bollard/engine/src/context.js"
import type { ReviewFinding } from "@bollard/verify/src/review-grounding.js"

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

  if (process.env["BOLLARD_AUTO_APPROVE"] === "1") {
    process.stderr.write(`\nHUMAN GATE: ${prompt}\n  Auto-approved (BOLLARD_AUTO_APPROVE=1)\n`)
    return { status: "ok", data: `Auto-approved at gate "${node.id}"` }
  }

  const approved = await waitForApproval(prompt)

  if (!approved) {
    return {
      status: "block",
      error: { code: "HUMAN_REJECTED", message: `Human rejected at gate "${node.id}"` },
    }
  }

  return { status: "ok", data: `Approved by human at gate "${node.id}"` }
}
