import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { describe, expect, it } from "vitest"
import { deriveAdversarialTestPath, stripMarkdownFences } from "../src/write-tests-helpers.js"

const makeProfile = (language: string): ToolchainProfile => ({
  language: language as ToolchainProfile["language"],
  checks: {},
  sourcePatterns: [],
  testPatterns: [],
  ignorePatterns: [],
  allowedCommands: [],
  adversarial: { mode: "blackbox" },
})

describe("deriveAdversarialTestPath", () => {
  it("maps src/ to tests/ for TypeScript files (no profile)", () => {
    expect(deriveAdversarialTestPath("packages/cli/src/index.ts")).toBe(
      "packages/cli/tests/index.adversarial.test.ts",
    )
  })

  it("maps src/ to tests/ for .py extension without profile (uses TS behavior)", () => {
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

  it("TypeScript profile produces .adversarial.test.ts", () => {
    expect(deriveAdversarialTestPath("packages/cli/src/index.ts", makeProfile("typescript"))).toBe(
      "packages/cli/tests/index.adversarial.test.ts",
    )
  })

  it("Python profile: src/auth.py -> tests/test_adversarial_auth.py", () => {
    expect(deriveAdversarialTestPath("src/auth.py", makeProfile("python"))).toBe(
      "tests/test_adversarial_auth.py",
    )
  })

  it("Python profile: nested path", () => {
    expect(deriveAdversarialTestPath("pkg/src/utils.py", makeProfile("python"))).toBe(
      "pkg/tests/test_adversarial_utils.py",
    )
  })

  it("Go profile: pkg/auth.go -> pkg/auth_adversarial_test.go (alongside source)", () => {
    expect(deriveAdversarialTestPath("pkg/auth.go", makeProfile("go"))).toBe(
      "pkg/auth_adversarial_test.go",
    )
  })

  it("Go profile: src/handler.go stays alongside", () => {
    expect(deriveAdversarialTestPath("src/handler.go", makeProfile("go"))).toBe(
      "src/handler_adversarial_test.go",
    )
  })

  it("Rust profile: src/auth.rs -> tests/auth_adversarial_test.rs", () => {
    expect(deriveAdversarialTestPath("src/auth.rs", makeProfile("rust"))).toBe(
      "tests/auth_adversarial_test.rs",
    )
  })

  it("Rust profile: lib/parser.rs (no src/) stays in same dir", () => {
    expect(deriveAdversarialTestPath("lib/parser.rs", makeProfile("rust"))).toBe(
      "lib/parser_adversarial_test.rs",
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

  it("strips python fences", () => {
    expect(stripMarkdownFences("```python\nimport pytest\n```")).toBe("import pytest")
  })

  it("strips go fences", () => {
    expect(stripMarkdownFences("```go\npackage main\n```")).toBe("package main")
  })

  it("strips rust fences", () => {
    expect(stripMarkdownFences("```rust\nuse super::*;\n```")).toBe("use super::*;")
  })
})
