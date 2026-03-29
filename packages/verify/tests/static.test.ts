import { describe, expect, it } from "vitest"
import { createStaticCheckNode, runStaticChecks } from "../src/static.js"

describe("createStaticCheckNode", () => {
  it("returns a node with correct structure", () => {
    const node = createStaticCheckNode("/tmp/test")
    expect(node.id).toBe("static-checks")
    expect(node.name).toBe("Static Verification")
    expect(node.type).toBe("deterministic")
    expect(typeof node.execute).toBe("function")
  })
})

describe("static checks (integration)", () => {
  it("typecheck and lint pass against the bollard repo", async () => {
    const { results } = await runStaticChecks("/app")

    const typecheck = results.find((r) => r.check === "typecheck")
    const lint = results.find((r) => r.check === "lint")

    expect(typecheck).toBeDefined()
    expect(typecheck?.passed).toBe(true)
    expect(lint).toBeDefined()
    expect(lint?.passed).toBe(true)
  }, 60_000)

  it("returns results for all configured checks", async () => {
    const { results } = await runStaticChecks("/app")
    const checkNames = results.map((r) => r.check)
    expect(checkNames).toContain("typecheck")
    expect(checkNames).toContain("lint")
    expect(checkNames).toContain("audit")
    for (const r of results) {
      expect(r.durationMs).toBeGreaterThanOrEqual(0)
      expect(typeof r.output).toBe("string")
    }
  }, 60_000)
})
