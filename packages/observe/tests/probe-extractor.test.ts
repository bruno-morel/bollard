import type { BehavioralContext } from "@bollard/verify/src/behavioral-extractor.js"
import type { ClaimRecord } from "@bollard/verify/src/contract-grounding.js"
import { describe, expect, it } from "vitest"

import {
  extractAssertionsFromTest,
  extractProbes,
  parseEndpointFromSources,
} from "../src/probe-extractor.js"

const emptyCtx: BehavioralContext = {
  endpoints: [],
  config: [],
  dependencies: [],
  failureModes: [],
}

function claim(
  partial: Partial<ClaimRecord> & Pick<ClaimRecord, "id" | "concern" | "claim" | "test">,
): ClaimRecord {
  return {
    grounding: [],
    ...partial,
  }
}

describe("parseEndpointFromSources", () => {
  it("parses METHOD:path from behavioral corpus line", () => {
    const p = parseEndpointFromSources(["endpoint:GET:/api/health handler:h file:src/a.ts"])
    expect(p).toEqual({ method: "GET", path: "/api/health" })
  })

  it("returns undefined when no endpoint line", () => {
    expect(parseEndpointFromSources(["config:FOO source:env"])).toBeUndefined()
  })
})

describe("extractProbes", () => {
  it("keeps claims with endpoint grounding and HTTP-style test", () => {
    const claims: ClaimRecord[] = [
      claim({
        id: "c1",
        concern: "correctness",
        claim: "Health returns 200",
        grounding: [
          { quote: "GET /api/health", source: "endpoint:GET:/api/health handler:h file:a.ts" },
        ],
        test: `const r = await fetch("/api/health")\nexpect(r.status).toBe(200)`,
      }),
    ]
    const probes = extractProbes(claims, emptyCtx, "run-1")
    expect(probes).toHaveLength(1)
    expect(probes[0]?.id).toBe("probe-c1")
    expect(probes[0]?.endpoint).toBe("/api/health")
    expect(probes[0]?.riskTier).toBe("low")
    expect(probes[0]?.intervalSeconds).toBe(300)
  })

  it("drops claims with failure: grounding", () => {
    const claims: ClaimRecord[] = [
      claim({
        id: "c2",
        concern: "resilience",
        claim: "x",
        grounding: [
          { quote: "a", source: "endpoint:GET:/x handler:h file:a.ts" },
          { quote: "b", source: "failure:db mode:timeout severity:high" },
        ],
        test: "await fetch('/x')",
      }),
    ]
    expect(extractProbes(claims, emptyCtx, "r")).toHaveLength(0)
  })

  it("drops claims without endpoint grounding", () => {
    const claims: ClaimRecord[] = [
      claim({
        id: "c3",
        concern: "correctness",
        claim: "config",
        grounding: [{ quote: "x", source: "config:KEY source:env file:a.ts" }],
        test: "fetch('/x')",
      }),
    ]
    expect(extractProbes(claims, emptyCtx, "r")).toHaveLength(0)
  })

  it("drops import-only tests", () => {
    const claims: ClaimRecord[] = [
      claim({
        id: "c4",
        concern: "correctness",
        claim: "x",
        grounding: [{ quote: "a", source: "endpoint:POST:/p handler:h file:a.ts" }],
        test: 'import { x } from "./mod"\n',
      }),
    ]
    expect(extractProbes(claims, emptyCtx, "r")).toHaveLength(0)
  })

  it("maps concerns to risk tiers", () => {
    const mk = (concern: ClaimRecord["concern"]): ClaimRecord =>
      claim({
        id: concern,
        concern,
        claim: "x",
        grounding: [{ quote: "a", source: "endpoint:GET:/z handler:h file:a.ts" }],
        test: "fetch('/z')",
      })
    expect(extractProbes([mk("security")], emptyCtx, "r")[0]?.riskTier).toBe("high")
    expect(extractProbes([mk("performance")], emptyCtx, "r")[0]?.riskTier).toBe("medium")
    expect(extractProbes([mk("correctness")], emptyCtx, "r")[0]?.riskTier).toBe("low")
  })

  it("prefixes probe id from claim id", () => {
    const claims: ClaimRecord[] = [
      claim({
        id: "claim-abc",
        concern: "correctness",
        claim: "x",
        grounding: [{ quote: "a", source: "endpoint:GET:/q handler:h file:a.ts" }],
        test: "fetch('/q')",
      }),
    ]
    expect(extractProbes(claims, emptyCtx, "r")[0]?.id).toBe("probe-abc")
  })
})

describe("extractAssertionsFromTest", () => {
  it("adds default status 200 when missing", () => {
    const a = extractAssertionsFromTest("fetch('/a')")
    expect(a[0]).toEqual({ type: "status", expected: 200 })
  })

  it("parses status from toBe", () => {
    const a = extractAssertionsFromTest("expect(res.status).toBe(404)")
    expect(a.some((x) => x.type === "status" && x.expected === 404)).toBe(true)
  })
})
