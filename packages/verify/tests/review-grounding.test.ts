import { BollardError } from "@bollard/engine/src/errors.js"
import { describe, expect, it } from "vitest"
import {
  buildReviewCorpus,
  parseReviewDocument,
  verifyReviewGrounding,
} from "../src/review-grounding.js"

describe("parseReviewDocument", () => {
  it("parses a valid document", () => {
    const raw = JSON.stringify({
      findings: [
        {
          id: "r1",
          severity: "warning",
          category: "plan-divergence",
          finding: "Issue",
          grounding: [{ quote: "hello", source: "plan" }],
        },
      ],
    })
    const doc = parseReviewDocument(raw)
    expect(doc.findings).toHaveLength(1)
    expect(doc.findings[0]?.id).toBe("r1")
  })

  it("strips markdown fences", () => {
    const inner = JSON.stringify({
      findings: [
        {
          id: "r1",
          severity: "info",
          category: "missing-coverage",
          finding: "x",
          grounding: [{ quote: "a", source: "diff" }],
        },
      ],
    })
    const raw = `\`\`\`json\n${inner}\n\`\`\``
    const doc = parseReviewDocument(raw)
    expect(doc.findings).toHaveLength(1)
  })

  it("throws REVIEW_OUTPUT_INVALID on bad JSON", () => {
    expect(() => parseReviewDocument("not json")).toThrow(BollardError)
    try {
      parseReviewDocument("not json")
    } catch (e: unknown) {
      expect(BollardError.is(e) && e.code === "REVIEW_OUTPUT_INVALID").toBe(true)
    }
  })
})

describe("buildReviewCorpus", () => {
  it("splits diff hunks and plan fields", () => {
    const diff = `@@ -1 +1 @@
-old
+new
`
    const plan = {
      summary: "Do the thing",
      acceptance_criteria: ["c1"],
      steps: [{ description: "step" }],
    }
    const corpus = buildReviewCorpus(diff, plan)
    const sources = corpus.entries.map((e) => e.source)
    expect(sources.filter((s) => s === "diff").length).toBeGreaterThanOrEqual(1)
    expect(sources).toContain("plan")
    const joined = corpus.entries.map((e) => e.text).join("\n")
    expect(joined).toContain("Do the thing")
    expect(joined).toContain("+new")
  })
})

describe("verifyReviewGrounding", () => {
  it("keeps grounded findings", () => {
    const doc = parseReviewDocument(
      JSON.stringify({
        findings: [
          {
            id: "r1",
            severity: "error",
            category: "api-compatibility",
            finding: "x",
            grounding: [
              { quote: "alpha", source: "plan" },
              { quote: "+beta", source: "diff" },
            ],
          },
        ],
      }),
    )
    const corpus = buildReviewCorpus("+beta\n", { summary: "alpha" })
    const result = verifyReviewGrounding(doc, corpus)
    expect(result.kept).toHaveLength(1)
    expect(result.dropped).toHaveLength(0)
  })

  it("drops ungrounded findings", () => {
    const doc = parseReviewDocument(
      JSON.stringify({
        findings: [
          {
            id: "r1",
            severity: "warning",
            category: "naming-consistency",
            finding: "x",
            grounding: [{ quote: "not in corpus", source: "plan" }],
          },
        ],
      }),
    )
    const corpus = buildReviewCorpus("diff only", { summary: "plan text" })
    const result = verifyReviewGrounding(doc, corpus)
    expect(result.kept).toHaveLength(0)
    expect(result.dropped.some((d) => d.reason === "grounding_not_in_corpus")).toBe(true)
  })

  it("returns empty kept on no findings", () => {
    const doc = parseReviewDocument(JSON.stringify({ findings: [] }))
    const corpus = buildReviewCorpus("", {})
    const result = verifyReviewGrounding(doc, corpus)
    expect(result.kept).toHaveLength(0)
    expect(result.dropped).toHaveLength(0)
  })

  it("drops duplicate IDs", () => {
    const doc = parseReviewDocument(
      JSON.stringify({
        findings: [
          {
            id: "r1",
            severity: "info",
            category: "error-handling",
            finding: "a",
            grounding: [{ quote: "shared", source: "plan" }],
          },
          {
            id: "r1",
            severity: "info",
            category: "error-handling",
            finding: "b",
            grounding: [{ quote: "shared", source: "plan" }],
          },
        ],
      }),
    )
    const corpus = buildReviewCorpus("", { summary: "shared" })
    const result = verifyReviewGrounding(doc, corpus)
    expect(result.kept).toHaveLength(1)
    expect(result.dropped.some((d) => d.reason === "duplicate_id")).toBe(true)
  })
})
