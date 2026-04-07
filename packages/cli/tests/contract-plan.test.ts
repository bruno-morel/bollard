import { describe, expect, it } from "vitest"
import { collectAffectedPathsFromPlan } from "../src/contract-plan.js"

describe("collectAffectedPathsFromPlan", () => {
  it("returns empty array when plan is missing or invalid", () => {
    expect(collectAffectedPathsFromPlan(undefined)).toEqual([])
    expect(collectAffectedPathsFromPlan(null)).toEqual([])
    expect(collectAffectedPathsFromPlan("x")).toEqual([])
    expect(collectAffectedPathsFromPlan({})).toEqual([])
  })

  it("merges modify and create paths", () => {
    const plan = {
      affected_files: {
        modify: ["a.ts"],
        create: ["b.ts"],
        delete: ["c.ts"],
      },
    }
    expect(collectAffectedPathsFromPlan(plan)).toEqual(["a.ts", "b.ts"])
  })

  it("accepts affected_files as a flat path list", () => {
    const plan = { affected_files: ["packages/verify/src/dynamic.ts"] }
    expect(collectAffectedPathsFromPlan(plan)).toEqual(["packages/verify/src/dynamic.ts"])
  })
})
