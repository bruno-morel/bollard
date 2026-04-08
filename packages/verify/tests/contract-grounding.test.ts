import { BollardError } from "@bollard/engine/src/errors.js"
import { describe, expect, it } from "vitest"
import type { ContractContext } from "../src/contract-extractor.js"
import type {
  ClaimDocument,
  ClaimRecord,
  ContractCorpus,
  EnabledConcerns,
} from "../src/contract-grounding.js"
import {
  contractContextToCorpus,
  normaliseForComparison,
  parseClaimDocument,
  verifyClaimGrounding,
} from "../src/contract-grounding.js"

const ALL_ENABLED: EnabledConcerns = {
  correctness: true,
  security: true,
  performance: true,
  resilience: true,
}

function makeClaim(overrides: Partial<ClaimRecord> & { id: string }): ClaimRecord {
  return {
    concern: "correctness",
    claim: "test claim",
    grounding: [{ quote: "snapshot(): Readonly<{ totalCostUsd: number }>", source: "sig" }],
    test: "it('works', () => { expect(true).toBe(true) })",
    ...overrides,
  }
}

const CORPUS_WITH_SNAPSHOT: ContractCorpus = {
  entries: [
    "snapshot(): Readonly<{ totalCostUsd: number }>",
    "add(costUsd: number, ctx?: PipelineContext): void",
    "total(): number",
    "reset(): number",
    "edge: @bollard/engine -> @bollard/detect\nimportedSymbols: ToolchainProfile",
  ],
}

describe("parseClaimDocument", () => {
  it("parses a well-formed JSON document", () => {
    const raw = JSON.stringify({
      claims: [
        {
          id: "c1",
          concern: "correctness",
          claim: "snapshot returns current total",
          grounding: [
            { quote: "snapshot(): Readonly<{ totalCostUsd: number }>", source: "sig:CostTracker" },
          ],
          test: "it('returns total', () => { expect(1).toBe(1) })",
        },
      ],
    })
    const doc = parseClaimDocument(raw)
    expect(doc.claims).toHaveLength(1)
    expect(doc.claims[0]?.id).toBe("c1")
  })

  it("throws CONTRACT_TESTER_OUTPUT_INVALID on malformed JSON", () => {
    expect(() => parseClaimDocument("not json at all")).toThrow(BollardError)
    try {
      parseClaimDocument("not json at all")
    } catch (err: unknown) {
      expect(BollardError.is(err)).toBe(true)
      expect((err as BollardError).code).toBe("CONTRACT_TESTER_OUTPUT_INVALID")
    }
  })

  it("parses JSON wrapped in markdown fences", () => {
    const raw = `\`\`\`json\n${JSON.stringify({ claims: [{ id: "c1", concern: "correctness", claim: "x", grounding: [{ quote: "q", source: "s" }], test: "t" }] })}\n\`\`\``
    const doc = parseClaimDocument(raw)
    expect(doc.claims).toHaveLength(1)
    expect(doc.claims[0]?.id).toBe("c1")
  })

  it("throws on missing claims array", () => {
    expect(() => parseClaimDocument(JSON.stringify({ notclaims: [] }))).toThrow(BollardError)
  })

  it("drops claims with schema violations without throwing", () => {
    const raw = JSON.stringify({
      claims: [
        {
          id: "good",
          concern: "correctness",
          claim: "x",
          grounding: [{ quote: "q", source: "s" }],
          test: "t",
        },
        { id: "bad-no-test", concern: "correctness", claim: "x", grounding: [] },
      ],
    })
    const doc = parseClaimDocument(raw)
    expect(doc.claims).toHaveLength(1)
    expect(doc.claims[0]?.id).toBe("good")
  })
})

describe("verifyClaimGrounding", () => {
  it("keeps a well-formed claim with matching grounding", () => {
    const doc: ClaimDocument = {
      claims: [makeClaim({ id: "c1" })],
    }
    const result = verifyClaimGrounding(doc, CORPUS_WITH_SNAPSHOT, ALL_ENABLED)
    expect(result.kept).toHaveLength(1)
    expect(result.kept[0]?.id).toBe("c1")
    expect(result.dropped).toHaveLength(0)
  })

  it("drops float-exactness claim — grounding_not_in_context (repro from retro doc)", () => {
    const doc: ClaimDocument = {
      claims: [
        {
          id: "float-exact",
          concern: "correctness",
          claim: "adding 0.1 and 0.2 yields exactly 0.3",
          grounding: [
            {
              quote: "total(): number guarantees exact arithmetic",
              source: "signature:CostTracker.total",
            },
          ],
          test: "it('precision across reset cycles', () => { expect(0.1 + 0.2).toBe(0.3) })",
        },
      ],
    }
    expect(() => verifyClaimGrounding(doc, CORPUS_WITH_SNAPSHOT, ALL_ENABLED)).toThrow(BollardError)
    try {
      verifyClaimGrounding(doc, CORPUS_WITH_SNAPSHOT, ALL_ENABLED)
    } catch (err: unknown) {
      expect((err as BollardError).code).toBe("CONTRACT_TESTER_NO_GROUNDED_CLAIMS")
    }
  })

  // v1 limitation: entailment not checked; the runtime test remains the final gate.
  // The readonly claim's quote DOES exist in the corpus, so v1 keeps it.
  // Whether the test actually passes is up to the runtime — if the implementation
  // uses Object.freeze, the test will fail at node 13 and we learn from it.
  // Layer 2 (NormalizedContract with annotations vs guarantees) addresses this.
  it("keeps readonly-mutation claim when grounding quote exists in corpus (v1 limitation)", () => {
    const doc: ClaimDocument = {
      claims: [
        {
          id: "readonly-mut",
          concern: "correctness",
          claim: "mutation of snapshot.totalCostUsd does not throw at runtime",
          grounding: [
            {
              quote: "snapshot(): Readonly<{ totalCostUsd: number }>",
              source: "signature:CostTracker.snapshot",
            },
          ],
          test: "it('allows mutation', () => { const s = tracker.snapshot(); expect(() => { (s as any).totalCostUsd = 1 }).not.toThrow() })",
        },
      ],
    }
    const result = verifyClaimGrounding(doc, CORPUS_WITH_SNAPSHOT, ALL_ENABLED)
    expect(result.kept).toHaveLength(1)
    expect(result.kept[0]?.id).toBe("readonly-mut")
  })

  it("drops claims with empty grounding — grounding_empty", () => {
    const doc: ClaimDocument = {
      claims: [makeClaim({ id: "empty-g", grounding: [] })],
    }
    expect(() => verifyClaimGrounding(doc, CORPUS_WITH_SNAPSHOT, ALL_ENABLED)).toThrow(BollardError)
    try {
      verifyClaimGrounding(doc, CORPUS_WITH_SNAPSHOT, ALL_ENABLED)
    } catch (err: unknown) {
      const ctx = (err as BollardError).context as { dropped: Array<{ reason: string }> }
      expect(ctx.dropped[0]?.reason).toBe("grounding_empty")
    }
  })

  it("drops duplicate ids — duplicate_id", () => {
    const doc: ClaimDocument = {
      claims: [makeClaim({ id: "dup" }), makeClaim({ id: "dup" })],
    }
    const result = verifyClaimGrounding(doc, CORPUS_WITH_SNAPSHOT, ALL_ENABLED)
    expect(result.kept).toHaveLength(1)
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]?.reason).toBe("duplicate_id")
  })

  it("drops claims with concern weighted off — concern_off", () => {
    const concerns: EnabledConcerns = { ...ALL_ENABLED, security: false }
    const doc: ClaimDocument = {
      claims: [
        makeClaim({ id: "sec-off", concern: "security" }),
        makeClaim({ id: "cor-on", concern: "correctness" }),
      ],
    }
    const result = verifyClaimGrounding(doc, CORPUS_WITH_SNAPSHOT, concerns)
    expect(result.kept).toHaveLength(1)
    expect(result.kept[0]?.id).toBe("cor-on")
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]?.reason).toBe("concern_off")
  })

  it("drops claims with unknown concern — concern_invalid", () => {
    const doc: ClaimDocument = {
      claims: [
        makeClaim({ id: "bad-concern", concern: "speed" as "correctness" }),
        makeClaim({ id: "good" }),
      ],
    }
    const result = verifyClaimGrounding(doc, CORPUS_WITH_SNAPSHOT, ALL_ENABLED)
    expect(result.kept).toHaveLength(1)
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]?.reason).toBe("concern_invalid")
  })

  it("throws CONTRACT_TESTER_NO_GROUNDED_CLAIMS when zero survivors", () => {
    const doc: ClaimDocument = {
      claims: [
        makeClaim({
          id: "ungrounded",
          grounding: [{ quote: "this does not exist anywhere", source: "invented" }],
        }),
      ],
    }
    expect(() => verifyClaimGrounding(doc, CORPUS_WITH_SNAPSHOT, ALL_ENABLED)).toThrow(BollardError)
    try {
      verifyClaimGrounding(doc, CORPUS_WITH_SNAPSHOT, ALL_ENABLED)
    } catch (err: unknown) {
      expect((err as BollardError).code).toBe("CONTRACT_TESTER_NO_GROUNDED_CLAIMS")
    }
  })
})

describe("normaliseForComparison", () => {
  it("collapses whitespace and strips line comments", () => {
    const corpus: ContractCorpus = {
      entries: ["foo(x: number) // returns a float"],
    }
    const doc: ClaimDocument = {
      claims: [
        makeClaim({
          id: "norm",
          grounding: [{ quote: "foo(x: number)", source: "sig" }],
        }),
      ],
    }
    const result = verifyClaimGrounding(doc, corpus, ALL_ENABLED)
    expect(result.kept).toHaveLength(1)
  })

  it("strips block comments from corpus entries", () => {
    const normalised = normaliseForComparison("foo(x: number) /* helper */ bar()")
    expect(normalised).toBe("foo(x: number) bar()")
  })

  it("strips Python-style hash comments", () => {
    const normalised = normaliseForComparison("def foo(x: int) # type ignore")
    expect(normalised).toBe("def foo(x: int)")
  })
})

describe("contractContextToCorpus", () => {
  it("flattens modules and edges into searchable entries", () => {
    const ctx: ContractContext = {
      modules: [
        {
          id: "@bollard/engine",
          language: "typescript",
          rootPath: "/app/packages/engine",
          publicExports: [
            {
              filePath: "packages/engine/src/cost-tracker.ts",
              signatures: "add(costUsd: number): void\ntotal(): number",
              types: "export class CostTracker",
            },
          ],
          errorTypes: ["BollardError"],
        },
      ],
      edges: [
        {
          from: "@bollard/cli",
          to: "@bollard/engine",
          importedSymbols: ["CostTracker", "BollardError"],
          providerErrors: ["BollardError"],
          consumerCatches: [],
        },
      ],
      affectedEdges: [],
    }
    const corpus = contractContextToCorpus(ctx, "Add subtract method")
    expect(corpus.entries.length).toBeGreaterThanOrEqual(3)
    expect(corpus.entries.some((e) => e.includes("add(costUsd: number): void"))).toBe(true)
    expect(corpus.entries.some((e) => e.includes("CostTracker"))).toBe(true)
    expect(corpus.entries.some((e) => e.includes("Add subtract method"))).toBe(true)
  })

  it("includes plan summary when provided", () => {
    const ctx: ContractContext = { modules: [], edges: [], affectedEdges: [] }
    const corpus = contractContextToCorpus(ctx, "the plan summary")
    expect(corpus.entries).toContain("the plan summary")
  })

  it("returns empty entries for empty context", () => {
    const ctx: ContractContext = { modules: [], edges: [], affectedEdges: [] }
    const corpus = contractContextToCorpus(ctx)
    expect(corpus.entries).toHaveLength(0)
  })
})
