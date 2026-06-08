import { access, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { PipelineContext } from "@bollard/engine/src/context.js"
import type { ScopeResult } from "@bollard/engine/src/run-history.js"
import {
  extractFingerprint,
  isAlreadyPromoted,
  readPromotedManifest,
} from "@bollard/engine/src/test-fingerprint.js"

export interface PromotionCandidate {
  scope: ScopeResult["scope"]
  testFile: string
}

const SCOPE_NODES: Array<{
  scope: ScopeResult["scope"]
  writeNodeId: string
  runNodeId: string
  label: string
}> = [
  {
    scope: "boundary",
    writeNodeId: "write-tests",
    runNodeId: "run-tests",
    label: "Boundary",
  },
  {
    scope: "contract",
    writeNodeId: "write-contract-tests",
    runNodeId: "run-contract-tests",
    label: "Contract",
  },
  {
    scope: "behavioral",
    writeNodeId: "write-behavioral-tests",
    runNodeId: "run-behavioral-tests",
    label: "Behavioral",
  },
]

function readTestFileFromNode(data: unknown): string | undefined {
  if (data === null || typeof data !== "object") return undefined
  const testFile = (data as Record<string, unknown>)["testFile"]
  return typeof testFile === "string" && testFile.length > 0 ? testFile : undefined
}

export async function detectPromotionCandidates(
  ctx: PipelineContext,
  workDir: string,
): Promise<PromotionCandidate[]> {
  const coderMadeEdits = ctx.changedFiles.length > 0
  if (!coderMadeEdits) {
    return []
  }

  const manifest = await readPromotedManifest(workDir)
  const candidates: PromotionCandidate[] = []

  for (const { scope, writeNodeId, runNodeId } of SCOPE_NODES) {
    const testFile = readTestFileFromNode(ctx.results[writeNodeId]?.data)
    if (testFile === undefined) continue

    const runStatus = ctx.results[runNodeId]?.status
    if (runStatus !== "ok") continue

    const fullPath = resolve(workDir, testFile)
    try {
      await access(fullPath)
    } catch {
      continue
    }

    const content = await readFile(fullPath, "utf-8")
    const fp = extractFingerprint(testFile, content, scope)
    if (isAlreadyPromoted(manifest, fp.hash)) continue

    candidates.push({ scope, testFile })
  }

  return candidates
}

export function formatPromotionCandidateLabel(scope: ScopeResult["scope"]): string {
  const entry = SCOPE_NODES.find((s) => s.scope === scope)
  return entry?.label ?? scope
}
