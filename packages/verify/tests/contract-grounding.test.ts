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
    const result = verifyClaimGrounding(doc, CORPUS_WITH_SNAPSHOT, ALL_ENABLED)
    expect(result.kept).toEqual([])
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]?.id).toBe("float-exact")
    expect(result.dropped[0]?.reason).toBe("grounding_not_in_context")
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
    const result = verifyClaimGrounding(doc, CORPUS_WITH_SNAPSHOT, ALL_ENABLED)
    expect(result.kept).toEqual([])
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]?.reason).toBe("grounding_empty")
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

  it("returns empty kept array when zero survivors (soft-fail per ADR-0001)", () => {
    const doc: ClaimDocument = {
      claims: [
        makeClaim({
          id: "ungrounded",
          grounding: [{ quote: "this does not exist anywhere", source: "invented" }],
        }),
      ],
    }
    const result = verifyClaimGrounding(doc, CORPUS_WITH_SNAPSHOT, ALL_ENABLED)
    expect(result.kept).toEqual([])
    expect(result.dropped.length).toBe(doc.claims.length)
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

describe("contractContextToCorpus — task and acceptance criteria", () => {
  const emptyCtx: ContractContext = { modules: [], edges: [], affectedEdges: [] }

  it("includes taskStr as a corpus entry when provided", () => {
    const corpus = contractContextToCorpus(emptyCtx, undefined, "Add merge(other) method")
    expect(corpus.entries).toContain("Add merge(other) method")
  })

  it("includes each acceptance criterion as a separate corpus entry", () => {
    const corpus = contractContextToCorpus(emptyCtx, undefined, undefined, [
      "throws BollardError with CONTRACT_VIOLATION when other is null",
      "returns a new tracker with combined totals",
    ])
    expect(corpus.entries).toContain(
      "throws BollardError with CONTRACT_VIOLATION when other is null",
    )
    expect(corpus.entries).toContain("returns a new tracker with combined totals")
  })

  it("a claim quoting acceptance criterion text passes grounding", () => {
    const corpus = contractContextToCorpus(
      emptyCtx,
      undefined,
      "Add merge(other: CostTracker): CostTracker",
      ["throws BollardError with CONTRACT_VIOLATION if other is not a CostTracker"],
    )
    const doc: ClaimDocument = {
      claims: [
        {
          id: "c1",
          concern: "correctness",
          claim: "merge throws when other is invalid",
          grounding: [
            {
              quote: "throws BollardError with CONTRACT_VIOLATION if other is not a CostTracker",
              source: "acceptance_criteria:1",
            },
          ],
          test: "it('placeholder', () => {})",
        },
      ],
    }
    const result = verifyClaimGrounding(doc, corpus, { correctness: true })
    expect(result.kept).toHaveLength(1)
    expect(result.dropped).toHaveLength(0)
  })

  it("a claim quoting task description text passes grounding", () => {
    const corpus = contractContextToCorpus(
      emptyCtx,
      undefined,
      "Add merge(other: CostTracker): CostTracker method that combines totals",
      [],
    )
    const doc: ClaimDocument = {
      claims: [
        {
          id: "c2",
          concern: "correctness",
          claim: "merge combines totals",
          grounding: [
            {
              quote: "combines totals",
              source: "task_description",
            },
          ],
          test: "it('placeholder', () => {})",
        },
      ],
    }
    const result = verifyClaimGrounding(doc, corpus, { correctness: true })
    expect(result.kept).toHaveLength(1)
    expect(result.dropped).toHaveLength(0)
  })

  it("omitting taskStr and criteria preserves existing corpus behavior", () => {
    const corpus = contractContextToCorpus(emptyCtx, "plan summary text")
    expect(corpus.entries).toEqual(["plan summary text"])
  })
})

describe("contractContextToCorpus with sourceContents", () => {
  const emptyCtx: ContractContext = { modules: [], edges: [], affectedEdges: [] }

  it("includes source content in corpus entries", () => {
    const source = "function reset() { this._total = 0 }"
    const corpus = contractContextToCorpus(emptyCtx, undefined, undefined, undefined, [source])
    expect(corpus.entries).toContain(source)
  })

  it("grounding succeeds when quote appears only in source content", () => {
    const source = "reset(): void { this._total = 0; this._limitUsd = this._limitUsd }"
    const corpus = contractContextToCorpus(emptyCtx, undefined, undefined, undefined, [source])
    const doc: ClaimDocument = {
      claims: [
        {
          id: "c1",
          concern: "correctness",
          claim: "reset sets total back to zero",
          grounding: [{ quote: "this._total = 0", source: "source:cost-tracker.ts" }],
          test: "it('placeholder', () => {})",
        },
      ],
    }
    const result = verifyClaimGrounding(doc, corpus, { correctness: true })
    expect(result.kept).toHaveLength(1)
    expect(result.dropped).toHaveLength(0)
  })

  it("skips empty and whitespace-only source content", () => {
    const baseline = contractContextToCorpus(emptyCtx, "plan summary")
    const withEmpty = contractContextToCorpus(emptyCtx, "plan summary", undefined, undefined, [
      "",
      "   ",
    ])
    expect(withEmpty.entries).toEqual(baseline.entries)
  })

  it("preserves backward compat when sourceContents is omitted", () => {
    const corpus = contractContextToCorpus(emptyCtx, "plan summary text")
    expect(corpus.entries).toEqual(["plan summary text"])
  })
})
