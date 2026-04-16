import { BollardError } from "@bollard/engine/src/errors.js"
import { normaliseForComparison } from "./contract-grounding.js"

export type ReviewSeverity = "info" | "warning" | "error"

export type ReviewCategory =
  | "plan-divergence"
  | "missing-coverage"
  | "unintended-change"
  | "error-handling"
  | "naming-consistency"
  | "api-compatibility"

export interface ReviewGrounding {
  quote: string
  source: "diff" | "plan"
}

export interface ReviewFinding {
  id: string
  severity: ReviewSeverity
  category: ReviewCategory
  finding: string
  grounding: ReviewGrounding[]
  file?: string
  suggestion?: string
}

export interface ReviewDocument {
  findings: ReviewFinding[]
}

export interface ReviewCorpus {
  entries: Array<{ text: string; source: "diff" | "plan" }>
}

export interface DroppedReviewFinding {
  id: string
  reason:
    | "grounding_empty"
    | "grounding_not_in_corpus"
    | "severity_invalid"
    | "category_invalid"
    | "duplicate_id"
    | "schema_invalid"
    | "grounding_source_mismatch"
  detail?: string
}

export interface ReviewVerificationResult {
  kept: ReviewFinding[]
  dropped: DroppedReviewFinding[]
}

const VALID_SEVERITIES = new Set<string>(["info", "warning", "error"])
const VALID_CATEGORIES = new Set<string>([
  "plan-divergence",
  "missing-coverage",
  "unintended-change",
  "error-handling",
  "naming-consistency",
  "api-compatibility",
])

function stripOptionalFences(raw: string): string {
  let result = raw.trim()
  result = result.replace(/^```\w*\n/, "")
  result = result.replace(/\n```\s*$/, "")
  return result.trim()
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val)
}

function validateFindingShape(raw: unknown, index: number): ReviewFinding | DroppedReviewFinding {
  if (!isPlainObject(raw)) {
    return {
      id: `findings[${index}]`,
      reason: "schema_invalid",
      detail: "finding is not an object",
    }
  }

  const obj = raw as Record<string, unknown>

  if (typeof obj["id"] !== "string" || obj["id"].length === 0) {
    return {
      id: `findings[${index}]`,
      reason: "schema_invalid",
      detail: "missing or non-string id",
    }
  }

  const id = obj["id"] as string

  if (typeof obj["severity"] !== "string") {
    return { id, reason: "schema_invalid", detail: "missing or non-string severity" }
  }
  if (typeof obj["category"] !== "string") {
    return { id, reason: "schema_invalid", detail: "missing or non-string category" }
  }
  if (typeof obj["finding"] !== "string" || obj["finding"].length === 0) {
    return { id, reason: "schema_invalid", detail: "missing or empty finding" }
  }
  if (!Array.isArray(obj["grounding"])) {
    return { id, reason: "schema_invalid", detail: "grounding is not an array" }
  }

  const groundingRaw = obj["grounding"] as unknown[]
  const grounding: ReviewGrounding[] = []
  for (const g of groundingRaw) {
    if (!isPlainObject(g)) {
      return { id, reason: "schema_invalid", detail: "grounding item is not an object" }
    }
    const gi = g as Record<string, unknown>
    if (typeof gi["quote"] !== "string") {
      return { id, reason: "schema_invalid", detail: "grounding item missing quote" }
    }
    if (gi["source"] !== "diff" && gi["source"] !== "plan") {
      return { id, reason: "schema_invalid", detail: "grounding item source must be diff or plan" }
    }
    grounding.push({
      quote: gi["quote"] as string,
      source: gi["source"] as "diff" | "plan",
    })
  }

  const out: ReviewFinding = {
    id,
    severity: obj["severity"] as ReviewSeverity,
    category: obj["category"] as ReviewCategory,
    finding: obj["finding"] as string,
    grounding,
  }

  if (typeof obj["file"] === "string") {
    out.file = obj["file"]
  }
  if (typeof obj["suggestion"] === "string") {
    out.suggestion = obj["suggestion"]
  }

  return out
}

function isReviewFinding(val: ReviewFinding | DroppedReviewFinding): val is ReviewFinding {
  return "finding" in val && typeof (val as ReviewFinding).finding === "string"
}

export function parseReviewDocument(raw: string): ReviewDocument {
  const stripped = stripOptionalFences(raw)

  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch (err: unknown) {
    throw new BollardError({
      code: "REVIEW_OUTPUT_INVALID",
      message: `Failed to parse review document as JSON: ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  if (!isPlainObject(parsed)) {
    throw new BollardError({
      code: "REVIEW_OUTPUT_INVALID",
      message: "Review document must be a JSON object with a findings array",
    })
  }

  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj["findings"])) {
    throw new BollardError({
      code: "REVIEW_OUTPUT_INVALID",
      message: "Review document must have a top-level findings array",
    })
  }

  const findings: ReviewFinding[] = []
  const schemaDrops: DroppedReviewFinding[] = []

  for (let i = 0; i < (obj["findings"] as unknown[]).length; i++) {
    const result = validateFindingShape((obj["findings"] as unknown[])[i], i)
    if (isReviewFinding(result)) {
      findings.push(result)
    } else {
      schemaDrops.push(result)
    }
  }

  if (findings.length === 0 && schemaDrops.length > 0) {
    throw new BollardError({
      code: "REVIEW_OUTPUT_INVALID",
      message: `All ${schemaDrops.length} findings failed schema validation`,
      context: { drops: schemaDrops },
    })
  }

  return { findings }
}

/**
 * Split unified diff into hunks (each @@ hunk header starts a segment).
 * Falls back to a single corpus entry when no hunks match.
 */
export function buildReviewCorpus(diff: string, plan: unknown): ReviewCorpus {
  const entries: ReviewCorpus["entries"] = []
  const trimmed = diff.trim()
  if (trimmed.length > 0) {
    const hunks = trimmed.split(/(?=^@@(?:\s+[^\n]+)?\n)/m).filter((h) => h.trim().length > 0)
    const firstHunk = hunks[0]
    if (
      hunks.length > 1 ||
      (hunks.length === 1 && firstHunk !== undefined && firstHunk.includes("@@"))
    ) {
      for (const h of hunks) {
        entries.push({ text: h.trim(), source: "diff" })
      }
    } else {
      entries.push({ text: trimmed, source: "diff" })
    }
  }

  if (plan && typeof plan === "object") {
    const p = plan as Record<string, unknown>
    if (typeof p["summary"] === "string") {
      entries.push({ text: p["summary"], source: "plan" })
    }
    if (Array.isArray(p["acceptance_criteria"])) {
      entries.push({
        text: (p["acceptance_criteria"] as unknown[]).map(String).join("\n"),
        source: "plan",
      })
    }
    if (Array.isArray(p["steps"])) {
      entries.push({ text: JSON.stringify(p["steps"]), source: "plan" })
    }
  }

  return { entries }
}

function quoteMatchesCorpus(quote: string, source: "diff" | "plan", corpus: ReviewCorpus): boolean {
  const normQuote = normaliseForComparison(quote)
  if (normQuote.length === 0) return false
  for (const entry of corpus.entries) {
    if (entry.source !== source) continue
    const normEntry = normaliseForComparison(entry.text)
    if (normEntry.includes(normQuote)) return true
  }
  return false
}

export function verifyReviewGrounding(
  doc: ReviewDocument,
  corpus: ReviewCorpus,
): ReviewVerificationResult {
  const kept: ReviewFinding[] = []
  const dropped: DroppedReviewFinding[] = []
  const seenIds = new Set<string>()

  for (const finding of doc.findings) {
    if (seenIds.has(finding.id)) {
      dropped.push({ id: finding.id, reason: "duplicate_id" })
      continue
    }
    seenIds.add(finding.id)

    if (!VALID_SEVERITIES.has(finding.severity)) {
      dropped.push({
        id: finding.id,
        reason: "severity_invalid",
        detail: finding.severity,
      })
      continue
    }

    if (!VALID_CATEGORIES.has(finding.category)) {
      dropped.push({
        id: finding.id,
        reason: "category_invalid",
        detail: finding.category,
      })
      continue
    }

    if (finding.grounding.length === 0) {
      dropped.push({ id: finding.id, reason: "grounding_empty" })
      continue
    }

    let groundingFailed = false
    for (const g of finding.grounding) {
      const hasSourceEntry = corpus.entries.some((e) => e.source === g.source)
      if (!hasSourceEntry) {
        dropped.push({
          id: finding.id,
          reason: "grounding_source_mismatch",
          detail: `no corpus entry for source ${g.source}`,
        })
        groundingFailed = true
        break
      }
      if (!quoteMatchesCorpus(g.quote, g.source, corpus)) {
        const truncated = g.quote.length > 120 ? `${g.quote.slice(0, 120)}...` : g.quote
        dropped.push({
          id: finding.id,
          reason: "grounding_not_in_corpus",
          detail: truncated,
        })
        groundingFailed = true
        break
      }
    }

    if (!groundingFailed) {
      kept.push(finding)
    }
  }

  return { kept, dropped }
}
