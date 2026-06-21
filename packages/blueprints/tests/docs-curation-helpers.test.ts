import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { DocsGroundingResult } from "@bollard/engine/src/docs-curation.js"
import { afterEach, describe, expect, it } from "vitest"
import {
  buildDocsGroundingReport,
  DOCS_GROUNDING_REPORT_FILE,
  writeDocsGroundingReport,
} from "../src/docs-curation-helpers.js"

describe("buildDocsGroundingReport", () => {
  it("maps kept and dropped with file enrichment from plan edits", () => {
    const result: DocsGroundingResult = {
      kept: [
        {
          id: "d1",
          file: "README.md",
          oldText: "old",
          newText: "new",
          rationale: "fix",
          grounding: [{ quote: "fact", source: "audit" }],
        },
      ],
      dropped: [
        { id: "d2", reason: "grounding_not_in_corpus" },
        { id: "d3", reason: "file_not_allowed", detail: "spec/01-architecture.md" },
      ],
    }

    const report = buildDocsGroundingReport(
      "run-123",
      [{ path: "README.md", reasons: ["audit: test-count-consistency"] }],
      [
        {
          id: "d1",
          file: "README.md",
          oldText: "old",
          newText: "new",
          rationale: "fix",
          grounding: [{ quote: "fact", source: "audit" }],
        },
        {
          id: "d2",
          file: "CLAUDE.md",
          oldText: "x",
          newText: "y",
          rationale: "bad",
          grounding: [{ quote: "nope", source: "roadmap" }],
        },
      ],
      result,
    )

    expect(report.runId).toBe("run-123")
    expect(report.kept).toEqual([{ id: "d1", file: "README.md" }])
    expect(report.dropped[0]).toEqual({
      id: "d2",
      file: "CLAUDE.md",
      reason: "grounding_not_in_corpus",
    })
    expect(report.dropped[1]).toEqual({
      id: "d3",
      file: "spec/01-architecture.md",
      reason: "file_not_allowed",
    })
    expect(report.candidates).toHaveLength(1)
  })
})

describe("writeDocsGroundingReport", () => {
  let workDir: string

  afterEach(async () => {
    if (workDir !== undefined) {
      await rm(workDir, { recursive: true, force: true })
    }
  })

  it("writes grounding-report.json under .bollard/curation/docs", async () => {
    workDir = await mkdtemp(join(tmpdir(), "grounding-report-"))
    const report = buildDocsGroundingReport("run-abc", [], [], { kept: [], dropped: [] })
    await writeDocsGroundingReport(workDir, report)

    const raw = await readFile(resolve(workDir, DOCS_GROUNDING_REPORT_FILE), "utf-8")
    const parsed = JSON.parse(raw) as { runId: string; kept: unknown[]; dropped: unknown[] }
    expect(parsed.runId).toBe("run-abc")
    expect(parsed.kept).toEqual([])
    expect(parsed.dropped).toEqual([])
  })
})
