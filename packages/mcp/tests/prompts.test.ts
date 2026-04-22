import { describe, expect, it } from "vitest"
import { prompts } from "../src/prompts.js"

describe("MCP prompt definitions", () => {
  it("registers exactly 3 prompts", () => {
    expect(prompts).toHaveLength(3)
  })

  it("all prompts have name, description, and template", () => {
    for (const p of prompts) {
      expect(p.name).toBeTruthy()
      expect(p.description).toBeTruthy()
      expect(p.template).toBeTruthy()
    }
  })

  it("contract-review prompt has optional focus argument", () => {
    const p = prompts.find((x) => x.name === "contract-review")
    expect(p).toBeDefined()
    const focus = p?.arguments?.find((a) => a.name === "focus")
    expect(focus).toBeDefined()
    expect(focus?.required).toBe(false)
  })
})
