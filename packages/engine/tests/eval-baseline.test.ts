import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { compareToEvalBaseline, readEvalBaseline, writeEvalBaseline } from "../src/eval-baseline.js"
import type { AgentEvalScore, EvalBaseline } from "../src/eval-baseline.js"

function score(agent: string, passRate: number, thresholdPct = 10): AgentEvalScore {
  return { agent, caseCount: 4, passRate, thresholdPct }
}

function baseline(scores: AgentEvalScore[]): EvalBaseline {
  return {
    tag: "test",
    timestamp: 1_700_000_000_000,
    model: "claude-haiku-4-5-20251001",
    scores,
  }
}

describe("readEvalBaseline", () => {
  it("returns null for nonexistent file", async () => {
    const path = join(tmpdir(), `missing-eval-baseline-${randomUUID()}.json`)
    await expect(readEvalBaseline(path)).resolves.toBeNull()
  })

  it("parses a valid baseline JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bollard-eb-"))
    try {
      const file = join(dir, "eval-baseline.json")
      const b = baseline([score("planner", 1)])
      await writeEvalBaseline(file, b)
      const got = await readEvalBaseline(file)
      expect(got).toEqual(b)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("writeEvalBaseline", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bollard-eb-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("creates the file and parent dirs", async () => {
    const file = join(dir, "nested", "eval-baseline.json")
    const b = baseline([score("coder", 0.75)])
    await writeEvalBaseline(file, b)
    const got = await readEvalBaseline(file)
    expect(got).toEqual(b)
  })

  it("round-trips with readEvalBaseline", async () => {
    const file = join(dir, "eval-baseline.json")
    const b = baseline([score("planner", 1, 10), score("coder", 0.5, 15)])
    await writeEvalBaseline(file, b)
    const got = await readEvalBaseline(file)
    expect(got).toEqual(b)
  })
})

describe("compareToEvalBaseline", () => {
  it('returns verdict "pass" when all agents meet threshold', () => {
    const b = baseline([score("planner", 1, 10), score("coder", 0.8, 10)])
    const current = [score("planner", 1, 10), score("coder", 0.75, 10)]
    const cmp = compareToEvalBaseline(b, current)
    expect(cmp.verdict).toBe("pass")
    expect(cmp.regressions).toHaveLength(0)
  })

  it('returns verdict "fail" when one agent drops more than thresholdPct', () => {
    const b = baseline([score("planner", 1, 10)])
    const current = [score("planner", 0.89, 10)]
    const cmp = compareToEvalBaseline(b, current)
    expect(cmp.verdict).toBe("fail")
    expect(cmp.regressions).toHaveLength(1)
    expect(cmp.regressions[0]?.agent).toBe("planner")
  })

  it("no regression when current passRate equals baseline exactly", () => {
    const b = baseline([score("planner", 0.9, 10)])
    const current = [score("planner", 0.9, 10)]
    const cmp = compareToEvalBaseline(b, current)
    expect(cmp.verdict).toBe("pass")
    expect(cmp.regressions).toHaveLength(0)
  })

  it("no regression for an agent missing from current (removed agent)", () => {
    const b = baseline([score("planner", 1, 10), score("coder", 1, 10)])
    const current = [score("planner", 1, 10)]
    const cmp = compareToEvalBaseline(b, current)
    expect(cmp.verdict).toBe("pass")
    expect(cmp.regressions).toHaveLength(0)
  })

  it("regression when passRate drops by exactly thresholdPct + 1", () => {
    const b = baseline([score("planner", 1, 10)])
    const current = [score("planner", 0.89, 10)]
    const cmp = compareToEvalBaseline(b, current)
    expect(cmp.verdict).toBe("fail")
  })

  it("no regression when passRate drops by exactly thresholdPct - 1", () => {
    const b = baseline([score("planner", 1, 10)])
    const current = [score("planner", 0.91, 10)]
    const cmp = compareToEvalBaseline(b, current)
    expect(cmp.verdict).toBe("pass")
  })
})
