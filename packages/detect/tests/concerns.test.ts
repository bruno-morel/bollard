import { describe, expect, it } from "vitest"
import {
  DEFAULT_CONCERN_WEIGHTS,
  defaultAdversarialConfig,
  resolveScopeConcerns,
} from "../src/concerns.js"

describe("defaultAdversarialConfig", () => {
  it("matches spec §4 default weight matrix for boundary", () => {
    const a = defaultAdversarialConfig({ language: "typescript" })
    expect(a.boundary.concerns).toEqual(DEFAULT_CONCERN_WEIGHTS.boundary)
  })

  it("matches spec §4 for contract and behavioral", () => {
    const a = defaultAdversarialConfig({ language: "typescript" })
    expect(a.contract.concerns).toEqual(DEFAULT_CONCERN_WEIGHTS.contract)
    expect(a.behavioral.concerns).toEqual(DEFAULT_CONCERN_WEIGHTS.behavioral)
  })

  it("sets behavioral.enabled false and boundary.mode in-language", () => {
    const a = defaultAdversarialConfig({ language: "go" })
    expect(a.behavioral.enabled).toBe(false)
    expect(a.boundary.mode).toBe("in-language")
    expect(a.contract.enabled).toBe(true)
    expect(a.contract.frameworkCapable).toBe(true)
  })

  it("sets contract.frameworkCapable false for unknown language", () => {
    const a = defaultAdversarialConfig({ language: "unknown" })
    expect(a.contract.frameworkCapable).toBe(false)
  })
})

describe("resolveScopeConcerns", () => {
  it("uses scope override over global over default matrix (spec §4 / §9)", () => {
    const global = { security: "off" as const, performance: "low" as const }
    const scope = { security: "high" as const }
    const c = resolveScopeConcerns("boundary", global, scope)
    expect(c.security).toBe("high")
    expect(c.performance).toBe("low")
    expect(c.correctness).toBe("high")
  })

  it("uses global when scope does not set a concern", () => {
    const global = { security: "off" as const }
    const c = resolveScopeConcerns("contract", global, undefined)
    expect(c.security).toBe("off")
    expect(c.correctness).toBe("high")
  })

  it("uses default matrix when no overrides", () => {
    const c = resolveScopeConcerns("behavioral", undefined, undefined)
    expect(c).toEqual(DEFAULT_CONCERN_WEIGHTS.behavioral)
  })
})
