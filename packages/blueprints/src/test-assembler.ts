import { basename } from "node:path"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { BollardError } from "@bollard/engine/src/errors.js"
import type { ContractContext } from "@bollard/verify/src/contract-extractor.js"
import type { ClaimRecord } from "@bollard/verify/src/contract-grounding.js"
import {
  resolveBehavioralTestOutputRel,
  resolveContractTestOutputRel,
} from "@bollard/verify/src/test-lifecycle.js"
import {
  dedupeImportLines,
  deriveAdversarialTestPath,
  inferJvmPackageFromMainSource,
  jvmContractCoerceVitestItToJUnit5,
  resolveContractTestModulePrefix,
} from "./write-tests-helpers.js"

export interface AssemblerOptions {
  claims: ClaimRecord[]
  profile: ToolchainProfile
  /** Affected source file (consumer-prefixed for contract when caller resolves module prefix). */
  sourceFile: string
  scope: "boundary" | "contract" | "behavioral"
  contractContext?: ContractContext
  runId: string
  task: string
}

export interface AssembledTest {
  fileContent: string
  testPath: string
}

function describeTitle(scope: AssemblerOptions["scope"]): string {
  if (scope === "boundary") return "boundary tests"
  if (scope === "behavioral") return "behavioral tests"
  return "contract tests"
}

function hoistClaimBodies(claims: ClaimRecord[]): {
  hoistedImports: string[]
  strippedBodies: string[]
} {
  const rawImports: string[] = []
  const strippedBodies: string[] = []
  for (const c of claims) {
    const lines = c.test.split("\n")
    const bodyLines: string[] = []
    for (const line of lines) {
      if (line.trimStart().startsWith("import ")) {
        rawImports.push(line.trim())
      } else {
        bodyLines.push(line)
      }
    }
    const body = bodyLines.join("\n").trim()
    if (body.length > 0) strippedBodies.push(body)
  }
  return { hoistedImports: dedupeImportLines(rawImports), strippedBodies }
}

/**
 * Pure assembly of adversarial test file content from grounded claims.
 * Callers perform I/O, leak scan, and optional JVM class-name normalization for boundary scope.
 */
export function assembleTestFile(opts: AssemblerOptions): AssembledTest {
  const { claims, profile, scope, runId, task } = opts
  if (claims.length === 0) {
    throw new BollardError({
      code: "NODE_EXECUTION_FAILED",
      message: "assembleTestFile called with no claims",
    })
  }

  const lang = profile.language ?? "typescript"
  const { hoistedImports, strippedBodies } = hoistClaimBodies(claims)

  let contractSourceFile = opts.sourceFile
  if (scope === "contract") {
    contractSourceFile = resolveContractTestModulePrefix(
      opts.sourceFile,
      opts.contractContext,
      lang,
    )
  }

  let preamble: string
  let wrapStart: string
  let wrapEnd: string

  if (lang === "python") {
    preamble = "import pytest\n"
    wrapStart = ""
    wrapEnd = ""
  } else if (scope !== "behavioral" && (lang === "java" || lang === "kotlin")) {
    const ext = lang === "java" ? "java" : "kt"
    const derivedRel = deriveAdversarialTestPath(contractSourceFile, profile, scope)
    const simpleName = basename(derivedRel, `.${ext}`)
    const pkg = inferJvmPackageFromMainSource(contractSourceFile)
    const importLines = [...hoistedImports].sort().join("\n")
    if (lang === "java") {
      const jUnitImports =
        "import org.junit.jupiter.api.Test;\nimport static org.junit.jupiter.api.Assertions.*;"
      preamble = pkg
        ? `package ${pkg};\n\n${jUnitImports}\n${importLines}\n`
        : `${jUnitImports}\n${importLines}\n`
    } else {
      preamble = pkg ? `package ${pkg};\n\n${importLines}\n` : `${importLines}\n`
    }
    wrapStart = lang === "java" ? `\npublic class ${simpleName} {\n` : `\nclass ${simpleName} {\n`
    wrapEnd = "\n}\n"
  } else {
    const vitestImport = 'import { describe, it, expect, vi } from "vitest"'
    const allImports = [vitestImport, ...hoistedImports].join("\n")
    preamble = `${allImports}\n`
    const title = describeTitle(scope)
    wrapStart = `\ndescribe("${title}", () => {\n`
    wrapEnd = "\n})\n"
  }

  let testBodies = strippedBodies.join("\n\n")
  if (lang === "java" && testBodies.includes("it(")) {
    testBodies = jvmContractCoerceVitestItToJUnit5(testBodies)
  }
  const fileContent = `${preamble}${wrapStart}${testBodies}${wrapEnd}`

  let testPath: string
  if (scope === "boundary") {
    testPath = deriveAdversarialTestPath(contractSourceFile, profile, "boundary")
  } else if (scope === "contract") {
    const derivedRel = deriveAdversarialTestPath(contractSourceFile, profile, "contract")
    testPath = resolveContractTestOutputRel({
      runId,
      task,
      derivedRelativePath: derivedRel,
      lifecycle: profile.adversarial.contract.lifecycle,
    })
  } else {
    const derivedRel = deriveAdversarialTestPath(contractSourceFile, profile, "behavioral")
    testPath = resolveBehavioralTestOutputRel({
      runId,
      task,
      derivedRelativePath: derivedRel,
      lifecycle: profile.adversarial.behavioral.lifecycle,
    })
  }

  return { fileContent, testPath }
}
