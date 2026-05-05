import { basename, dirname, extname, join } from "node:path"
import type { AdversarialScope, LanguageId, ToolchainProfile } from "@bollard/detect/src/types.js"
import type { ContractContext } from "@bollard/verify/src/contract-extractor.js"

function deriveTypescriptTestPath(sourceFile: string): string {
  const ext = extname(sourceFile)
  const hasSrcDir = sourceFile.includes("/src/") || sourceFile.startsWith("src/")
  if (hasSrcDir) {
    return sourceFile
      .replace(/(^|\/)src\//, "$1tests/")
      .replace(new RegExp(`\\${ext}$`), `.adversarial.test${ext}`)
  }
  return sourceFile.replace(new RegExp(`\\${ext}$`), `.adversarial.test${ext}`)
}

function deriveTypescriptContractPath(sourceFile: string): string {
  const ext = extname(sourceFile)
  const base = basename(sourceFile, ext)
  const hasSrcDir = sourceFile.includes("/src/") || sourceFile.startsWith("src/")
  if (hasSrcDir) {
    return sourceFile
      .replace(/(^|\/)src\//, "$1tests/contracts/")
      .replace(new RegExp(`\\${ext}$`), `.contract.test${ext}`)
  }
  return join(dirname(sourceFile), "tests/contracts", `${base}.contract.test${ext}`)
}

function derivePythonTestPath(sourceFile: string): string {
  const dir = dirname(sourceFile)
  const base = basename(sourceFile, ".py")
  const hasSrcDir = sourceFile.includes("/src/") || sourceFile.startsWith("src/")
  const targetDir = hasSrcDir ? dir.replace(/(^|\/)src(\/|$)/, "$1tests$2") : dir
  return join(targetDir, `test_adversarial_${base}.py`)
}

function derivePythonContractPath(sourceFile: string): string {
  const dir = dirname(sourceFile)
  const base = basename(sourceFile, ".py")
  const hasSrcDir = sourceFile.includes("/src/") || sourceFile.startsWith("src/")
  const targetDir = hasSrcDir
    ? dir.replace(/(^|\/)src(\/|$)/, "$1tests/contracts$2")
    : join(dir, "tests/contracts")
  return join(targetDir, `test_${base}_contract.py`)
}

function deriveGoTestPath(sourceFile: string): string {
  const ext = extname(sourceFile)
  return sourceFile.replace(new RegExp(`\\${ext}$`), `_adversarial_test${ext}`)
}

function deriveGoContractPath(sourceFile: string): string {
  const ext = extname(sourceFile)
  return sourceFile.replace(new RegExp(`\\${ext}$`), `_contract_test${ext}`)
}

function deriveRustTestPath(sourceFile: string): string {
  const dir = dirname(sourceFile)
  const base = basename(sourceFile, ".rs")
  const hasSrcDir = sourceFile.includes("/src/") || sourceFile.startsWith("src/")
  const targetDir = hasSrcDir ? dir.replace(/(^|\/)src(\/|$)/, "$1tests$2") : dir
  return join(targetDir, `${base}_adversarial_test.rs`)
}

function deriveRustContractPath(sourceFile: string): string {
  const dir = dirname(sourceFile)
  const base = basename(sourceFile, ".rs")
  const hasSrcDir = sourceFile.includes("/src/") || sourceFile.startsWith("src/")
  const targetDir = hasSrcDir
    ? dir.replace(/(^|\/)src(\/|$)/, "$1tests/contracts$2")
    : join(dir, "tests/contracts")
  return join(targetDir, `${base}_contract.rs`)
}

function deriveTypescriptBehavioralPath(sourceFile: string): string {
  const ext = extname(sourceFile)
  const base = basename(sourceFile, ext)
  const hasSrcDir = sourceFile.includes("/src/") || sourceFile.startsWith("src/")
  if (hasSrcDir) {
    return sourceFile
      .replace(/(^|\/)src\//, "$1tests/behavioral/")
      .replace(new RegExp(`\\${ext}$`), `.behavioral.test${ext}`)
  }
  return join(dirname(sourceFile), "tests/behavioral", `${base}.behavioral.test${ext}`)
}

function derivePythonBehavioralPath(sourceFile: string): string {
  const dir = dirname(sourceFile)
  const base = basename(sourceFile, ".py")
  const hasSrcDir = sourceFile.includes("/src/") || sourceFile.startsWith("src/")
  const targetDir = hasSrcDir
    ? dir.replace(/(^|\/)src(\/|$)/, "$1tests/behavioral$2")
    : join(dir, "tests/behavioral")
  return join(targetDir, `test_behavioral_${base}.py`)
}

function deriveGoBehavioralPath(sourceFile: string): string {
  const ext = extname(sourceFile)
  return sourceFile.replace(new RegExp(`\\${ext}$`), `_behavioral_test${ext}`)
}

function deriveRustBehavioralPath(sourceFile: string): string {
  const dir = dirname(sourceFile)
  const base = basename(sourceFile, ".rs")
  const hasSrcDir = sourceFile.includes("/src/") || sourceFile.startsWith("src/")
  const targetDir = hasSrcDir
    ? dir.replace(/(^|\/)src(\/|$)/, "$1tests/behavioral$2")
    : join(dir, "tests/behavioral")
  return join(targetDir, `${base}_behavioral.rs`)
}

/** Maven/Gradle expect tests under `src/test/java` or `src/test/kotlin` mirroring main packages. */
function deriveJavaLikeTestPath(sourceFile: string, ext: "java" | "kt", suffix: string): string {
  const mainMarker = ext === "java" ? "src/main/java/" : "src/main/kotlin/"
  const norm = sourceFile.replace(/\\/g, "/")
  const idx = norm.indexOf(mainMarker)
  if (idx >= 0) {
    /** e.g. `core/` for `core/src/main/java/...` multi-module layouts */
    const modulePrefix = sourceFile.slice(0, idx).replace(/\\/g, "/")
    const afterMain = sourceFile.slice(idx + mainMarker.length)
    const pkgDir = dirname(afterMain)
    const base = basename(sourceFile, `.${ext}`)
    const testRoot = ext === "java" ? "src/test/java" : "src/test/kotlin"
    return join(modulePrefix, testRoot, pkgDir, `${base}${suffix}.${ext}`)
  }
  const base = basename(sourceFile, `.${ext}`)
  return join(ext === "java" ? "src/test/java" : "src/test/kotlin", `${base}${suffix}.${ext}`)
}

/** Use `AdversarialTest` (not `Test`) so we do not overwrite existing `*Test.java` unit files. */
function deriveJavaLikeBoundaryPath(sourceFile: string, ext: "java" | "kt"): string {
  return deriveJavaLikeTestPath(sourceFile, ext, "AdversarialTest")
}

function deriveJavaLikeContractPath(sourceFile: string, ext: "java" | "kt"): string {
  return deriveJavaLikeTestPath(sourceFile, ext, "ContractTest")
}

function deriveJavaLikeBehavioralPath(sourceFile: string, ext: "java" | "kt"): string {
  return deriveJavaLikeTestPath(sourceFile, ext, "BehavioralTest")
}

/** Package name for a `src/main/java/.../Class.java` or `src/main/kotlin/.../Class.kt` path. */
export function inferJvmPackageFromMainSource(sourceFile: string): string | null {
  const n = sourceFile.replace(/\\/g, "/")
  const mj = n.match(/src\/main\/java\/(.+)\.java$/)
  if (mj?.[1]) {
    const parts = mj[1].split("/")
    parts.pop()
    return parts.length > 0 ? parts.join(".") : null
  }
  const mk = n.match(/src\/main\/kotlin\/(.+)\.kt$/)
  if (mk?.[1]) {
    const parts = mk[1].split("/")
    parts.pop()
    return parts.length > 0 ? parts.join(".") : null
  }
  return null
}

/**
 * When a JVM contract test covers a cross-module edge, the test must be placed in the
 * **consumer** module (the one that imports the provider), not the provider module — otherwise
 * the generated test file cannot compile against imports from the consumer side.
 *
 * `deriveJavaLikeTestPath` extracts the module prefix from the substring *before* `src/main/*`,
 * so this helper rewrites that prefix to point at the consumer module while keeping the package
 * path (`src/main/<lang>/<pkg>/Foo.<ext>`) intact. Single-module projects, non-JVM languages,
 * or cases with no cross-module edges are returned unchanged.
 */
export function resolveContractTestModulePrefix(
  sourceFile: string,
  contract: ContractContext | undefined,
  lang: LanguageId,
): string {
  if (lang !== "java" && lang !== "kotlin") return sourceFile
  if (!contract || contract.affectedEdges.length === 0) return sourceFile

  const consumerId = contract.affectedEdges[0]?.from
  if (!consumerId || consumerId === "." || consumerId === "") return sourceFile

  const mainMarker = lang === "java" ? "src/main/java/" : "src/main/kotlin/"
  const norm = sourceFile.replace(/\\/g, "/")
  const idx = norm.indexOf(mainMarker)
  if (idx < 0) return sourceFile

  const providerId = norm.slice(0, idx).replace(/\/$/, "")
  if (providerId === consumerId) return sourceFile

  const afterPrefix = norm.slice(idx)
  return `${consumerId}/${afterPrefix}`
}

export function deriveAdversarialTestPath(
  sourceFile: string,
  profile?: ToolchainProfile,
  scope: AdversarialScope = "boundary",
): string {
  const lang = profile?.language ?? "typescript"

  if (scope === "behavioral") {
    switch (lang) {
      case "python":
        return derivePythonBehavioralPath(sourceFile)
      case "go":
        return deriveGoBehavioralPath(sourceFile)
      case "rust":
        return deriveRustBehavioralPath(sourceFile)
      case "java":
        return deriveJavaLikeBehavioralPath(sourceFile, "java")
      case "kotlin":
        return deriveJavaLikeBehavioralPath(sourceFile, "kt")
      default:
        return deriveTypescriptBehavioralPath(sourceFile)
    }
  }

  if (scope === "contract") {
    switch (lang) {
      case "python":
        return derivePythonContractPath(sourceFile)
      case "go":
        return deriveGoContractPath(sourceFile)
      case "rust":
        return deriveRustContractPath(sourceFile)
      case "java":
        return deriveJavaLikeContractPath(sourceFile, "java")
      case "kotlin":
        return deriveJavaLikeContractPath(sourceFile, "kt")
      default:
        return deriveTypescriptContractPath(sourceFile)
    }
  }

  switch (lang) {
    case "python":
      return derivePythonTestPath(sourceFile)
    case "go":
      return deriveGoTestPath(sourceFile)
    case "rust":
      return deriveRustTestPath(sourceFile)
    case "java":
      return deriveJavaLikeBoundaryPath(sourceFile, "java")
    case "kotlin":
      return deriveJavaLikeBoundaryPath(sourceFile, "kt")
    default:
      return deriveTypescriptTestPath(sourceFile)
  }
}

export function stripMarkdownFences(output: string): string {
  let result = output.trim()
  result = result.replace(/^```\w*\n/, "")
  result = result.replace(/\n```\s*$/, "")
  return result
}

/**
 * Boundary tests for Java/Kotlin are written to `<Base>AdversarialTest.{java,kt}` but the LLM
 * often emits `class FooTest` matching the production class. Rename the first top-level class
 * so it matches the filename (Java requires the public class name to match the file).
 */

function findMatchingBrace(s: string, openIdx: number): number {
  let depth = 0
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i]
    if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Contract-tester sometimes emits Vitest `it('title', () -> { ... })` inside a Java class.
 * Unwrap each block into a JUnit 5 `@Test` method (body keeps Java-compatible assertions).
 */
export function jvmContractCoerceVitestItToJUnit5(s: string): string {
  const methods: string[] = []
  let rest = s.trim()
  let n = 0
  while (rest.length > 0) {
    const m = rest.match(/^\s*it\s*\(\s*'[^']*'\s*,\s*\(\)\s*->\s*\{/)
    if (!m) {
      if (rest.trim().length > 0) methods.push(rest.trim())
      break
    }
    const arrow = rest.indexOf("->")
    const braceOpen = arrow >= 0 ? rest.indexOf("{", arrow) : -1
    if (braceOpen < 0) {
      methods.push(rest.trim())
      break
    }
    const closeBrace = findMatchingBrace(rest, braceOpen)
    if (closeBrace < 0) {
      methods.push(rest.trim())
      break
    }
    const inner = rest.slice(braceOpen + 1, closeBrace).trim()
    let after = closeBrace + 1
    while (after < rest.length && /\s/.test(rest[after] ?? "")) after++
    if (rest[after] !== ")") {
      methods.push(rest.trim())
      break
    }
    after++
    methods.push(`@Test\n  void contractClaim_${n++}() {\n${inner}\n  }`)
    rest = rest.slice(after).trim()
  }
  return methods.join("\n\n")
}

/**
 * LLMs sometimes emit `x instanceof Double` for primitive `double` locals — invalid Java.
 * Rewrite to `Double.isFinite(x)` which is valid for primitives.
 */
export function sanitizeJavaPrimitiveInstanceofMisuse(content: string): string {
  let out = content
  out = out.replace(
    /Assertions\.assertTrue\(\s*(\w+)\s+instanceof\s+Double\s*\|\|\s*\1\s*==\s*\(double\)\s*\1\s*\)/g,
    "Assertions.assertTrue(Double.isFinite($1))",
  )
  out = out.replace(
    /Assertions\.assertTrue\(\s*(\w+)\s+instanceof\s+Double\s*\)/g,
    (_, v: string) => {
      return `Assertions.assertTrue(Double.isFinite(${v}))`
    },
  )
  return out
}

export function normalizeJvmWrittenTestClassName(
  content: string,
  expectedClassName: string,
  lang: "java" | "kotlin",
): string {
  let replaced = false
  if (lang === "java") {
    return content.replace(
      /(^|\n)(\s*)((?:public\s+)?class)\s+(\w+)(\s*(?:\{|\n|<))/m,
      (full, lead: string, indent: string, _decl: string, oldName: string, rest: string) => {
        if (replaced) return full
        if (oldName === expectedClassName) return full
        replaced = true
        return `${lead}${indent}public class ${expectedClassName}${rest}`
      },
    )
  }
  replaced = false
  return content.replace(
    /(^|\n)(\s*)((?:internal\s+|public\s+|private\s+|protected\s+)?class)\s+(\w+)(\s*(?:\{|\n|<))/m,
    (full, lead: string, indent: string, _decl: string, oldName: string, rest: string) => {
      if (replaced) return full
      if (oldName === expectedClassName) return full
      replaced = true
      return `${lead}${indent}class ${expectedClassName}${rest}`
    },
  )
}

/**
 * Merge import lines that reference the same module path, deduplicating specifiers.
 *
 * Input:  ["import type { A } from \"x\"", "import type { A, B } from \"x\"", "import { C } from \"y\""]
 * Output: ["import type { A, B } from \"x\"", "import { C } from \"y\""]
 *
 * Handles: `import { X }`, `import type { X }`, `import { type X }` (inline type imports).
 * Lines that don't match the `import ... from "..."` pattern are passed through unchanged.
 */
export function dedupeImportLines(lines: string[]): string[] {
  const moduleMap = new Map<string, { isTypeOnly: boolean; specifiers: Set<string> }>()
  const passthrough: string[] = []

  for (const line of lines) {
    const m = line.match(/^import\s+(type\s+)?\{\s*([^}]+)\s*\}\s*from\s*["']([^"']+)["']\s*;?\s*$/)
    if (!m) {
      passthrough.push(line)
      continue
    }

    const isTypeImport = Boolean(m[1]?.trim())
    const rawSpecifiers = m[2] ?? ""
    const modulePath = m[3] ?? ""

    const existing = moduleMap.get(modulePath)
    if (!existing) {
      const specs = new Set(
        rawSpecifiers
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      )
      moduleMap.set(modulePath, { isTypeOnly: isTypeImport, specifiers: specs })
    } else {
      for (const spec of rawSpecifiers
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        existing.specifiers.add(spec)
      }
      if (!isTypeImport) {
        existing.isTypeOnly = false
      }
    }
  }

  const result: string[] = [...passthrough]
  for (const [modulePath, { isTypeOnly, specifiers }] of moduleMap) {
    const typeKeyword = isTypeOnly ? "type " : ""
    const specs = [...specifiers].sort().join(", ")
    result.push(`import ${typeKeyword}{ ${specs} } from "${modulePath}"`)
  }

  return result
}
