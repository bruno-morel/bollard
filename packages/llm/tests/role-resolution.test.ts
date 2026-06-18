import { BollardError } from "@bollard/engine/src/errors.js"
import { describe, expect, it } from "vitest"
import type { ModelRegistryEntry } from "../src/model-registry.js"
import { capabilityRank, MODEL_REGISTRY, resolveModelForRole } from "../src/model-registry.js"
import { ROLE_REQUIREMENTS } from "../src/role-requirements.js"

const HAIKU = "claude-haiku-4-5-20251001"
const SONNET = "claude-sonnet-4-6"

const GOLDEN_ROLES: [string, string][] = [
  ["planner", HAIKU],
  ["coder", SONNET],
  ["boundary-tester", HAIKU],
  ["contract-tester", HAIKU],
  ["behavioral-tester", HAIKU],
  ["semantic-reviewer", HAIKU],
  ["test-curator", HAIKU],
]

describe("resolveModelForRole golden reproduction", () => {
  it.each(GOLDEN_ROLES)("role %s resolves to %s on anthropic", (role, expectedModel) => {
    const entry = resolveModelForRole(role, "anthropic")
    expect(entry?.id).toBe(expectedModel)
  })

  it("coder resolves to Sonnet 4.6 not Opus (output-price tie-break)", () => {
    const entry = resolveModelForRole("coder", "anthropic")
    expect(entry?.id).toBe(SONNET)
    expect(entry?.id).not.toMatch(/^claude-opus/)
  })
})

describe("resolveModelForRole empty cases", () => {
  it("returns undefined for unknown role", () => {
    expect(resolveModelForRole("nonexistent-role", "anthropic")).toBeUndefined()
  })

  it("returns undefined for unknown provider (mock escape hatch)", () => {
    expect(resolveModelForRole("coder", "mock")).toBeUndefined()
  })

  it("throws MODEL_NOT_AVAILABLE when provider is known but requirements unsatisfiable", () => {
    expect(() => resolveModelForRole("coder", "openai")).toThrow(BollardError)
    try {
      resolveModelForRole("coder", "openai")
    } catch (err) {
      expect(BollardError.hasCode(err, "MODEL_NOT_AVAILABLE")).toBe(true)
      if (BollardError.is(err)) {
        expect(err.context?.role).toBe("coder")
        expect(err.context?.provider).toBe("openai")
      }
    }
  })

  it("throws MODEL_NOT_AVAILABLE when no current model meets requirements", () => {
    const impossibleRegistry: ModelRegistryEntry[] = [
      {
        id: "tiny-model",
        provider: "anthropic",
        status: "current",
        capabilities: {
          reasoning: "light",
          codegen: "light",
          toolUse: false,
          streaming: true,
          contextWindow: 1_000,
          maxOutput: 1_000,
        },
        pricing: { input: 0.1, output: 0.1 },
        verifiedOn: "2026-06-04",
      },
    ]
    expect(() => resolveModelForRole("coder", "anthropic", impossibleRegistry)).toThrow(
      BollardError,
    )
    try {
      resolveModelForRole("coder", "anthropic", impossibleRegistry)
    } catch (err) {
      expect(BollardError.hasCode(err, "MODEL_NOT_AVAILABLE")).toBe(true)
      if (BollardError.is(err)) {
        expect(err.context?.requirements).toEqual(ROLE_REQUIREMENTS.coder)
      }
    }
  })
})

describe("capabilityRank", () => {
  it("orders light < standard < frontier", () => {
    expect(capabilityRank("light")).toBeLessThan(capabilityRank("standard"))
    expect(capabilityRank("standard")).toBeLessThan(capabilityRank("frontier"))
  })
})

describe("MODEL_REGISTRY sanity for ROLE_REQUIREMENTS", () => {
  it("every ROLE_REQUIREMENTS role has at least one satisfiable anthropic current model", () => {
    for (const role of Object.keys(ROLE_REQUIREMENTS)) {
      if (role === "llm-fallback-extractor") continue
      const entry = resolveModelForRole(role, "anthropic")
      expect(entry, `role ${role}`).toBeDefined()
    }
  })

  it("anthropic registry has current entries", () => {
    const anthropicCurrent = MODEL_REGISTRY.filter(
      (e) => e.provider === "anthropic" && e.status === "current",
    )
    expect(anthropicCurrent.length).toBeGreaterThan(0)
  })
})
