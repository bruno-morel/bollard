import { basename, join } from "node:path"
import { BollardError } from "./errors.js"
import type { TestOwnershipManifest } from "./ownership.js"
import type { RunRecord } from "./run-history.js"
import type { PromotedManifest } from "./test-fingerprint.js"

export interface TestQualityScore {
  /** Relative path from workDir. */
  filePath: string
  /** 0–100. Higher is better quality / less need for curation. */
  score: number
  /** Mutation score from most recent RunRecord, if available. */
  mutationScore?: number
  /** True when this file is in the ownership manifest's bollardManaged list. */
  isManaged: boolean
  /**
   * True when a promoted adversarial test covers the same source module,
   * making this test potentially redundant.
   */
  coveredByAdversarial: boolean
  /** RunID of the last curation pass that touched this file (from manifest). */
  lastCuratedRunId?: string
}

export interface CurationCandidate {
  /** Short unique id, e.g. "c1". */
  id: string
  /** What action the curator proposes. */
  action: "promote" | "prune" | "rewrite"
  /** Relative path from workDir. */
  filePath: string
  /** Natural language rationale. */
  claim: string
  /**
   * Grounding objects. Each quote must be a verbatim substring of the
   * quality report text or manifest summary the agent received.
   */
  grounding: Array<{ quote: string; source: "quality-report" | "manifest" | "history" }>
}

export interface CurationPlan {
  candidates: CurationCandidate[]
}

export interface CurationGroundingResult {
  kept: CurationCandidate[]
  dropped: Array<{ id: string; reason: string }>
}

const BOLLARD_TEST_PREFIXES = [
  ".bollard/tests/boundary/",
  ".bollard/tests/contract/",
  ".bollard/tests/behavioral/",
]

function stripTestSuffix(path: string): string {
  return (
    path
      .replace(/\.adversarial\.test\.[jt]sx?$/, "")
      .replace(/\.test\.[jt]sx?$/, "")
      .split("/")
      .at(-1) ?? ""
  )
}

function moduleBasename(path: string): string {
  return stripTestSuffix(path.replace(/\\/g, "/"))
}

function findMutationScore(records: RunRecord[]): number | undefined {
  for (const record of records) {
    if (record.type !== "run") continue
    if (record.testCount.passed <= 0) continue
    if (record.mutationScore !== undefined) {
      return record.mutationScore
    }
  }
  return undefined
}

function isCoveredByAdversarial(filePath: string, promoted: PromotedManifest): boolean {
  const base = moduleBasename(filePath)
  if (base.length === 0) return false
  for (const entry of promoted.promoted) {
    if (moduleBasename(entry.sourcePath) === base) return true
    if (moduleBasename(entry.destPath) === base) return true
  }
  return false
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score))
}

/**
 * Score the quality of a single test file using available signals from
 * run history and the ownership/promoted manifests.
 */
export function assessTestQuality(
  filePath: string,
  manifest: TestOwnershipManifest,
  promoted: PromotedManifest,
  records: RunRecord[],
): TestQualityScore {
  const managedEntry = manifest.bollardManaged.find((e) => e.path === filePath)
  const isManaged = managedEntry !== undefined
  const mutationScore = findMutationScore(records)
  const coveredByAdversarial = isCoveredByAdversarial(filePath, promoted)

  let base = 50
  if (mutationScore !== undefined) {
    if (mutationScore >= 80) {
      base += 30
    } else if (mutationScore >= 60) {
      base += 15
    } else {
      base -= 20
    }
  }
  if (coveredByAdversarial) {
    base -= 15
  }
  if (!isManaged) {
    base += 5
  }

  const score: TestQualityScore = {
    filePath,
    score: clampScore(base),
    isManaged,
    coveredByAdversarial,
  }
  if (mutationScore !== undefined) {
    score.mutationScore = mutationScore
  }
  if (managedEntry !== undefined) {
    score.lastCuratedRunId = managedEntry.lastCuratedRunId
  }
  return score
}

/**
 * Return adversarial test paths from `.bollard/` that have been promoted
 * (Signal 1 — caught a real bug) and are not yet in bollardManaged.
 */
export function promoteAdversarialTests(
  manifest: TestOwnershipManifest,
  promoted: PromotedManifest,
  _threshold = 1,
): string[] {
  const managedPaths = new Set(manifest.bollardManaged.map((e) => e.path))
  return promoted.promoted
    .filter((p) => p.hash.length > 0)
    .filter((p) => !managedPaths.has(p.sourcePath) && !managedPaths.has(p.destPath))
    .slice(0, 20)
    .map((p) => p.sourcePath)
}

/**
 * Return managed test files that are fully covered by a promoted adversarial test
 * for the same source module — candidates for pruning.
 */
export function pruneRedundantTests(
  managed: TestOwnershipManifest["bollardManaged"],
  promoted: PromotedManifest,
): string[] {
  const promotedModules = new Set<string>()
  for (const p of promoted.promoted) {
    const srcBase = moduleBasename(p.sourcePath)
    const destBase = moduleBasename(p.destPath)
    if (srcBase.length > 0) promotedModules.add(srcBase)
    if (destBase.length > 0) promotedModules.add(destBase)
  }
  return managed.filter((e) => promotedModules.has(moduleBasename(e.path))).map((e) => e.path)
}

export function buildCurationCorpus(
  scores: TestQualityScore[],
  manifest: TestOwnershipManifest,
): string {
  return [
    JSON.stringify(scores, null, 2),
    `managed: ${manifest.bollardManaged.length} files`,
    `userOwned: ${manifest.userOwned.length} files`,
  ].join("\n")
}

export function verifyCurationGrounding(
  plan: CurationPlan,
  corpus: string,
): CurationGroundingResult {
  const kept: CurationCandidate[] = []
  const dropped: CurationGroundingResult["dropped"] = []
  for (const candidate of plan.candidates) {
    const allGrounded = candidate.grounding.every((g) => corpus.includes(g.quote))
    if (candidate.grounding.length === 0 || !allGrounded) {
      dropped.push({ id: candidate.id, reason: "grounding_not_in_corpus" })
    } else {
      kept.push(candidate)
    }
  }
  return { kept, dropped }
}

function stripOptionalFences(raw: string): string {
  let result = raw.trim()
  result = result.replace(/^```\w*\n/, "")
  result = result.replace(/\n```\s*$/, "")
  return result.trim()
}

function isValidCurationCandidate(value: unknown): value is CurationCandidate {
  if (value === null || typeof value !== "object") return false
  const c = value as Record<string, unknown>
  if (typeof c["id"] !== "string") return false
  if (c["action"] !== "promote" && c["action"] !== "prune" && c["action"] !== "rewrite") {
    return false
  }
  if (typeof c["filePath"] !== "string") return false
  if (typeof c["claim"] !== "string") return false
  if (!Array.isArray(c["grounding"])) return false
  for (const g of c["grounding"]) {
    if (g === null || typeof g !== "object") return false
    const gr = g as Record<string, unknown>
    if (typeof gr["quote"] !== "string") return false
    const src = gr["source"]
    if (src !== "quality-report" && src !== "manifest" && src !== "history") return false
  }
  return true
}

export function parseCurationPlan(raw: string): CurationPlan {
  const trimmed = stripOptionalFences(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (err: unknown) {
    throw new BollardError({
      code: "CURATION_OUTPUT_INVALID",
      message: `Failed to parse curation plan JSON: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new BollardError({
      code: "CURATION_OUTPUT_INVALID",
      message: "Curation plan must be a JSON object",
    })
  }
  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj["candidates"])) {
    throw new BollardError({
      code: "CURATION_OUTPUT_INVALID",
      message: "Curation plan must have a candidates array",
    })
  }
  const candidates = obj["candidates"]
  if (candidates.length === 0) {
    return { candidates: [] }
  }
  if (!candidates.every(isValidCurationCandidate)) {
    throw new BollardError({
      code: "CURATION_OUTPUT_INVALID",
      message: "One or more curation candidates failed schema validation",
    })
  }
  return { candidates: candidates as CurationCandidate[] }
}

function stripBollardTestPrefix(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/")
  for (const prefix of BOLLARD_TEST_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return normalized.slice(prefix.length)
    }
  }
  return basename(normalized)
}

/**
 * Derive the destination path for promoting an adversarial test from `.bollard/`
 * to the main test suite (mirrors promote-test CLI logic).
 */
export function derivePromotionDestPath(sourcePath: string): string {
  const normalized = sourcePath.replace(/\\/g, "/")
  const fileName = basename(normalized)
  const stripped = stripBollardTestPrefix(normalized)
  return join("tests", stripped === fileName ? fileName : stripped).replace(/\\/g, "/")
}
