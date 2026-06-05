import { afterEach, describe, expect, it, vi } from "vitest"

describe("model-registry", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it("findModelEntry returns current sonnet-4-6 with 3/15 pricing", async () => {
    const { findModelEntry } = await import("../src/model-registry.js")
    const entry = findModelEntry("claude-sonnet-4-6")
    expect(entry).toBeDefined()
    expect(entry?.status).toBe("current")
    expect(entry?.pricing.input).toBe(3)
    expect(entry?.pricing.output).toBe(15)
  })

  it("findModelEntry returns deprecated for claude-sonnet-4-20250514", async () => {
    const { findModelEntry } = await import("../src/model-registry.js")
    const entry = findModelEntry("claude-sonnet-4-20250514")
    expect(entry?.status).toBe("deprecated")
  })

  it("findModelEntry returns undefined for unknown id", async () => {
    const { findModelEntry } = await import("../src/model-registry.js")
    expect(findModelEntry("nope")).toBeUndefined()
  })

  it("estimateCostForModel computes known model cost", async () => {
    const { estimateCostForModel } = await import("../src/model-registry.js")
    const cost = estimateCostForModel("claude-sonnet-4-6", 1_000_000, 1_000_000, {
      input: 99,
      output: 99,
    })
    expect(cost).toBe(18)
  })

  it("estimateCostForModel warns once for unknown model then uses fallback", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const { estimateCostForModel } = await import("../src/model-registry.js")
    const fallback = { input: 2, output: 8 }
    const first = estimateCostForModel("totally-unknown-model", 1_000_000, 1_000_000, fallback)
    const second = estimateCostForModel("totally-unknown-model", 1_000_000, 0, fallback)
    expect(first).toBe(10)
    expect(second).toBe(2)
    const warnCalls = stderrSpy.mock.calls.filter((c) =>
      String(c[0]).includes("totally-unknown-model"),
    )
    expect(warnCalls).toHaveLength(1)
  })

  it("every registry entry has parseable verifiedOn", async () => {
    const { MODEL_REGISTRY } = await import("../src/model-registry.js")
    for (const entry of MODEL_REGISTRY) {
      expect(entry.verifiedOn.length).toBeGreaterThan(0)
      expect(Number.isNaN(new Date(entry.verifiedOn).getTime())).toBe(false)
    }
  })

  it("current Anthropic Opus entries price at 5/25", async () => {
    const { findModelEntry } = await import("../src/model-registry.js")
    for (const id of ["claude-opus-4-8", "claude-opus-4-6"]) {
      const entry = findModelEntry(id)
      expect(entry?.pricing.input).toBe(5)
      expect(entry?.pricing.output).toBe(25)
    }
  })

  it("registryEntriesForProvider returns only matching provider", async () => {
    const { registryEntriesForProvider } = await import("../src/model-registry.js")
    const anthropic = registryEntriesForProvider("anthropic")
    expect(anthropic.length).toBeGreaterThan(0)
    expect(anthropic.every((e) => e.provider === "anthropic")).toBe(true)
    expect(anthropic.some((e) => e.provider === "openai")).toBe(false)
  })
})
