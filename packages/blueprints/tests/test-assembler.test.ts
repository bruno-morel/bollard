import { defaultAdversarialConfig } from "@bollard/detect/src/concerns.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { BollardError } from "@bollard/engine/src/errors.js"
import type { ClaimRecord } from "@bollard/verify/src/contract-grounding.js"
import { describe, expect, it } from "vitest"
import { assembleTestFile } from "../src/test-assembler.js"

function tsProfile(): ToolchainProfile {
  return {
    language: "typescript",
    packageManager: "pnpm",
    checks: {
      test: {
        label: "Vitest",
        cmd: "pnpm",
        args: ["exec", "vitest", "run"],
        source: "default",
      },
    },
    sourcePatterns: ["**/*.ts"],
    testPatterns: ["**/*.test.ts"],
    ignorePatterns: [],
    allowedCommands: [],
    adversarial: defaultAdversarialConfig({ language: "typescript" }),
  }
}

function pyProfile(): ToolchainProfile {
  return {
    language: "python",
    packageManager: "pip",
    checks: {
      test: {
        label: "pytest",
        cmd: "pytest",
        args: ["-q"],
        source: "default",
      },
    },
    sourcePatterns: ["**/*.py"],
    testPatterns: ["**/test_*.py"],
    ignorePatterns: [],
    allowedCommands: [],
    adversarial: defaultAdversarialConfig({ language: "python" }),
  }
}

function javaProfile(): ToolchainProfile {
  return {
    language: "java",
    packageManager: "maven",
    checks: {},
    sourcePatterns: ["**/*.java"],
    testPatterns: ["**/*Test.java"],
    ignorePatterns: [],
    allowedCommands: [],
    adversarial: defaultAdversarialConfig({ language: "java" }),
  }
}

const baseClaimFields = {
  concern: "correctness" as const,
  claim: "example",
  grounding: [{ quote: "x", source: "sig" }],
}

describe("assembleTestFile", () => {
  it("throws when claims is empty", () => {
    expect(() =>
      assembleTestFile({
        claims: [],
        profile: tsProfile(),
        sourceFile: "packages/engine/src/cost-tracker.ts",
        scope: "boundary",
        runId: "r1",
        task: "t",
      }),
    ).toThrow(BollardError)
  })

  it("TypeScript boundary: hoists imports, dedupes same module, wraps in describe", () => {
    const claims: ClaimRecord[] = [
      {
        id: "bnd1",
        ...baseClaimFields,
        test: 'import { foo } from "./mod.js"\n\nit("a", () => { expect(foo()).toBe(1) })',
      },
      {
        id: "bnd2",
        ...baseClaimFields,
        test: 'import { foo } from "./mod.js"\n\nit("b", () => { expect(foo()).toBe(2) })',
      },
    ]
    const { fileContent, testPath } = assembleTestFile({
      claims,
      profile: tsProfile(),
      sourceFile: "packages/engine/src/cost-tracker.ts",
      scope: "boundary",
      runId: "run-x",
      task: "task",
    })
    expect(testPath).toContain("cost-tracker")
    expect(testPath).toContain("adversarial")
    expect(fileContent).toContain('import { foo } from "./mod.js"')
    const fromMatches = fileContent.match(/from "\.\/mod\.js"/g)
    expect(fromMatches?.length).toBe(1)
    expect(fileContent).toContain('describe("boundary tests"')
    expect(fileContent).toContain('import { describe, it, expect, vi } from "vitest"')
  })

  it("Python boundary: pytest preamble and flat bodies", () => {
    const claims: ClaimRecord[] = [
      {
        id: "bnd1",
        ...baseClaimFields,
        test: "def test_one():\n    assert 1 == 1",
      },
      {
        id: "bnd2",
        ...baseClaimFields,
        test: "def test_two():\n    assert 2 == 2",
      },
    ]
    const { fileContent } = assembleTestFile({
      claims,
      profile: pyProfile(),
      sourceFile: "src/engine/cost_tracker.py",
      scope: "boundary",
      runId: "r1",
      task: "t",
    })
    expect(fileContent.startsWith("import pytest\n")).toBe(true)
    expect(fileContent).toContain("def test_one():")
    expect(fileContent).toContain("def test_two():")
    expect(fileContent).not.toContain("describe(")
  })

  it("Java contract: package, JUnit imports, public class ContractTest", () => {
    const claims: ClaimRecord[] = [
      {
        id: "c1",
        ...baseClaimFields,
        test: "@Test\nvoid m() {\n  org.junit.jupiter.api.Assertions.assertTrue(true);\n}",
      },
    ]
    const sourceFile = "demo/src/main/java/com/example/Demo.java"
    const { fileContent, testPath } = assembleTestFile({
      claims,
      profile: javaProfile(),
      sourceFile,
      scope: "contract",
      runId: "run-y",
      task: "add api",
    })
    expect(testPath).toContain("src/test/java")
    expect(testPath).toContain("DemoContractTest.java")
    expect(fileContent).toContain("package com.example;")
    expect(fileContent).toContain("import org.junit.jupiter.api.Test;")
    expect(fileContent).toContain("public class DemoContractTest {")
  })

  it("TypeScript behavioral: describe title is behavioral tests", () => {
    const claims: ClaimRecord[] = [
      {
        id: "b1",
        ...baseClaimFields,
        test: "it('x', () => { expect(1).toBe(1) })",
      },
    ]
    const { fileContent } = assembleTestFile({
      claims,
      profile: tsProfile(),
      sourceFile: "packages/cli/src/index.ts",
      scope: "behavioral",
      runId: "r2",
      task: "probe",
    })
    expect(fileContent).toContain('describe("behavioral tests"')
  })
})
