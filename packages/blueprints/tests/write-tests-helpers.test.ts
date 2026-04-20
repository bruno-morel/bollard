import { join } from "node:path"
import { defaultAdversarialConfig } from "@bollard/detect/src/concerns.js"
import type { LanguageId, ToolchainProfile } from "@bollard/detect/src/types.js"
import type { ContractContext } from "@bollard/verify/src/contract-extractor.js"
import { describe, expect, it } from "vitest"
import {
  deriveAdversarialTestPath,
  jvmContractCoerceVitestItToJUnit5,
  normalizeJvmWrittenTestClassName,
  resolveContractTestModulePrefix,
  sanitizeJavaPrimitiveInstanceofMisuse,
  stripMarkdownFences,
} from "../src/write-tests-helpers.js"

const makeProfile = (language: string): ToolchainProfile => ({
  language: language as ToolchainProfile["language"],
  checks: {},
  sourcePatterns: [],
  testPatterns: [],
  ignorePatterns: [],
  allowedCommands: [],
  adversarial: defaultAdversarialConfig({
    language: language as ToolchainProfile["language"],
  }),
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

  it("contract scope TypeScript: maps src/ to tests/contracts/", () => {
    expect(
      deriveAdversarialTestPath("packages/cli/src/index.ts", makeProfile("typescript"), "contract"),
    ).toBe("packages/cli/tests/contracts/index.contract.test.ts")
  })

  it("contract scope Python: uses tests/contracts/ and test_*_contract.py", () => {
    expect(deriveAdversarialTestPath("src/auth.py", makeProfile("python"), "contract")).toBe(
      "tests/contracts/test_auth_contract.py",
    )
  })

  it("contract scope Go: _contract_test.go suffix", () => {
    expect(deriveAdversarialTestPath("pkg/handler.go", makeProfile("go"), "contract")).toBe(
      "pkg/handler_contract_test.go",
    )
  })

  it("behavioral scope TypeScript: maps src/ to tests/behavioral/", () => {
    expect(
      deriveAdversarialTestPath(
        "packages/cli/src/index.ts",
        makeProfile("typescript"),
        "behavioral",
      ),
    ).toBe("packages/cli/tests/behavioral/index.behavioral.test.ts")
  })

  it("behavioral scope Python: tests/behavioral/test_behavioral_*.py", () => {
    expect(deriveAdversarialTestPath("src/auth.py", makeProfile("python"), "behavioral")).toBe(
      "tests/behavioral/test_behavioral_auth.py",
    )
  })

  it("behavioral scope Go: _behavioral_test suffix", () => {
    expect(deriveAdversarialTestPath("pkg/handler.go", makeProfile("go"), "behavioral")).toBe(
      "pkg/handler_behavioral_test.go",
    )
  })

  it("Java boundary: mirrors package under src/test/java with AdversarialTest suffix", () => {
    expect(
      deriveAdversarialTestPath("src/main/java/com/example/Foo.java", makeProfile("java")),
    ).toBe(join("src/test/java/com/example", "FooAdversarialTest.java"))
  })

  it("Java contract: FooContractTest.java under src/test/java", () => {
    expect(
      deriveAdversarialTestPath(
        "src/main/java/com/example/Foo.java",
        makeProfile("java"),
        "contract",
      ),
    ).toBe(join("src/test/java/com/example", "FooContractTest.java"))
  })

  it("Java behavioral: FooBehavioralTest.java under src/test/java", () => {
    expect(
      deriveAdversarialTestPath(
        "src/main/java/com/example/Foo.java",
        makeProfile("java"),
        "behavioral",
      ),
    ).toBe(join("src/test/java/com/example", "FooBehavioralTest.java"))
  })

  it("Java multi-module: preserves module dir before src/test (Maven/Gradle)", () => {
    const base = "core/src/main/java/com/example/core/Calculator.java"
    expect(deriveAdversarialTestPath(base, makeProfile("java"))).toBe(
      join("core/src/test/java/com/example/core", "CalculatorAdversarialTest.java"),
    )
    expect(deriveAdversarialTestPath(base, makeProfile("java"), "contract")).toBe(
      join("core/src/test/java/com/example/core", "CalculatorContractTest.java"),
    )
    expect(deriveAdversarialTestPath(base, makeProfile("java"), "behavioral")).toBe(
      join("core/src/test/java/com/example/core", "CalculatorBehavioralTest.java"),
    )
  })

  it("Kotlin boundary: mirrors package under src/test/kotlin with AdversarialTest suffix", () => {
    expect(
      deriveAdversarialTestPath("src/main/kotlin/com/example/Bar.kt", makeProfile("kotlin")),
    ).toBe(join("src/test/kotlin/com/example", "BarAdversarialTest.kt"))
  })

  it("Kotlin contract and behavioral under src/test/kotlin", () => {
    expect(
      deriveAdversarialTestPath("src/main/kotlin/x/Y.kt", makeProfile("kotlin"), "contract"),
    ).toBe(join("src/test/kotlin/x", "YContractTest.kt"))
    expect(
      deriveAdversarialTestPath("src/main/kotlin/x/Y.kt", makeProfile("kotlin"), "behavioral"),
    ).toBe(join("src/test/kotlin/x", "YBehavioralTest.kt"))
  })
})

describe("resolveContractTestModulePrefix", () => {
  const makeContract = (edges: Array<{ from: string; to: string }>): ContractContext => ({
    modules: [],
    edges: [],
    affectedEdges: edges.map((e) => ({
      from: e.from,
      to: e.to,
      importedSymbols: [],
      providerErrors: [],
      consumerCatches: [],
    })),
  })

  it("rewrites module prefix to consumer for Java cross-module edge", () => {
    const src = "core/src/main/java/com/example/core/Calculator.java"
    const contract = makeContract([{ from: "api", to: "core" }])
    expect(resolveContractTestModulePrefix(src, contract, "java")).toBe(
      "api/src/main/java/com/example/core/Calculator.java",
    )
  })

  it("rewrites module prefix to consumer for Kotlin cross-module edge", () => {
    const src = "core/src/main/kotlin/com/example/core/Calc.kt"
    const contract = makeContract([{ from: "api", to: "core" }])
    expect(resolveContractTestModulePrefix(src, contract, "kotlin")).toBe(
      "api/src/main/kotlin/com/example/core/Calc.kt",
    )
  })

  it("returns original path when no affected edges (single-module)", () => {
    const src = "src/main/java/com/example/Foo.java"
    const contract = makeContract([])
    expect(resolveContractTestModulePrefix(src, contract, "java")).toBe(src)
  })

  it("returns original path when contract context is undefined", () => {
    const src = "core/src/main/java/com/example/core/Calculator.java"
    expect(resolveContractTestModulePrefix(src, undefined, "java")).toBe(src)
  })

  it("returns original path for non-JVM languages (no-op)", () => {
    const src = "packages/api/src/index.ts"
    const contract = makeContract([{ from: "consumer", to: "provider" }])
    for (const lang of ["typescript", "python", "go", "rust"] as LanguageId[]) {
      expect(resolveContractTestModulePrefix(src, contract, lang)).toBe(src)
    }
  })

  it("returns original path when provider already equals consumer", () => {
    const src = "api/src/main/java/com/example/api/Facade.java"
    const contract = makeContract([{ from: "api", to: "api" }])
    expect(resolveContractTestModulePrefix(src, contract, "java")).toBe(src)
  })

  it("returns original path when the source lacks src/main/<lang>/ layout", () => {
    const src = "lib/Foo.java"
    const contract = makeContract([{ from: "api", to: "core" }])
    expect(resolveContractTestModulePrefix(src, contract, "java")).toBe(src)
  })

  it("supports nested Gradle-style module ids (foo/bar)", () => {
    const src = "core/src/main/java/com/example/core/Calculator.java"
    const contract = makeContract([{ from: "apps/api", to: "core" }])
    expect(resolveContractTestModulePrefix(src, contract, "java")).toBe(
      "apps/api/src/main/java/com/example/core/Calculator.java",
    )
  })
})

describe("jvmContractCoerceVitestItToJUnit5", () => {
  it("unwraps Vitest it() blocks into @Test methods", () => {
    const src = `it('delegates', () -> {
  assertEquals(1.0, 1.0);
})`
    const out = jvmContractCoerceVitestItToJUnit5(src)
    expect(out).toContain("@Test")
    expect(out).toContain("void contractClaim_0()")
    expect(out).toContain("assertEquals(1.0, 1.0)")
    expect(out).not.toContain("it('")
  })
})

describe("sanitizeJavaPrimitiveInstanceofMisuse", () => {
  it("rewrites invalid primitive double instanceof Double assertions", () => {
    const bad = "Assertions.assertTrue(result instanceof Double || result == (double) result);"
    expect(sanitizeJavaPrimitiveInstanceofMisuse(bad)).toBe(
      "Assertions.assertTrue(Double.isFinite(result));",
    )
  })
})

describe("normalizeJvmWrittenTestClassName", () => {
  it("renames first Java class to match AdversarialTest filename", () => {
    const src = `import org.junit.jupiter.api.Test;

class CalculatorTest {
  @Test void t() {}
}`
    expect(normalizeJvmWrittenTestClassName(src, "CalculatorAdversarialTest", "java")).toBe(
      `import org.junit.jupiter.api.Test;

public class CalculatorAdversarialTest {
  @Test void t() {}
}`,
    )
  })

  it("leaves Java class unchanged when already correct", () => {
    const src = "public class CalculatorAdversarialTest {\n}\n"
    expect(normalizeJvmWrittenTestClassName(src, "CalculatorAdversarialTest", "java")).toBe(src)
  })

  it("renames first Kotlin class to match AdversarialTest filename", () => {
    const src = "class FooTest {\n}\n"
    expect(normalizeJvmWrittenTestClassName(src, "FooAdversarialTest", "kotlin")).toBe(
      "class FooAdversarialTest {\n}\n",
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
