import { mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultAdversarialConfig, withBoundaryOverrides } from "@bollard/detect/src/concerns.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { describe, expect, it } from "vitest"
import {
  type TestMetadata,
  checkTestRunnerIntegration,
  resolveContractTestOutputRel,
  resolveLifecycle,
  resolveTestOutputDir,
  writeTestMetadata,
} from "../src/test-lifecycle.js"

const makeProfile = (overrides: Partial<ToolchainProfile> = {}): ToolchainProfile => ({
  language: "typescript",
  checks: {},
  sourcePatterns: [],
  testPatterns: [],
  ignorePatterns: [],
  allowedCommands: [],
  adversarial: defaultAdversarialConfig({ language: "typescript" }),
  ...overrides,
})

describe("resolveLifecycle", () => {
  it("returns ephemeral by default", () => {
    expect(resolveLifecycle()).toBe("ephemeral")
  })

  it("returns ephemeral when boundary lifecycle is ephemeral", () => {
    const profile = makeProfile({
      adversarial: withBoundaryOverrides("typescript", { lifecycle: "ephemeral" }),
    })
    expect(resolveLifecycle(profile)).toBe("ephemeral")
  })

  it("returns persistent-native when boundary lifecycle is persistent", () => {
    const profile = makeProfile({
      adversarial: withBoundaryOverrides("typescript", { lifecycle: "persistent" }),
    })
    expect(resolveLifecycle(profile)).toBe("persistent-native")
  })

  it("returns ephemeral when no profile", () => {
    expect(resolveLifecycle(undefined)).toBe("ephemeral")
  })
})

describe("resolveTestOutputDir", () => {
  it("returns ephemeral path with run ID", () => {
    const dir = resolveTestOutputDir("/work", "run-123", "auth-retry", "ephemeral", "blackbox")
    expect(dir).toBe(join("/work", ".bollard", "runs", "run-123", "adversarial-blackbox"))
  })

  it("returns ephemeral native path", () => {
    const dir = resolveTestOutputDir("/work", "run-123", "auth-retry", "ephemeral", "native")
    expect(dir).toBe(join("/work", ".bollard", "runs", "run-123", "adversarial-native"))
  })

  it("returns persistent-native path with feature slug", () => {
    const dir = resolveTestOutputDir(
      "/work",
      "run-123",
      "auth-retry",
      "persistent-native",
      "native",
    )
    expect(dir).toBe(join("/work", ".bollard", "tests", "auth-retry"))
  })

  it("persistent-native path ignores run ID", () => {
    const dir1 = resolveTestOutputDir("/w", "run-1", "feat", "persistent-native", "native")
    const dir2 = resolveTestOutputDir("/w", "run-2", "feat", "persistent-native", "native")
    expect(dir1).toBe(dir2)
  })
})

describe("resolveContractTestOutputRel", () => {
  it("uses .bollard/tests/contract/<slug>/ when lifecycle is persistent", () => {
    const rel = resolveContractTestOutputRel({
      runId: "run-9",
      task: "Add auth",
      derivedRelativePath: "packages/cli/tests/contracts/foo.contract.test.ts",
      lifecycle: "persistent",
    })
    expect(rel).toBe(join(".bollard", "tests", "contract", "add-auth", "foo.contract.test.ts"))
  })

  it("uses run-scoped adversarial/contract when lifecycle is ephemeral", () => {
    const rel = resolveContractTestOutputRel({
      runId: "run-9",
      task: "Add auth",
      derivedRelativePath: "packages/cli/tests/contracts/foo.contract.test.ts",
      lifecycle: "ephemeral",
    })
    expect(rel).toBe(
      join(".bollard", "runs", "run-9", "adversarial", "contract", "foo.contract.test.ts"),
    )
  })
})

describe("writeTestMetadata", () => {
  it("creates valid _bollard.json", async () => {
    const dir = join(tmpdir(), `bollard-test-meta-${Date.now()}`)
    await mkdir(dir, { recursive: true })

    const meta: TestMetadata = {
      blueprintId: "implement-feature",
      runId: "20260329-feat-auth-retry",
      task: "Add auth retry logic",
      featureSlug: "auth-retry",
      generatedAt: new Date().toISOString(),
      agentModel: "claude-sonnet-4-20250514",
      testFramework: "vitest",
      testCount: 5,
      replaces: null,
    }

    await writeTestMetadata(dir, meta)
    const content = await readFile(join(dir, "_bollard.json"), "utf-8")
    const parsed = JSON.parse(content) as TestMetadata
    expect(parsed.blueprintId).toBe("implement-feature")
    expect(parsed.runId).toBe("20260329-feat-auth-retry")
    expect(parsed.testCount).toBe(5)
    expect(parsed.replaces).toBeNull()

    await rm(dir, { recursive: true })
  })
})

describe("checkTestRunnerIntegration", () => {
  it("returns not integrated for Go", async () => {
    const profile = makeProfile({ language: "go" })
    const result = await checkTestRunnerIntegration("/tmp", profile)
    expect(result.alreadyIntegrated).toBe(false)
    expect(result.suggestion).toContain("persistent-isolated fallback")
  })

  it("returns not integrated for Rust (needs Cargo.toml edit)", async () => {
    const profile = makeProfile({ language: "rust" })
    const result = await checkTestRunnerIntegration("/tmp", profile)
    expect(result.alreadyIntegrated).toBe(false)
    expect(result.suggestion).toContain("Cargo.toml")
  })

  it("returns not integrated for TypeScript with Vitest (needs config edit)", async () => {
    const profile = makeProfile({
      language: "typescript",
      checks: {
        test: {
          label: "Vitest",
          cmd: "pnpm",
          args: ["exec", "vitest", "run"],
          source: "auto-detected",
        },
      },
    })
    const result = await checkTestRunnerIntegration("/tmp", profile)
    expect(result.alreadyIntegrated).toBe(false)
    expect(result.suggestion).toContain("vitest")
  })

  it("returns not integrated for Python with pytest (no pyproject.toml)", async () => {
    const dir = join(tmpdir(), `bollard-pytest-${Date.now()}`)
    await mkdir(dir, { recursive: true })
    const profile = makeProfile({
      language: "python",
      checks: {
        test: { label: "pytest", cmd: "pytest", args: ["-v"], source: "auto-detected" },
      },
    })
    const result = await checkTestRunnerIntegration(dir, profile)
    expect(result.alreadyIntegrated).toBe(false)
    await rm(dir, { recursive: true })
  })
})
