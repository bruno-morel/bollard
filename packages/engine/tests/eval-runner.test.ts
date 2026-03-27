import { describe, expect, it } from "vitest"
import type { EvalCase, EvalProvider, EvalResponse } from "../src/eval-runner.js"
import { runEvals } from "../src/eval-runner.js"

function textResponse(
  text: string,
  opts?: { outputTokens?: number; costUsd?: number },
): EvalResponse {
  return {
    content: [{ type: "text", text }],
    usage: { inputTokens: 10, outputTokens: opts?.outputTokens ?? 20 },
    costUsd: opts?.costUsd ?? 0.001,
  }
}

function mockProvider(responses: EvalResponse[]): EvalProvider {
  let idx = 0
  return {
    async chat() {
      return responses[idx++] as EvalResponse
    },
  }
}

function makeCase(overrides: Partial<EvalCase> & { id: string }): EvalCase {
  return {
    description: "test case",
    systemPrompt: "You are a test assistant.",
    messages: [{ role: "user", content: "test" }],
    assertions: [],
    ...overrides,
  }
}

describe("runEvals", () => {
  it("contains assertion passes when text includes value", async () => {
    const provider = mockProvider([textResponse("hello world")])
    const results = await runEvals(
      [makeCase({ id: "c1", assertions: [{ type: "contains", value: "hello" }] })],
      provider,
      { model: "test", runs: 1 },
    )

    expect(results[0]?.ok).toBe(true)
    expect(results[0]?.details[0]?.assertions[0]?.passed).toBe(true)
  })

  it("contains assertion fails when text is missing value", async () => {
    const provider = mockProvider([textResponse("goodbye")])
    const results = await runEvals(
      [makeCase({ id: "c1", assertions: [{ type: "contains", value: "hello" }] })],
      provider,
      { model: "test", runs: 1 },
    )

    expect(results[0]?.ok).toBe(false)
    expect(results[0]?.details[0]?.assertions[0]?.passed).toBe(false)
  })

  it("not_contains assertion works both ways", async () => {
    const provider = mockProvider([textResponse("safe content"), textResponse("has forbidden")])

    const passResult = await runEvals(
      [makeCase({ id: "c1", assertions: [{ type: "not_contains", value: "forbidden" }] })],
      provider,
      { model: "test", runs: 1 },
    )
    expect(passResult[0]?.ok).toBe(true)

    const failResult = await runEvals(
      [makeCase({ id: "c2", assertions: [{ type: "not_contains", value: "forbidden" }] })],
      provider,
      { model: "test", runs: 1 },
    )
    expect(failResult[0]?.ok).toBe(false)
  })

  it("matches_regex assertion validates pattern", async () => {
    const provider = mockProvider([textResponse("code: 123-4567")])
    const results = await runEvals(
      [makeCase({ id: "c1", assertions: [{ type: "matches_regex", value: "\\d{3}-\\d{4}" }] })],
      provider,
      { model: "test", runs: 1 },
    )

    expect(results[0]?.details[0]?.assertions[0]?.passed).toBe(true)
  })

  it("json_field assertion checks nested values", async () => {
    const provider = mockProvider([textResponse('{"risk": {"tier": "low"}}')])
    const results = await runEvals(
      [
        makeCase({
          id: "c1",
          assertions: [{ type: "json_field", path: "risk.tier", value: "low" }],
        }),
      ],
      provider,
      { model: "test", runs: 1 },
    )

    expect(results[0]?.details[0]?.assertions[0]?.passed).toBe(true)
  })

  it("max_tokens assertion checks output token count", async () => {
    const provider = mockProvider([textResponse("short", { outputTokens: 50 })])

    const pass = await runEvals(
      [makeCase({ id: "c1", assertions: [{ type: "max_tokens", value: 100 }] })],
      provider,
      { model: "test", runs: 1 },
    )
    expect(pass[0]?.ok).toBe(true)

    const provider2 = mockProvider([textResponse("long", { outputTokens: 150 })])
    const fail = await runEvals(
      [makeCase({ id: "c2", assertions: [{ type: "max_tokens", value: 100 }] })],
      provider2,
      { model: "test", runs: 1 },
    )
    expect(fail[0]?.ok).toBe(false)
  })

  it("max_cost assertion checks response cost", async () => {
    const provider = mockProvider([textResponse("cheap", { costUsd: 0.01 })])
    const pass = await runEvals(
      [makeCase({ id: "c1", assertions: [{ type: "max_cost", value: 0.05 }] })],
      provider,
      { model: "test", runs: 1 },
    )
    expect(pass[0]?.ok).toBe(true)

    const provider2 = mockProvider([textResponse("expensive", { costUsd: 0.1 })])
    const fail = await runEvals(
      [makeCase({ id: "c2", assertions: [{ type: "max_cost", value: 0.05 }] })],
      provider2,
      { model: "test", runs: 1 },
    )
    expect(fail[0]?.ok).toBe(false)
  })

  it("runs N times and computes pass rate", async () => {
    const provider = mockProvider([
      textResponse("hello"),
      textResponse("hello"),
      textResponse("goodbye"),
    ])
    const results = await runEvals(
      [makeCase({ id: "c1", assertions: [{ type: "contains", value: "hello" }] })],
      provider,
      { model: "test", runs: 3 },
    )

    expect(results[0]?.runs).toBe(3)
    expect(results[0]?.passed).toBe(2)
    expect(results[0]?.passRate).toBeCloseTo(2 / 3)
    expect(results[0]?.ok).toBe(true)
  })

  it("enforces custom threshold", async () => {
    const provider = mockProvider([
      textResponse("hello"),
      textResponse("hello"),
      textResponse("goodbye"),
    ])
    const results = await runEvals(
      [makeCase({ id: "c1", assertions: [{ type: "contains", value: "hello" }] })],
      provider,
      { model: "test", runs: 3, threshold: 1.0 },
    )

    expect(results[0]?.passRate).toBeCloseTo(2 / 3)
    expect(results[0]?.ok).toBe(false)
  })

  it("handles multiple eval cases", async () => {
    const provider = mockProvider([textResponse("hello"), textResponse("nope")])
    const results = await runEvals(
      [
        makeCase({ id: "pass", assertions: [{ type: "contains", value: "hello" }] }),
        makeCase({ id: "fail", assertions: [{ type: "contains", value: "hello" }] }),
      ],
      provider,
      { model: "test", runs: 1 },
    )

    expect(results).toHaveLength(2)
    expect(results[0]?.ok).toBe(true)
    expect(results[1]?.ok).toBe(false)
  })

  it("passes with empty assertions (vacuous truth)", async () => {
    const provider = mockProvider([textResponse("anything")])
    const results = await runEvals([makeCase({ id: "c1", assertions: [] })], provider, {
      model: "test",
      runs: 1,
    })

    expect(results[0]?.ok).toBe(true)
  })

  it("extracts JSON from markdown code blocks", async () => {
    const wrapped = '```json\n{"status": "ok"}\n```'
    const provider = mockProvider([textResponse(wrapped)])
    const results = await runEvals(
      [makeCase({ id: "c1", assertions: [{ type: "json_field", path: "status", value: "ok" }] })],
      provider,
      { model: "test", runs: 1 },
    )

    expect(results[0]?.details[0]?.assertions[0]?.passed).toBe(true)
  })
})
