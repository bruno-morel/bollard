import { BollardError } from "@bollard/engine/src/errors.js"
import type { ContractContext } from "./contract-extractor.js"

export type ClaimConcern = "correctness" | "security" | "performance" | "resilience"

export interface ClaimGrounding {
  quote: string
  source: string
}

export interface ClaimRecord {
  id: string
  concern: ClaimConcern
  claim: string
  grounding: ClaimGrounding[]
  test: string
}

export interface ClaimDocument {
  claims: ClaimRecord[]
}

export interface DroppedClaim {
  id: string
  reason:
    | "grounding_empty"
    | "grounding_not_in_context"
    | "concern_off"
    | "concern_invalid"
    | "duplicate_id"
    | "schema_invalid"
  detail?: string
}

export interface VerificationResult {
  kept: ClaimRecord[]
  dropped: DroppedClaim[]
}

export interface ContractCorpus {
  entries: string[]
}

export type EnabledConcerns = Partial<Record<ClaimConcern, boolean>>

const VALID_CONCERNS = new Set<string>(["correctness", "security", "performance", "resilience"])

/**
 * Normalise a string for grounding comparison: collapse whitespace,
 * trim, strip line comments (//, #) and block comments.
 */
export function normaliseForComparison(text: string): string {
  let result = text
  result = result.replace(/\/\*[\s\S]*?\*\//g, "")
  result = result.replace(/"""[\s\S]*?"""/g, "")
  result = result.replace(/\/\/[^\n]*/g, "")
  result = result.replace(/#[^\n]*/g, "")
  result = result.replace(/\s+/g, " ")
  return result.trim()
}

function stripOptionalFences(raw: string): string {
  let result = raw.trim()
  result = result.replace(/^```\w*\n/, "")
  result = result.replace(/\n```\s*$/, "")
  return result.trim()
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val)
}

function validateClaimShape(raw: unknown, index: number): ClaimRecord | DroppedClaim {
  if (!isPlainObject(raw)) {
    return {
      id: `claims[${index}]`,
      reason: "schema_invalid",
      detail: "claim is not an object",
    }
  }

  const obj = raw as Record<string, unknown>

  if (typeof obj["id"] !== "string" || obj["id"].length === 0) {
    return {
      id: `claims[${index}]`,
      reason: "schema_invalid",
      detail: "missing or non-string id",
    }
  }

  const id = obj["id"] as string

  if (typeof obj["concern"] !== "string") {
    return { id, reason: "schema_invalid", detail: "missing or non-string concern" }
  }

  if (typeof obj["claim"] !== "string" || obj["claim"].length === 0) {
    return { id, reason: "schema_invalid", detail: "missing or empty claim" }
  }

  if (!Array.isArray(obj["grounding"])) {
    return { id, reason: "schema_invalid", detail: "grounding is not an array" }
  }

  for (const g of obj["grounding"] as unknown[]) {
    if (!isPlainObject(g)) {
      return { id, reason: "schema_invalid", detail: "grounding item is not an object" }
    }
    const gi = g as Record<string, unknown>
    if (typeof gi["quote"] !== "string") {
      return { id, reason: "schema_invalid", detail: "grounding item missing quote" }
    }
    if (typeof gi["source"] !== "string") {
      return { id, reason: "schema_invalid", detail: "grounding item missing source" }
    }
  }

  if (typeof obj["test"] !== "string" || obj["test"].length === 0) {
    return { id, reason: "schema_invalid", detail: "missing or empty test" }
  }

  return {
    id,
    concern: obj["concern"] as ClaimConcern,
    claim: obj["claim"] as string,
    grounding: (obj["grounding"] as Record<string, string>[]).map((g) => ({
      quote: g["quote"] as string,
      source: g["source"] as string,
    })),
    test: obj["test"] as string,
  }
}

function isClaimRecord(val: ClaimRecord | DroppedClaim): val is ClaimRecord {
  return "test" in val
}

export function parseClaimDocument(raw: string): ClaimDocument {
  const stripped = stripOptionalFences(raw)

  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch (err: unknown) {
    throw new BollardError({
      code: "CONTRACT_TESTER_OUTPUT_INVALID",
      message: `Failed to parse claim document as JSON: ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  if (!isPlainObject(parsed)) {
    throw new BollardError({
      code: "CONTRACT_TESTER_OUTPUT_INVALID",
      message: "Claim document must be a JSON object with a claims array",
    })
  }

  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj["claims"])) {
    throw new BollardError({
      code: "CONTRACT_TESTER_OUTPUT_INVALID",
      message: "Claim document must have a top-level claims array",
    })
  }

  const claims: ClaimRecord[] = []
  const schemaDrops: DroppedClaim[] = []

  for (let i = 0; i < (obj["claims"] as unknown[]).length; i++) {
    const result = validateClaimShape((obj["claims"] as unknown[])[i], i)
    if (isClaimRecord(result)) {
      claims.push(result)
    } else {
      schemaDrops.push(result)
    }
  }

  if (claims.length === 0 && schemaDrops.length > 0) {
    throw new BollardError({
      code: "CONTRACT_TESTER_OUTPUT_INVALID",
      message: `All ${schemaDrops.length} claims failed schema validation`,
      context: { drops: schemaDrops },
    })
  }

  return { claims }
}

export function verifyClaimGrounding(
  doc: ClaimDocument,
  corpus: ContractCorpus,
  enabledConcerns: EnabledConcerns,
): VerificationResult {
  const kept: ClaimRecord[] = []
  const dropped: DroppedClaim[] = []
  const seenIds = new Set<string>()

  const normalisedEntries = corpus.entries.map(normaliseForComparison)

  for (const claim of doc.claims) {
    if (seenIds.has(claim.id)) {
      dropped.push({ id: claim.id, reason: "duplicate_id" })
      continue
    }
    seenIds.add(claim.id)

    if (!VALID_CONCERNS.has(claim.concern)) {
      dropped.push({
        id: claim.id,
        reason: "concern_invalid",
        detail: `unknown concern: ${claim.concern}`,
      })
      continue
    }

    if (enabledConcerns[claim.concern] === false) {
      dropped.push({ id: claim.id, reason: "concern_off" })
      continue
    }

    if (claim.grounding.length === 0) {
      dropped.push({ id: claim.id, reason: "grounding_empty" })
      continue
    }

    let groundingFailed = false
    for (const g of claim.grounding) {
      const normQuote = normaliseForComparison(g.quote)
      const found = normalisedEntries.some((entry) => entry.includes(normQuote))
      if (!found) {
        const truncated = g.quote.length > 120 ? `${g.quote.slice(0, 120)}...` : g.quote
        dropped.push({
          id: claim.id,
          reason: "grounding_not_in_context",
          detail: truncated,
        })
        groundingFailed = true
        break
      }
    }

    if (!groundingFailed) {
      kept.push(claim)
    }
  }

  if (kept.length === 0) {
    throw new BollardError({
      code: "CONTRACT_TESTER_NO_GROUNDED_CLAIMS",
      message: `All ${doc.claims.length} claims were dropped during grounding verification`,
      context: { dropped },
    })
  }

  return { kept, dropped }
}

export function contractContextToCorpus(
  ctx: ContractContext,
  planSummary?: string,
): ContractCorpus {
  const entries: string[] = []

  for (const mod of ctx.modules) {
    for (const sig of mod.publicExports) {
      if (sig.signatures) entries.push(sig.signatures)
      if (sig.types) entries.push(sig.types)
      if (sig.imports) entries.push(sig.imports)
    }
  }

  for (const edge of ctx.edges) {
    const parts: string[] = [
      `edge: ${edge.from} -> ${edge.to}`,
      `importedSymbols: ${edge.importedSymbols.join(", ")}`,
    ]
    if (edge.providerErrors.length > 0) {
      parts.push(`providerErrors: ${edge.providerErrors.join(", ")}`)
    }
    if (edge.consumerCatches.length > 0) {
      parts.push(`consumerCatches: ${edge.consumerCatches.join(", ")}`)
    }
    entries.push(parts.join("\n"))
  }

  if (planSummary) {
    entries.push(planSummary)
  }

  return { entries }
}
