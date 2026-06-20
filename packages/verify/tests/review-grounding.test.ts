import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { BollardError } from "@bollard/engine/src/errors.js"
import { describe, expect, it } from "vitest"
import {
  buildReviewCorpus,
  parseReviewDocument,
  type ReviewDocument,
  verifyReviewGrounding,
} from "../src/review-grounding.js"

const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/review-grounding")

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

  it("includes task, non_goals, affected_files, and sourceContents when provided", () => {
    const corpus = buildReviewCorpus(
      "+foo()\n",
      {
        summary: "summary text",
        non_goals: ["do not touch tests"],
        affected_files: { modify: ["src/a.ts"], create: ["tests/a.test.ts"] },
      },
      {
        task: "Add foo() method",
        sourceContents: ["function foo() { return 1 }"],
      },
    )
    const joined = corpus.entries.map((e) => e.text).join("\n")
    expect(joined).toContain("Add foo() method")
    expect(joined).toContain("do not touch tests")
    expect(joined).toContain("tests/a.test.ts")
    expect(joined).toContain("function foo()")
    expect(corpus.entries.some((e) => e.source === "diff" && e.text.includes("function foo"))).toBe(
      true,
    )
  })

  it("preserves backward compat when opts omitted", () => {
    const corpus = buildReviewCorpus("+line\n", { summary: "only summary" })
    expect(corpus.entries.some((e) => e.text.includes("only summary"))).toBe(true)
    expect(corpus.entries.length).toBe(2)
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

  it("accepts metric-driven categories", () => {
    const doc = parseReviewDocument(
      JSON.stringify({
        findings: [
          {
            id: "r1",
            severity: "warning",
            category: "insufficient-coverage",
            finding: "Coverage is below the threshold",
            grounding: [{ quote: "coverage 21% on changed file", source: "plan" }],
          },
          {
            id: "r2",
            severity: "error",
            category: "security-pattern",
            finding: "SAST found eval",
            grounding: [{ quote: "+eval(userInput)", source: "diff" }],
          },
        ],
      }),
    )
    const corpus = buildReviewCorpus("+eval(userInput)\n", {
      summary: "coverage 21% on changed file",
    })
    const result = verifyReviewGrounding(doc, corpus)
    expect(result.kept).toHaveLength(2)
    expect(result.dropped).toHaveLength(0)
  })

  it("still drops unknown categories", () => {
    const doc = parseReviewDocument(
      JSON.stringify({
        findings: [
          {
            id: "r1",
            severity: "warning",
            category: "made-up-category",
            finding: "x",
            grounding: [{ quote: "shared", source: "plan" }],
          },
        ],
      }),
    )
    const corpus = buildReviewCorpus("", { summary: "shared" })
    const result = verifyReviewGrounding(doc, corpus)
    expect(result.kept).toHaveLength(0)
    expect(result.dropped.some((d) => d.reason === "category_invalid")).toBe(true)
  })

  it("keeps diff finding with paraphrased quote when identifiers match corpus (identifier fallback)", () => {
    const doc = parseReviewDocument(
      JSON.stringify({
        findings: [
          {
            id: "r1",
            severity: "warning",
            category: "plan-divergence",
            finding: "humanReadable() returns a formatted cost string",
            grounding: [{ quote: "returns a formatted cost string", source: "diff" }],
          },
        ],
      }),
    )
    // diff contains humanReadable — identifier from finding text
    const corpus = buildReviewCorpus("+  humanReadable(): string {\n+    return 'formatted'\n", {})
    const result = verifyReviewGrounding(doc, corpus)
    expect(result.kept).toHaveLength(1)
    expect(result.dropped).toHaveLength(0)
  })

  it("drops diff finding when quote is paraphrased and no identifiers match", () => {
    const doc = parseReviewDocument(
      JSON.stringify({
        findings: [
          {
            id: "r1",
            severity: "info",
            category: "naming-consistency",
            finding: "method returns wrong value",
            grounding: [{ quote: "returns wrong value", source: "diff" }],
          },
        ],
      }),
    )
    // diff has no identifiers matching the finding text
    const corpus = buildReviewCorpus("+  foo(): number {\n+    return 42\n", {})
    const result = verifyReviewGrounding(doc, corpus)
    expect(result.kept).toHaveLength(0)
    expect(result.dropped.some((d) => d.reason === "grounding_not_in_corpus")).toBe(true)
  })

  it("identifier fallback does not apply to plan-sourced quotes (verbatim required)", () => {
    const doc = parseReviewDocument(
      JSON.stringify({
        findings: [
          {
            id: "r1",
            severity: "warning",
            category: "plan-divergence",
            finding: "humanReadable method is not in the plan",
            grounding: [{ quote: "paraphrased plan text", source: "plan" }],
          },
        ],
      }),
    )
    const corpus = buildReviewCorpus("+  humanReadable(): string {}\n", {
      summary: "actual plan text here",
    })
    const result = verifyReviewGrounding(doc, corpus)
    // plan source still requires verbatim — identifier fallback only for diff
    expect(result.kept).toHaveLength(0)
    expect(result.dropped.some((d) => d.reason === "grounding_not_in_corpus")).toBe(true)
  })
})

describe("verifyReviewGrounding corpus broadening safety", () => {
  it("still drops genuinely ungrounded findings after corpus broadening", () => {
    const doc = parseReviewDocument(
      JSON.stringify({
        findings: [
          {
            id: "hallucinated",
            severity: "error",
            category: "api-compatibility",
            finding: "CostTracker now deletes persisted run history on every add()",
            grounding: [{ quote: "deleteAllRunHistory()", source: "diff" }],
          },
        ],
      }),
    )
    const corpus = buildReviewCorpus(
      "+  add(cost: number)\n",
      {
        summary: "Add increment helper",
        non_goals: ["do not touch history"],
        affected_files: { modify: ["cost-tracker.ts"] },
      },
      {
        task: "Add increment helper to CostTracker",
        sourceContents: ["add(cost: number) { this._total += cost }"],
      },
    )
    const result = verifyReviewGrounding(doc, corpus)
    expect(result.kept).toHaveLength(0)
    expect(result.dropped.some((d) => d.reason === "grounding_not_in_corpus")).toBe(true)
  })

  it("keeps non_goals plan quote when non_goals are in corpus", () => {
    const doc: ReviewDocument = {
      findings: [
        {
          id: "r1",
          severity: "error",
          category: "plan-divergence",
          finding: "Modified existing test file against plan",
          grounding: [
            {
              quote:
                "Do not modify existing test files (cost-tracker.test.ts, cost-tracker-*.test.ts)",
              source: "plan",
            },
          ],
        },
      ],
    }
    const withoutNonGoals = buildReviewCorpus("diff", { summary: "summary only" })
    const withNonGoals = buildReviewCorpus("diff", {
      summary: "summary only",
      non_goals: [
        "Do not modify existing test files (cost-tracker.test.ts, cost-tracker-*.test.ts)",
      ],
    })
    expect(verifyReviewGrounding(doc, withoutNonGoals).kept).toHaveLength(0)
    expect(verifyReviewGrounding(doc, withNonGoals).kept).toHaveLength(1)
  })
})

interface CaptureFixture {
  runId: string
  task: string
  diff: string
  plan: unknown
  parsedFindings: ReviewDocument["findings"]
}

interface ClassificationEntry {
  runId: string
  id: string
  label: "FALSE" | "CORRECT"
}

describe("review grounding fixture replay", () => {
  it("improves keep-rate on captured runs without admitting CORRECT-labeled drops", async () => {
    const classification = JSON.parse(
      await readFile(resolve(fixtureDir, "classification.json"), "utf-8"),
    ) as { findings: ClassificationEntry[] }

    const fixtureIds = ["20260620-0352-run-1238f9", "20260620-0355-run-3a278e"]

    for (const runId of fixtureIds) {
      const raw = await readFile(resolve(fixtureDir, `${runId}.json`), "utf-8")
      const fixture = JSON.parse(raw) as CaptureFixture
      const doc: ReviewDocument = { findings: fixture.parsedFindings }

      const oldResult = verifyReviewGrounding(doc, buildReviewCorpus(fixture.diff, fixture.plan))
      const newResult = verifyReviewGrounding(
        doc,
        buildReviewCorpus(fixture.diff, fixture.plan, { task: fixture.task }),
      )

      expect(newResult.kept.length).toBeGreaterThanOrEqual(oldResult.kept.length)

      const labels = classification.findings.filter((f) => f.runId === runId)
      for (const entry of labels) {
        const stillDropped = newResult.dropped.some((d) => d.id === entry.id)
        const nowKept = newResult.kept.some((f) => f.id === entry.id)
        if (entry.label === "CORRECT") {
          expect(stillDropped || !nowKept).toBe(true)
        }
        if (entry.label === "FALSE") {
          expect(nowKept).toBe(true)
        }
      }
    }
  })
})
