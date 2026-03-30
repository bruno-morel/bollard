import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
import { loadEvalCases, availableAgents } from "../src/eval-loader.js"

describe("Feature: loadEvalCases returns all cases when no filter or invalid filter", () => {
  it("should return all cases when agentFilter is undefined", () => {
    const cases = loadEvalCases()
    expect(cases).toBeInstanceOf(Array)
    expect(cases.length).toBeGreaterThan(0)
    expect(cases.every(c => typeof c === 'object' && c !== null)).toBe(true)
  })

  it("should return all cases when agentFilter is empty string", () => {
    const cases = loadEvalCases("")
    expect(cases).toBeInstanceOf(Array)
    expect(cases.length).toBeGreaterThan(0)
    expect(cases.every(c => typeof c === 'object' && c !== null)).toBe(true)
  })

  it("should return all cases when agentFilter is unrecognized agent name", () => {
    const cases = loadEvalCases("nonexistent")
    expect(cases).toBeInstanceOf(Array)
    expect(cases.length).toBeGreaterThan(0)
    expect(cases.every(c => typeof c === 'object' && c !== null)).toBe(true)
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
    expect(cases.every(c => typeof c === 'object' && c !== null)).toBe(true)
  })

  it("should return filtered cases for coder agent", () => {
    const cases = loadEvalCases("coder")
    expect(cases).toBeInstanceOf(Array)
    expect(cases.every(c => typeof c === 'object' && c !== null)).toBe(true)
  })

  it("should return filtered cases for tester agent", () => {
    const cases = loadEvalCases("tester")
    expect(cases).toBeInstanceOf(Array)
    expect(cases.every(c => typeof c === 'object' && c !== null)).toBe(true)
  })

  it("should return fewer cases when filtering than when not filtering", () => {
    const allCases = loadEvalCases()
    const plannerCases = loadEvalCases("planner")
    const coderCases = loadEvalCases("coder")
    const testerCases = loadEvalCases("tester")
    
    expect(plannerCases.length).toBeLessThanOrEqual(allCases.length)
    expect(coderCases.length).toBeLessThanOrEqual(allCases.length)
    expect(testerCases.length).toBeLessThanOrEqual(allCases.length)
  })

  it("should not filter on partial matches", () => {
    const allCases = loadEvalCases()
    const partialMatch = loadEvalCases("plan")
    
    expect(partialMatch.length).toBe(allCases.length)
  })

  it("should be case sensitive", () => {
    const allCases = loadEvalCases()
    const upperCase = loadEvalCases("PLANNER")
    const mixedCase = loadEvalCases("Planner")
    
    expect(upperCase.length).toBe(allCases.length)
    expect(mixedCase.length).toBe(allCases.length)
  })
})

describe("Feature: availableAgents returns known agent list", () => {
  it("should return array of exactly three agents", () => {
    const agents = availableAgents()
    expect(agents).toEqual(["planner", "coder", "tester"])
  })

  it("should return consistent results on multiple calls", () => {
    const agents1 = availableAgents()
    const agents2 = availableAgents()
    expect(agents1).toEqual(agents2)
  })

  it("should return array with string elements", () => {
    const agents = availableAgents()
    expect(agents.every(agent => typeof agent === 'string')).toBe(true)
  })
})

describe("Property-based tests: loadEvalCases with arbitrary strings", () => {
  it("should handle arbitrary string filters without throwing", () => {
    fc.assert(fc.property(
      fc.string(),
      (filter) => {
        const cases = loadEvalCases(filter)
        expect(cases).toBeInstanceOf(Array)
        expect(cases.every(c => typeof c === 'object' && c !== null)).toBe(true)
      }
    ))
  })

  it("should return consistent results for same filter", () => {
    fc.assert(fc.property(
      fc.string(),
      (filter) => {
        const cases1 = loadEvalCases(filter)
        const cases2 = loadEvalCases(filter)
        expect(cases1.length).toBe(cases2.length)
      }
    ))
  })

  it("should return all cases for any non-exact agent name", () => {
    const allCases = loadEvalCases()
    const validAgents = new Set(["planner", "coder", "tester"])
    
    fc.assert(fc.property(
      fc.string().filter(s => !validAgents.has(s)),
      (invalidFilter) => {
        const cases = loadEvalCases(invalidFilter)
        expect(cases.length).toBe(allCases.length)
      }
    ))
  })
})

describe("Negative tests: edge cases and boundary values", () => {
  it("should handle whitespace-only strings as invalid filters", () => {
    const allCases = loadEvalCases()
    const whitespaceCases = loadEvalCases("   ")
    const tabCases = loadEvalCases("\t")
    const newlineCases = loadEvalCases("\n")
    
    expect(whitespaceCases.length).toBe(allCases.length)
    expect(tabCases.length).toBe(allCases.length)
    expect(newlineCases.length).toBe(allCases.length)
  })

  it("should handle special characters as invalid filters", () => {
    const allCases = loadEvalCases()
    const specialChars = ["@", "#", "$", "%", "^", "&", "*", "(", ")", "-", "+", "="]
    
    specialChars.forEach(char => {
      const cases = loadEvalCases(char)
      expect(cases.length).toBe(allCases.length)
    })
  })

  it("should handle very long strings as invalid filters", () => {
    const allCases = loadEvalCases()
    const longString = "a".repeat(10000)
    const longCases = loadEvalCases(longString)
    
    expect(longCases.length).toBe(allCases.length)
  })

  it("should handle unicode characters as invalid filters", () => {
    const allCases = loadEvalCases()
    const unicodeCases = loadEvalCases("🚀")
    const emojiCases = loadEvalCases("👨‍💻")
    
    expect(unicodeCases.length).toBe(allCases.length)
    expect(emojiCases.length).toBe(allCases.length)
  })
})