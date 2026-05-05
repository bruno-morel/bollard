import { describe, expect, it } from "vitest"
import type { BehavioralContext } from "../src/behavioral-extractor.js"
import { behavioralContextToCorpus } from "../src/behavioral-grounding.js"
import { parseClaimDocument, verifyClaimGrounding } from "../src/contract-grounding.js"

describe("behavioralContextToCorpus", () => {
  it("includes endpoint, dependency, config, and failure lines", () => {
    const ctx: BehavioralContext = {
      endpoints: [
        {
          method: "GET",
          path: "/api/health",
          handler: "h",
          sourceFile: "src/a.ts",
        },
      ],
      config: [{ key: "PORT", source: "code", sourceFile: "src/a.ts" }],
      dependencies: [
        {
          name: "redis",
          type: "cache",
          clientLibrary: "ioredis",
          sourceFile: "src/cache.ts",
        },
      ],
      failureModes: [{ dependency: "redis", mode: "timeout", severity: "medium" }],
    }
    const corpus = behavioralContextToCorpus(ctx)
    const blob = corpus.entries.join("\n")
    expect(blob).toContain("endpoint:GET:/api/health")
    expect(blob).toContain("dependency:redis")
    expect(blob).toContain("config:PORT")
    expect(blob).toContain("failure:redis mode:timeout")
  })

  it("produces empty corpus for empty context", () => {
    const corpus = behavioralContextToCorpus({
      endpoints: [],
      config: [],
      dependencies: [],
      failureModes: [],
    })
    expect(corpus.entries).toHaveLength(0)
  })
})

describe("behavioral grounding pipeline", () => {
  it("keeps claims whose quotes appear in corpus", () => {
    const ctx: BehavioralContext = {
      endpoints: [{ method: "GET", path: "/x", handler: "h", sourceFile: "f.ts" }],
      config: [],
      dependencies: [],
      failureModes: [],
    }
    const corpus = behavioralContextToCorpus(ctx)
    const raw = JSON.stringify({
      claims: [
        {
          id: "b1",
          concern: "correctness",
          claim: "x",
          grounding: [{ quote: "GET", source: "endpoint:GET:/x" }],
          test: "it('t', () => expect(1).toBe(1))",
        },
      ],
    })
    const doc = parseClaimDocument(raw, { invalidCode: "BEHAVIORAL_TESTER_OUTPUT_INVALID" })
    const result = verifyClaimGrounding(doc, corpus, {
      correctness: true,
      security: true,
      performance: true,
      resilience: true,
    })
    expect(result.kept).toHaveLength(1)
  })

  it("drops claims with quotes not in corpus", () => {
    const ctx: BehavioralContext = {
      endpoints: [{ method: "GET", path: "/x", handler: "h", sourceFile: "f.ts" }],
      config: [],
      dependencies: [],
      failureModes: [],
    }
    const corpus = behavioralContextToCorpus(ctx)
    const raw = JSON.stringify({
      claims: [
        {
          id: "b1",
          concern: "correctness",
          claim: "bad",
          grounding: [{ quote: "completely-fabricated-xyz", source: "x" }],
          test: "it('t', () => expect(1).toBe(1))",
        },
      ],
    })
    const doc = parseClaimDocument(raw, { invalidCode: "BEHAVIORAL_TESTER_OUTPUT_INVALID" })
    const result = verifyClaimGrounding(doc, corpus, {
      correctness: true,
      security: true,
      performance: true,
      resilience: true,
    })
    expect(result.kept).toEqual([])
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]?.reason).toBe("grounding_not_in_context")
  })

  it("returns empty kept array when all behavioral claims are dropped (soft-fail per ADR-0001)", () => {
    const ctx: BehavioralContext = {
      endpoints: [{ method: "GET", path: "/x", handler: "h", sourceFile: "f.ts" }],
      config: [],
      dependencies: [],
      failureModes: [],
    }
    const corpus = behavioralContextToCorpus(ctx)
    const raw = JSON.stringify({
      claims: [
        {
          id: "b1",
          concern: "correctness",
          claim: "bad",
          grounding: [{ quote: "nope", source: "x" }],
          test: "it('t', () => expect(1).toBe(1))",
        },
      ],
    })
    const doc = parseClaimDocument(raw, { invalidCode: "BEHAVIORAL_TESTER_OUTPUT_INVALID" })
    // Pass-through: noGroundedClaimsCode option is accepted but unused (kept for source-compat).
    const result = verifyClaimGrounding(
      doc,
      corpus,
      {
        correctness: true,
        security: true,
        performance: true,
        resilience: true,
      },
      { noGroundedClaimsCode: "BEHAVIORAL_NO_GROUNDED_CLAIMS" },
    )
    expect(result.kept).toEqual([])
    expect(result.dropped).toHaveLength(1)
  })
})
