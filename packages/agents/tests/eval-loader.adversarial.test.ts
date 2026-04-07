import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import { loadEvalCases, availableAgents } from "../src/eval-loader.js"

describe("Feature: loadEvalCases returns all cases when no filter or invalid filter", () => {
  it("should return all cases when agentFilter is undefined", () => {
    const cases = loadEvalCases()
    expect(cases).toBeInstanceOf(Array)
    expect(cases.length).toBeGreaterThan(0)
    expect(cases.every(c => c && typeof c === 'object')).toBe(true)
  })

  it("should return all cases when agentFilter is empty string", () => {
    const cases = loadEvalCases("")
    expect(cases).toBeInstanceOf(Array)
    expect(cases.length).toBeGreaterThan(0)
    expect(cases.every(c => c && typeof c === 'object')).toBe(true)
  })

  it("should return all cases when agentFilter is invalid agent name", () => {
    const cases = loadEvalCases("nonexistent")
    expect(cases).toBeInstanceOf(Array)
    expect(cases.length).toBeGreaterThan(0)
    expect(cases.every(c => c && typeof c === 'object')).toBe(true)
  })

  it("should return same number of cases for undefined and invalid filters", () => {
    const undefinedCases = loadEvalCases()
    const emptyCases = loadEvalCases("")
    const invalidCases = loadEvalCases("invalid")
    
    expect(undefinedCases.length).toBe(emptyCases.length)
    expect(emptyCases.length).toBe(invalidCases.length)
  })
})

describe("Feature: loadEvalCases filters by exact agent name match", () => {
  it("should return filtered cases for planner agent", () => {
    const cases = loadEvalCases("planner")
    expect(cases).toBeInstanceOf(Array)
    expect(cases.length).toBeGreaterThan(0)
    expect(cases.every(c => c && typeof c === 'object')).toBe(true)
  })

  it("should return filtered cases for coder agent", () => {
    const cases = loadEvalCases("coder")
    expect(cases).toBeInstanceOf(Array)
    expect(cases.length).toBeGreaterThan(0)
    expect(cases.every(c => c && typeof c === 'object')).toBe(true)
  })

  it("should return filtered cases for tester agent", () => {
    const cases = loadEvalCases("tester")
    expect(cases).toBeInstanceOf(Array)
    expect(cases.length).toBeGreaterThan(0)
    expect(cases.every(c => c && typeof c === 'object')).toBe(true)
  })

  it("should return fewer cases when filtering than when not filtering", () => {
    const allCases = loadEvalCases()
    const plannerCases = loadEvalCases("planner")
    const coderCases = loadEvalCases("coder")
    const testerCases = loadEvalCases("tester")
    const contractCases = loadEvalCases("contract-tester")

    expect(plannerCases.length).toBeLessThan(allCases.length)
    expect(coderCases.length).toBeLessThan(allCases.length)
    expect(testerCases.length).toBeLessThan(allCases.length)
    expect(contractCases.length).toBeLessThan(allCases.length)
  })

  it("should return different cases for different agents", () => {
    const plannerCases = loadEvalCases("planner")
    const coderCases = loadEvalCases("coder")
    const contractCases = loadEvalCases("contract-tester")

    expect(plannerCases).not.toEqual(coderCases)
    expect(coderCases).not.toEqual(contractCases)
    expect(contractCases).not.toEqual(plannerCases)
  })
})

describe("Feature: availableAgents returns known agent list", () => {
  it("should return planner, coder, boundary-tester, contract-tester, tester (sorted)", () => {
    const agents = availableAgents()
    expect(agents).toEqual(["boundary-tester", "coder", "contract-tester", "planner", "tester"])
  })

  it("should return array with length 5", () => {
    const agents = availableAgents()
    expect(agents).toHaveLength(5)
  })

  it("should return consistent results across calls", () => {
    const agents1 = availableAgents()
    const agents2 = availableAgents()
    expect(agents1).toEqual(agents2)
  })
})

describe("Property-based tests: loadEvalCases with arbitrary strings", () => {
  it("should handle arbitrary string filters consistently", () => {
    fc.assert(fc.property(
      fc.string(),
      (filter) => {
        const cases = loadEvalCases(filter)
        expect(cases).toBeInstanceOf(Array)
        expect(cases.every(c => c && typeof c === 'object')).toBe(true)
        
        // Should return all cases unless exact match with known agent
        const allCases = loadEvalCases()
        if (!["planner", "coder", "tester", "boundary-tester", "contract-tester"].includes(filter)) {
          expect(cases.length).toBe(allCases.length)
        }
      }
    ))
  })

  it("should return consistent results for same filter", () => {
    fc.assert(fc.property(
      fc.string(),
      (filter) => {
        const cases1 = loadEvalCases(filter)
        const cases2 = loadEvalCases(filter)
        expect(cases1).toEqual(cases2)
      }
    ))
  })
})

describe("Negative tests: edge cases and boundary values", () => {
  it("should handle whitespace-only filter", () => {
    const cases = loadEvalCases("   ")
    const allCases = loadEvalCases()
    expect(cases.length).toBe(allCases.length)
  })

  it("should handle case-sensitive filtering", () => {
    const upperCases = loadEvalCases("PLANNER")
    const lowerCases = loadEvalCases("planner")
    const allCases = loadEvalCases()
    
    expect(upperCases.length).toBe(allCases.length) // No match, returns all
    expect(lowerCases.length).toBeLessThan(allCases.length) // Exact match, filters
  })

  it("should handle partial agent name matches", () => {
    const partialCases = loadEvalCases("plan")
    const allCases = loadEvalCases()
    expect(partialCases.length).toBe(allCases.length) // No exact match, returns all
  })

  it("should handle agent name with extra characters", () => {
    const extraCases = loadEvalCases("planner-extra")
    const allCases = loadEvalCases()
    expect(extraCases.length).toBe(allCases.length) // No exact match, returns all
  })

  it("should handle numeric string filters", () => {
    const numericCases = loadEvalCases("123")
    const allCases = loadEvalCases()
    expect(numericCases.length).toBe(allCases.length)
  })

  it("should handle special character filters", () => {
    const specialCases = loadEvalCases("@#$%")
    const allCases = loadEvalCases()
    expect(specialCases.length).toBe(allCases.length)
  })
})