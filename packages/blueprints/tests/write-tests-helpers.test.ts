import { describe, expect, it } from "vitest"
import { deriveAdversarialTestPath, stripMarkdownFences } from "../src/write-tests-helpers.js"

describe("deriveAdversarialTestPath", () => {
  it("maps src/ to tests/ for TypeScript files", () => {
    expect(deriveAdversarialTestPath("packages/cli/src/index.ts")).toBe(
      "packages/cli/tests/index.adversarial.test.ts",
    )
  })

  it("maps src/ to tests/ for Python files", () => {
    expect(deriveAdversarialTestPath("src/main.py")).toBe("tests/main.adversarial.test.py")
  })

  it("places adjacent when no src/ directory", () => {
    expect(deriveAdversarialTestPath("lib/utils.ts")).toBe("lib/utils.adversarial.test.ts")
  })

  it("handles nested src/ paths", () => {
    expect(deriveAdversarialTestPath("packages/verify/src/deep/nested.ts")).toBe(
      "packages/verify/tests/deep/nested.adversarial.test.ts",
    )
  })
})

describe("stripMarkdownFences", () => {
  it("strips typescript fences", () => {
    expect(stripMarkdownFences("```typescript\nconst x = 1\n```")).toBe("const x = 1")
  })

  it("strips ts fences", () => {
    expect(stripMarkdownFences("```ts\nconst x = 1\n```")).toBe("const x = 1")
  })

  it("returns clean content unchanged", () => {
    expect(stripMarkdownFences("const x = 1")).toBe("const x = 1")
  })

  it("strips only opening fence", () => {
    expect(stripMarkdownFences("```typescript\nconst x = 1")).toBe("const x = 1")
  })

  it("strips only closing fence", () => {
    expect(stripMarkdownFences("const x = 1\n```")).toBe("const x = 1")
  })

  it("handles whitespace around fences", () => {
    expect(stripMarkdownFences("  ```python\ncode\n```  ")).toBe("code")
  })

  it("strips fences with no language tag", () => {
    expect(stripMarkdownFences("```\ncode\n```")).toBe("code")
  })
})
