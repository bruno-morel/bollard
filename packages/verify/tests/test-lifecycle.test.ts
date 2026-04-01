import { mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { describe, expect, it } from "vitest"
import {
  type TestMetadata,
  integrateWithTestRunner,
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
  adversarial: { mode: "blackbox" },
  ...overrides,
})

describe("resolveLifecycle", () => {
  it("returns ephemeral by default", () => {
    expect(resolveLifecycle()).toBe("ephemeral")
  })

  it("returns ephemeral when persist is false", () => {
    const profile = makeProfile({ adversarial: { mode: "blackbox", persist: false } })
    expect(resolveLifecycle(profile)).toBe("ephemeral")
  })

  it("returns persistent-native when persist is true", () => {
    const profile = makeProfile({ adversarial: { mode: "blackbox", persist: true } })
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

describe("integrateWithTestRunner", () => {
  it("returns integrated false for Go", async () => {
    const profile = makeProfile({ language: "go" })
    const result = await integrateWithTestRunner("/tmp", profile)
    expect(result.integrated).toBe(false)
    expect(result.method).toContain("persistent-isolated fallback")
  })

  it("returns integrated true for Rust", async () => {
    const profile = makeProfile({ language: "rust" })
    const result = await integrateWithTestRunner("/tmp", profile)
    expect(result.integrated).toBe(true)
    expect(result.method).toContain("Cargo.toml")
  })

  it("returns integrated true for TypeScript with Vitest", async () => {
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
    const result = await integrateWithTestRunner("/tmp", profile)
    expect(result.integrated).toBe(true)
    expect(result.method).toContain("vitest")
  })

  it("returns integrated true for Python with pytest", async () => {
    const dir = join(tmpdir(), `bollard-pytest-${Date.now()}`)
    await mkdir(dir, { recursive: true })
    const profile = makeProfile({
      language: "python",
      checks: {
        test: { label: "pytest", cmd: "pytest", args: ["-v"], source: "auto-detected" },
      },
    })
    const result = await integrateWithTestRunner(dir, profile)
    expect(result.integrated).toBe(true)
    await rm(dir, { recursive: true })
  })
})
