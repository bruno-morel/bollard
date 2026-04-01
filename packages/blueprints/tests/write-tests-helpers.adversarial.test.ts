import { describe, expect, it } from "vitest"
import { deriveAdversarialTestPath, stripMarkdownFences } from "../src/write-tests-helpers.js"

describe("deriveAdversarialTestPath adversarial edge cases", () => {
  it("replaces only the first /src/ in a double-src path", () => {
    const result = deriveAdversarialTestPath("packages/src/src/foo.ts")
    expect(result).toBe("packages/tests/src/foo.adversarial.test.ts")
  })

  it("handles a file with no extension", () => {
    const result = deriveAdversarialTestPath("src/Makefile")
    expect(result).toBe("tests/Makefile")
  })

  it("handles Windows-style backslash paths without crashing", () => {
    const result = deriveAdversarialTestPath("src\\foo.ts")
    expect(typeof result).toBe("string")
    expect(result).toContain(".adversarial.test.ts")
  })
})

describe("stripMarkdownFences adversarial edge cases", () => {
  it("preserves inner backtick sequences while stripping outer fences", () => {
    const input = "```typescript\nconst x = \"```\"\n```"
    const result = stripMarkdownFences(input)
    expect(result).toBe("const x = \"```\"")
  })

  it("strips only the first opening fence when output has multiple code blocks", () => {
    const input = "```typescript\nblock one\n```\n\n```typescript\nblock two\n```"
    const result = stripMarkdownFences(input)
    expect(result).toContain("block one")
    expect(result).toContain("block two")
    expect(result).not.toMatch(/^```/)
    expect(result).not.toMatch(/```\s*$/)
  })
})
