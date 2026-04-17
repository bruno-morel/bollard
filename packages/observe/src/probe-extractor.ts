import type { ProbeDefinition } from "@bollard/engine/src/blueprint.js"
import type { BehavioralContext } from "@bollard/verify/src/behavioral-extractor.js"
import type { ClaimRecord } from "@bollard/verify/src/contract-grounding.js"

import type { RiskTier } from "./providers/types.js"

const TIER_INTERVAL: Record<RiskTier, number> = {
  low: 300,
  medium: 120,
  high: 60,
  critical: 30,
}

function concernToRiskTier(concern: ClaimRecord["concern"]): RiskTier {
  switch (concern) {
    case "security":
    case "resilience":
      return "high"
    case "performance":
      return "medium"
    case "correctness":
      return "low"
  }
}

function hasEndpointGrounding(claim: ClaimRecord): boolean {
  return claim.grounding.some((g) => g.source.includes("endpoint:"))
}

function hasFailureGrounding(claim: ClaimRecord): boolean {
  return claim.grounding.some((g) => g.source.includes("failure:"))
}

/**
 * Behavioral tests that only import modules are not probe-eligible.
 */
function looksLikeHttpStyleTest(test: string): boolean {
  const trimmed = test.trim()
  if (trimmed.length === 0) return false
  const hasImportOnly =
    /^import\s/m.test(trimmed) && !/\b(fetch|expect\s*\(|response\b|\.status\b)/.test(trimmed)
  if (hasImportOnly) return false
  return /\bfetch\s*\(|\bglobalThis\.fetch\b|expect\s*\([^)]*\.status|expect\s*\([^)]*status\b|\.get\s*\(\s*["'`]http/.test(
    trimmed,
  )
}

export interface ParsedEndpoint {
  method: "GET" | "POST"
  path: string
}

/**
 * Corpus format: `endpoint:METHOD:path handler:...`
 */
export function parseEndpointFromSources(sources: string[]): ParsedEndpoint | undefined {
  for (const s of sources) {
    const m = /endpoint:(GET|POST):([^\s]+)/i.exec(s)
    if (m) {
      const method = m[1]?.toUpperCase() === "POST" ? "POST" : "GET"
      return { method, path: m[2] ?? "/" }
    }
  }
  return undefined
}

/**
 * Heuristic extraction of HTTP assertions from generated test bodies (Vitest/Jest style).
 */
export function extractAssertionsFromTest(
  test: string,
): import("@bollard/engine/src/blueprint.js").ProbeAssertion[] {
  const assertions: import("@bollard/engine/src/blueprint.js").ProbeAssertion[] = []

  const statusMatches = test.matchAll(/\.(?:toBe|toEqual|toStrictEqual)\s*\(\s*(\d{3})\s*\)/g)
  for (const m of statusMatches) {
    const code = Number(m[1])
    if (code >= 100 && code < 600) {
      assertions.push({ type: "status", expected: code })
    }
  }

  const latencyMatch = /(?:latency|duration|within)\s*[<(]\s*(\d+)\s*(?:ms)?/i.exec(test)
  if (latencyMatch) {
    const maxMs = Number(latencyMatch[1])
    if (!Number.isNaN(maxMs)) {
      assertions.push({ type: "latency", expected: true, maxMs })
    }
  }

  const jsonField = /expect\s*\([^)]*\)\.(?:toMatchObject|toEqual)\s*\(\s*\{\s*([^}]+)\}/s.exec(
    test,
  )
  if (jsonField?.[1]) {
    const inner = jsonField[1]
    const kv = /(\w+)\s*:\s*([^,}\n]+)/g.exec(inner)
    if (kv) {
      const key = kv[1]
      if (key !== undefined && key.length > 0) {
        let val: unknown = kv[2]?.trim()
        if (val === "true") val = true
        else if (val === "false") val = false
        else if (/^\d+$/.test(String(val))) val = Number(val)
        else if (typeof val === "string" && val.startsWith('"') && val.endsWith('"')) {
          val = val.slice(1, -1)
        }
        assertions.push({ type: "json_field", path: key, expected: val })
      }
    }
  }

  const containsMatch =
    /(?:body|text)\s*.*?(?:toContain|includes)\s*\(\s*["'`]([^"'`]+)["'`]/i.exec(test)
  if (containsMatch?.[1]) {
    assertions.push({ type: "body_contains", expected: containsMatch[1] })
  }

  const regexMatch = /toMatch\s*\(\s*\/([^/]+)\//.exec(test)
  if (regexMatch?.[1]) {
    try {
      assertions.push({ type: "body_matches", expected: new RegExp(regexMatch[1]).source })
    } catch {
      /* ignore bad regex */
    }
  }

  const headerMatch =
    /header[s]?\s*\[\s*["'`]([^"'`]+)["'`]\s*\].*?to(?:Be|Equal)\s*\(\s*["'`]([^"'`]+)["'`]/i.exec(
      test,
    )
  if (headerMatch?.[1] !== undefined && headerMatch[2] !== undefined) {
    assertions.push({
      type: "header",
      name: headerMatch[1],
      expected: headerMatch[2],
    })
  }

  if (!assertions.some((a) => a.type === "status")) {
    assertions.unshift({ type: "status", expected: 200 })
  }

  return assertions
}

/**
 * Deterministic probe extraction from grounded behavioral claims (ADR-0001 style filter).
 */
export function extractProbes(
  claims: ClaimRecord[],
  _context: BehavioralContext,
  runId: string,
): ProbeDefinition[] {
  const out: ProbeDefinition[] = []
  for (const claim of claims) {
    if (!hasEndpointGrounding(claim)) continue
    if (hasFailureGrounding(claim)) continue
    if (!looksLikeHttpStyleTest(claim.test)) continue

    const sources = claim.grounding.map((g) => g.source)
    const parsed = parseEndpointFromSources(sources)
    if (!parsed) continue

    const riskTier = concernToRiskTier(claim.concern)
    const intervalSeconds = TIER_INTERVAL[riskTier]
    const assertions = extractAssertionsFromTest(claim.test)
    const id = `probe-${claim.id.replace(/^claim-?/i, "")}`

    out.push({
      id,
      name: claim.claim.slice(0, 120) || id,
      endpoint: parsed.path.startsWith("/") ? parsed.path : `/${parsed.path}`,
      method: parsed.method,
      assertions,
      intervalSeconds,
      riskTier,
      sourceRunId: runId,
      sourceClaimId: claim.id,
    })
  }
  return out
}
