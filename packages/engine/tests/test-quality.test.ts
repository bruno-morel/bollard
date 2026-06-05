import { describe, expect, it } from "vitest"
import type { TestOwnershipManifest } from "../src/ownership.js"
import type { RunRecord } from "../src/run-history.js"
import type { PromotedManifest } from "../src/test-fingerprint.js"
import {
  assessTestQuality,
  buildCurationCorpus,
  promoteAdversarialTests,
  pruneRedundantTests,
  verifyCurationGrounding,
} from "../src/test-quality.js"

const emptyManifest: TestOwnershipManifest = {
  schemaVersion: 1,
  bollardManaged: [],
  userOwned: [],
  lastUpdated: 0,
}

const emptyPromoted: PromotedManifest = {
  schemaVersion: 1,
  promoted: [],
}

function makeRunRecord(mutationScore?: number): RunRecord {
  return {
    type: "run",
    schemaVersion: 1,
    runId: "test-run",
    blueprintId: "implement-feature",
    task: "test",
    timestamp: Date.now(),
    status: "success",
    totalCostUsd: 1,
    totalDurationMs: 1000,
    nodes: [],
    testCount: { passed: 10, skipped: 0, failed: 0 },
    scopes: [],
    ...(mutationScore !== undefined ? { mutationScore } : {}),
  }
}

describe("assessTestQuality", () => {
  it("returns score 80+ when mutationScore >= 80", () => {
    const score = assessTestQuality(
      "packages/engine/tests/cost-tracker.test.ts",
      {
        ...emptyManifest,
        bollardManaged: [
          {
            path: "packages/engine/tests/cost-tracker.test.ts",
            domain: "tests",
            lastCuratedRunId: "run-1",
            lastCommitSha: "abc",
          },
        ],
      },
      emptyPromoted,
      [makeRunRecord(85)],
    )
    expect(score.score).toBeGreaterThanOrEqual(80)
    expect(score.mutationScore).toBe(85)
  })

  it("returns score 50 base when no mutationScore", () => {
    const score = assessTestQuality("tests/foo.test.ts", emptyManifest, emptyPromoted, [])
    expect(score.score).toBe(55)
  })

  it("penalizes 20 when mutationScore < 60", () => {
    const score = assessTestQuality(
      "tests/foo.test.ts",
      {
        ...emptyManifest,
        bollardManaged: [
          {
            path: "tests/foo.test.ts",
            domain: "tests",
            lastCuratedRunId: "run-1",
            lastCommitSha: "abc",
          },
        ],
      },
      emptyPromoted,
      [makeRunRecord(45)],
    )
    expect(score.score).toBe(30)
  })

  it("penalizes 15 when coveredByAdversarial", () => {
    const promoted: PromotedManifest = {
      schemaVersion: 1,
      promoted: [
        {
          hash: "abc",
          promotedAt: 1,
          sourcePath: ".bollard/tests/boundary/foo.adversarial.test.ts",
          destPath: "tests/foo.adversarial.test.ts",
        },
      ],
    }
    const score = assessTestQuality(
      "tests/foo.test.ts",
      {
        ...emptyManifest,
        bollardManaged: [
          {
            path: "tests/foo.test.ts",
            domain: "tests",
            lastCuratedRunId: "run-1",
            lastCommitSha: "abc",
          },
        ],
      },
      promoted,
      [],
    )
    expect(score.coveredByAdversarial).toBe(true)
    expect(score.score).toBe(35)
  })

  it("isManaged: true when file in bollardManaged", () => {
    const score = assessTestQuality(
      "tests/managed.test.ts",
      {
        ...emptyManifest,
        bollardManaged: [
          {
            path: "tests/managed.test.ts",
            domain: "tests",
            lastCuratedRunId: "run-9",
            lastCommitSha: "sha",
          },
        ],
      },
      emptyPromoted,
      [],
    )
    expect(score.isManaged).toBe(true)
  })

  it("lastCuratedRunId populated from manifest entry", () => {
    const score = assessTestQuality(
      "tests/managed.test.ts",
      {
        ...emptyManifest,
        bollardManaged: [
          {
            path: "tests/managed.test.ts",
            domain: "tests",
            lastCuratedRunId: "20260604-run-abc",
            lastCommitSha: "sha",
          },
        ],
      },
      emptyPromoted,
      [],
    )
    expect(score.lastCuratedRunId).toBe("20260604-run-abc")
  })
})

describe("promoteAdversarialTests", () => {
  it("returns promoted paths not in bollardManaged", () => {
    const promoted: PromotedManifest = {
      schemaVersion: 1,
      promoted: [
        {
          hash: "h1",
          promotedAt: 1,
          sourcePath: ".bollard/tests/boundary/a.adversarial.test.ts",
          destPath: "tests/a.adversarial.test.ts",
        },
      ],
    }
    const paths = promoteAdversarialTests(emptyManifest, promoted)
    expect(paths).toEqual([".bollard/tests/boundary/a.adversarial.test.ts"])
  })

  it("filters out paths already in bollardManaged", () => {
    const promoted: PromotedManifest = {
      schemaVersion: 1,
      promoted: [
        {
          hash: "h1",
          promotedAt: 1,
          sourcePath: ".bollard/tests/boundary/a.adversarial.test.ts",
          destPath: "tests/a.adversarial.test.ts",
        },
      ],
    }
    const manifest: TestOwnershipManifest = {
      ...emptyManifest,
      bollardManaged: [
        {
          path: "tests/a.adversarial.test.ts",
          domain: "tests",
          lastCuratedRunId: "r1",
          lastCommitSha: "s1",
        },
      ],
    }
    expect(promoteAdversarialTests(manifest, promoted)).toEqual([])
  })

  it("caps at 20 candidates", () => {
    const promoted: PromotedManifest = {
      schemaVersion: 1,
      promoted: Array.from({ length: 25 }, (_, i) => ({
        hash: `h${i}`,
        promotedAt: i,
        sourcePath: `.bollard/tests/boundary/t${i}.adversarial.test.ts`,
        destPath: `tests/t${i}.adversarial.test.ts`,
      })),
    }
    expect(promoteAdversarialTests(emptyManifest, promoted)).toHaveLength(20)
  })
})

describe("pruneRedundantTests", () => {
  it("returns managed file when basename matches promoted adversarial module", () => {
    const managed = [
      {
        path: "tests/cost-tracker.test.ts",
        domain: "tests" as const,
        lastCuratedRunId: "r1",
        lastCommitSha: "s1",
      },
    ]
    const promoted: PromotedManifest = {
      schemaVersion: 1,
      promoted: [
        {
          hash: "h1",
          promotedAt: 1,
          sourcePath: ".bollard/tests/boundary/cost-tracker.adversarial.test.ts",
          destPath: "tests/cost-tracker.adversarial.test.ts",
        },
      ],
    }
    expect(pruneRedundantTests(managed, promoted)).toEqual(["tests/cost-tracker.test.ts"])
  })

  it("returns empty when no match", () => {
    const managed = [
      {
        path: "tests/other.test.ts",
        domain: "tests" as const,
        lastCuratedRunId: "r1",
        lastCommitSha: "s1",
      },
    ]
    const promoted: PromotedManifest = {
      schemaVersion: 1,
      promoted: [
        {
          hash: "h1",
          promotedAt: 1,
          sourcePath: ".bollard/tests/boundary/foo.adversarial.test.ts",
          destPath: "tests/foo.adversarial.test.ts",
        },
      ],
    }
    expect(pruneRedundantTests(managed, promoted)).toEqual([])
  })
})

describe("verifyCurationGrounding", () => {
  it("keeps candidate with verbatim quote in corpus", () => {
    const scores = [
      {
        filePath: "tests/foo.test.ts",
        score: 30,
        isManaged: true,
        coveredByAdversarial: true,
      },
    ]
    const corpus = buildCurationCorpus(scores, emptyManifest)
    const result = verifyCurationGrounding(
      {
        candidates: [
          {
            id: "c1",
            action: "prune",
            filePath: "tests/foo.test.ts",
            claim: "Redundant",
            grounding: [{ quote: '"coveredByAdversarial": true', source: "quality-report" }],
          },
        ],
      },
      corpus,
    )
    expect(result.kept).toHaveLength(1)
    expect(result.dropped).toHaveLength(0)
  })

  it("drops candidate with paraphrase", () => {
    const corpus = buildCurationCorpus([], emptyManifest)
    const result = verifyCurationGrounding(
      {
        candidates: [
          {
            id: "c1",
            action: "prune",
            filePath: "tests/foo.test.ts",
            claim: "Redundant",
            grounding: [{ quote: "this test is redundant", source: "quality-report" }],
          },
        ],
      },
      corpus,
    )
    expect(result.kept).toHaveLength(0)
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]?.reason).toBe("grounding_not_in_corpus")
  })
})
