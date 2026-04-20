import { promisify } from "node:util"
import type { MutationConfig, ToolchainProfile } from "@bollard/detect/src/types.js"
import { afterEach, describe, expect, it, vi } from "vitest"

const { mockExecFileAsync, mockWriteFile, mockReadFile } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockWriteFile: vi.fn(),
  mockReadFile: vi.fn(),
}))

vi.mock("node:child_process", () => {
  const mockFn = Object.assign(vi.fn(), {
    [promisify.custom]: mockExecFileAsync,
  })
  return { execFile: mockFn }
})

vi.mock("node:fs/promises", () => ({
  writeFile: mockWriteFile,
  readFile: mockReadFile,
}))

const {
  parseStrykerReport,
  parseMutmutResultsOutput,
  parseCargoMutantsOutcomes,
  parsePitReport,
  derivePitTargetClasses,
  StrykerProvider,
  MutmutProvider,
  CargoMutantsProvider,
  PitestProvider,
  getMutationProvider,
  runMutationTesting,
} = await import("../src/mutation.js")

function makeProfile(overrides?: Partial<MutationConfig>): ToolchainProfile {
  const scopeConfig = (enabled: boolean) => ({
    enabled,
    integration: "independent" as const,
    lifecycle: "ephemeral" as const,
    concerns: {
      correctness: "high" as const,
      security: "medium" as const,
      performance: "low" as const,
      resilience: "off" as const,
    },
  })
  return {
    language: "typescript",
    packageManager: "pnpm",
    checks: {},
    sourcePatterns: ["packages/*/src/**/*.ts"],
    testPatterns: ["packages/*/tests/**/*.test.ts"],
    ignorePatterns: ["node_modules"],
    allowedCommands: ["pnpm"],
    adversarial: {
      boundary: scopeConfig(true),
      contract: scopeConfig(true),
      behavioral: scopeConfig(false),
    },
    mutation: {
      enabled: true,
      tool: "stryker",
      threshold: 80,
      timeoutMs: 300_000,
      concurrency: 2,
      ...overrides,
    },
  }
}

function makeSampleReport(mutants: Array<{ status: string }>): string {
  return JSON.stringify({
    schemaVersion: "1",
    thresholds: { high: 80, low: 60 },
    files: {
      "src/foo.ts": {
        language: "typescript",
        source: "const x = 1",
        mutants: mutants.map((m, i) => ({
          id: String(i),
          mutatorName: "BooleanLiteral",
          status: m.status,
        })),
      },
    },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("parseStrykerReport", () => {
  it("parses a complete report with mixed statuses", () => {
    const report = JSON.stringify({
      schemaVersion: "1",
      thresholds: { high: 80, low: 60 },
      files: {
        "src/a.ts": {
          language: "typescript",
          source: "",
          mutants: [
            { id: "1", mutatorName: "BooleanLiteral", status: "Killed" },
            { id: "2", mutatorName: "StringLiteral", status: "Survived" },
            { id: "3", mutatorName: "ArithmeticOperator", status: "NoCoverage" },
            { id: "4", mutatorName: "BlockStatement", status: "CompileError" },
          ],
        },
        "src/b.ts": {
          language: "typescript",
          source: "",
          mutants: [
            { id: "5", mutatorName: "ConditionalExpression", status: "Killed" },
            { id: "6", mutatorName: "EqualityOperator", status: "Timeout" },
          ],
        },
      },
    })

    const result = parseStrykerReport(report)

    expect(result.killed).toBe(2)
    expect(result.survived).toBe(1)
    expect(result.noCoverage).toBe(1)
    expect(result.timeout).toBe(1)
    expect(result.totalMutants).toBe(5)
    expect(result.score).toBeCloseTo(60, 1)
  })

  it("returns zero score for empty report", () => {
    const report = JSON.stringify({
      schemaVersion: "1",
      thresholds: { high: 80, low: 60 },
      files: {},
    })

    const result = parseStrykerReport(report)

    expect(result.score).toBe(0)
    expect(result.totalMutants).toBe(0)
    expect(result.killed).toBe(0)
  })

  it("excludes CompileError/RuntimeError/Ignored/Pending from denominator", () => {
    const report = JSON.stringify({
      schemaVersion: "1",
      thresholds: { high: 80, low: 60 },
      files: {
        "src/c.ts": {
          language: "typescript",
          source: "",
          mutants: [
            { id: "1", mutatorName: "BooleanLiteral", status: "CompileError" },
            { id: "2", mutatorName: "BooleanLiteral", status: "RuntimeError" },
            { id: "3", mutatorName: "BooleanLiteral", status: "Ignored" },
            { id: "4", mutatorName: "BooleanLiteral", status: "Pending" },
          ],
        },
      },
    })

    const result = parseStrykerReport(report)

    expect(result.totalMutants).toBe(0)
    expect(result.score).toBe(0)
  })

  it("handles 100% kill rate", () => {
    const report = makeSampleReport([
      { status: "Killed" },
      { status: "Killed" },
      { status: "Killed" },
    ])

    const result = parseStrykerReport(report)

    expect(result.score).toBe(100)
    expect(result.killed).toBe(3)
    expect(result.totalMutants).toBe(3)
  })

  it("counts Timeout as killed in score", () => {
    const report = makeSampleReport([
      { status: "Timeout" },
      { status: "Timeout" },
      { status: "Survived" },
    ])

    const result = parseStrykerReport(report)

    expect(result.timeout).toBe(2)
    expect(result.survived).toBe(1)
    expect(result.totalMutants).toBe(3)
    expect(result.score).toBeCloseTo(66.67, 1)
  })
})

describe("StrykerProvider.run config generation", () => {
  it("generates config with mutate derived from profile sourcePatterns", async () => {
    mockWriteFile.mockResolvedValue(undefined)
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" })
    mockReadFile.mockResolvedValue(makeSampleReport([{ status: "Killed" }]))

    const profile = makeProfile()
    const provider = new StrykerProvider()
    await provider.run("/tmp/test", profile)

    expect(mockWriteFile).toHaveBeenCalledOnce()
    const writtenJson = JSON.parse(mockWriteFile.mock.calls[0][1] as string)
    expect(writtenJson.mutate).toContain("packages/*/src/**/*.ts")
    expect(writtenJson.mutate.some((p: string) => p.startsWith("!"))).toBe(true)
  })

  it("falls back to vitest.config.ts when no test config flag", async () => {
    mockWriteFile.mockResolvedValue(undefined)
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" })
    mockReadFile.mockResolvedValue(makeSampleReport([{ status: "Killed" }]))

    const profile = makeProfile()
    const provider = new StrykerProvider()
    await provider.run("/tmp/test", profile)

    const writtenJson = JSON.parse(mockWriteFile.mock.calls[0][1] as string)
    expect(writtenJson.vitest.configFile).toBe("vitest.config.ts")
  })

  it("uses mutateFiles when provided", async () => {
    mockWriteFile.mockResolvedValue(undefined)
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" })
    mockReadFile.mockResolvedValue(makeSampleReport([{ status: "Killed" }]))

    const profile = makeProfile()
    const provider = new StrykerProvider()
    await provider.run("/tmp/test", profile, ["src/foo.ts"])

    expect(mockWriteFile).toHaveBeenCalledOnce()
    const writtenJson = JSON.parse(mockWriteFile.mock.calls[0][1] as string)
    expect(writtenJson.mutate).toEqual(["src/foo.ts"])
  })

  it("falls back to sourcePatterns when mutateFiles is empty", async () => {
    mockWriteFile.mockResolvedValue(undefined)
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" })
    mockReadFile.mockResolvedValue(makeSampleReport([{ status: "Killed" }]))

    const profile = makeProfile()
    const provider = new StrykerProvider()
    await provider.run("/tmp/test", profile, [])

    expect(mockWriteFile).toHaveBeenCalledOnce()
    const writtenJson = JSON.parse(mockWriteFile.mock.calls[0][1] as string)
    expect(writtenJson.mutate).toContain("packages/*/src/**/*.ts")
    expect(writtenJson.mutate.some((p: string) => p.startsWith("!"))).toBe(true)
  })

  it("falls back to sourcePatterns when mutateFiles is undefined", async () => {
    mockWriteFile.mockResolvedValue(undefined)
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" })
    mockReadFile.mockResolvedValue(makeSampleReport([{ status: "Killed" }]))

    const profile = makeProfile()
    const provider = new StrykerProvider()
    await provider.run("/tmp/test", profile, undefined)

    expect(mockWriteFile).toHaveBeenCalledOnce()
    const writtenJson = JSON.parse(mockWriteFile.mock.calls[0][1] as string)
    expect(writtenJson.mutate).toContain("packages/*/src/**/*.ts")
    expect(writtenJson.mutate.some((p: string) => p.startsWith("!"))).toBe(true)
  })

  it("uses threshold and concurrency from MutationConfig", async () => {
    mockWriteFile.mockResolvedValue(undefined)
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" })
    mockReadFile.mockResolvedValue(makeSampleReport([{ status: "Killed" }]))

    const profile = makeProfile({ threshold: 90, concurrency: 4 })
    const provider = new StrykerProvider()
    await provider.run("/tmp/test", profile)

    const writtenJson = JSON.parse(mockWriteFile.mock.calls[0][1] as string)
    expect(writtenJson.thresholds.high).toBe(90)
    expect(writtenJson.concurrency).toBe(4)
  })
})

describe("runMutationTesting", () => {
  it("returns zero result when mutation is disabled", async () => {
    const profile = makeProfile({ enabled: false })

    const result = await runMutationTesting("/tmp/test", profile)

    expect(result.score).toBe(0)
    expect(result.totalMutants).toBe(0)
    expect(mockExecFileAsync).not.toHaveBeenCalled()
  })

  it("returns zero result for unsupported language", async () => {
    const profile = makeProfile()
    profile.language = "go"

    const result = await runMutationTesting("/tmp/test", profile)

    expect(result.score).toBe(0)
    expect(result.totalMutants).toBe(0)
    expect(mockExecFileAsync).not.toHaveBeenCalled()
  })

  it("returns zero result when Stryker binary fails", async () => {
    mockWriteFile.mockResolvedValue(undefined)
    const enoent = new Error("spawn pnpm ENOENT") as NodeJS.ErrnoException
    enoent.code = "ENOENT"
    mockExecFileAsync.mockRejectedValue(enoent)

    const profile = makeProfile()
    const result = await runMutationTesting("/tmp/test", profile)

    expect(result.score).toBe(0)
    expect(result.totalMutants).toBe(0)
    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it("returns zero result when report file is missing", async () => {
    mockWriteFile.mockResolvedValue(undefined)
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" })
    const enoent = new Error("ENOENT: no such file") as NodeJS.ErrnoException
    enoent.code = "ENOENT"
    mockReadFile.mockRejectedValue(enoent)

    const profile = makeProfile()
    const result = await runMutationTesting("/tmp/test", profile)

    expect(result.score).toBe(0)
    expect(result.totalMutants).toBe(0)
  })

  it("threads mutateFiles to provider", async () => {
    mockWriteFile.mockResolvedValue(undefined)
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" })
    mockReadFile.mockResolvedValue(makeSampleReport([{ status: "Killed" }]))

    const profile = makeProfile()
    await runMutationTesting("/tmp/test", profile, ["a.ts"])

    expect(mockWriteFile).toHaveBeenCalledOnce()
    const writtenJson = JSON.parse(mockWriteFile.mock.calls[0][1] as string)
    expect(writtenJson.mutate).toEqual(["a.ts"])
  })

  it("returns parsed result on successful run", async () => {
    mockWriteFile.mockResolvedValue(undefined)
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" })
    mockReadFile.mockResolvedValue(
      makeSampleReport([
        { status: "Killed" },
        { status: "Killed" },
        { status: "Survived" },
        { status: "Killed" },
      ]),
    )

    const profile = makeProfile()
    const result = await runMutationTesting("/tmp/test", profile)

    expect(result.score).toBe(75)
    expect(result.killed).toBe(3)
    expect(result.survived).toBe(1)
    expect(result.totalMutants).toBe(4)
    expect(result.reportPath).toContain("mutation.json")
  })
})

function makeProfileForLanguage(
  language: ToolchainProfile["language"],
  overrides?: Partial<MutationConfig>,
): ToolchainProfile {
  const base = makeProfile(overrides)
  if (language === "python") {
    return {
      ...base,
      language: "python",
      packageManager: "pip",
      sourcePatterns: ["src/**/*.py"],
      testPatterns: ["tests/**/*.py"],
    }
  }
  if (language === "rust") {
    return {
      ...base,
      language: "rust",
      packageManager: "cargo",
      sourcePatterns: ["src/**/*.rs"],
      testPatterns: ["tests/**/*.rs"],
    }
  }
  return { ...base, language }
}

describe("MutmutProvider", () => {
  it("uses mutateFiles when provided", async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "", stderr: "" }).mockResolvedValueOnce({
      stdout: "Killed mutants (7 of 10)\nSurvived mutants (3 of 10)\n",
      stderr: "",
    })

    const profile = makeProfileForLanguage("python")
    const provider = new MutmutProvider()
    await provider.run("/tmp/py", profile, ["pkg/a.py", "pkg/b.py"])

    expect(mockExecFileAsync.mock.calls[0]?.[0]).toBe("mutmut")
    expect(mockExecFileAsync.mock.calls[0]?.[1]).toEqual([
      "run",
      "--paths-to-mutate",
      "pkg/a.py,pkg/b.py",
      "--no-progress",
    ])
  })

  it("falls back to sourcePatterns when no mutateFiles", async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "", stderr: "" }).mockResolvedValueOnce({
      stdout: "Killed mutants (4 of 4)\n",
      stderr: "",
    })

    const profile = makeProfileForLanguage("python")
    const provider = new MutmutProvider()
    await provider.run("/tmp/py", profile, undefined)

    expect(mockExecFileAsync.mock.calls[0]?.[1]).toContain("--paths-to-mutate")
    expect(mockExecFileAsync.mock.calls[0]?.[1]).toContain("src")
  })

  it("parses mutmut results output", () => {
    const text = `
Survived mutants (3 of 10):

Killed mutants (7 of 10):
`
    const result = parseMutmutResultsOutput(text)
    expect(result.killed).toBe(7)
    expect(result.survived).toBe(3)
    expect(result.totalMutants).toBe(10)
  })
})

describe("CargoMutantsProvider", () => {
  it("uses --file flags when mutateFiles provided", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" })
    mockReadFile.mockResolvedValue("[]")

    const profile = makeProfileForLanguage("rust")
    const provider = new CargoMutantsProvider()
    await provider.run("/tmp/rs", profile, ["src/lib.rs", "src/bin.rs"])

    const cargoCall = mockExecFileAsync.mock.calls.find((c) => c[0] === "cargo")
    expect(cargoCall?.[1]).toEqual([
      "mutants",
      "--json",
      "--no-shuffle",
      "--file",
      "src/lib.rs",
      "--file",
      "src/bin.rs",
    ])
  })

  it("parses outcomes.json", () => {
    const json = JSON.stringify([
      { scenario: "a", summary: "CaughtMutant" },
      { scenario: "b", summary: "MissedMutant" },
      { scenario: "c", summary: "Timeout" },
      { scenario: "d", summary: "Unviable" },
    ])
    const result = parseCargoMutantsOutcomes(json)
    expect(result.killed).toBe(1)
    expect(result.survived).toBe(1)
    expect(result.timeout).toBe(1)
    expect(result.totalMutants).toBe(3)
  })
})

describe("parsePitReport", () => {
  it("counts KILLED, SURVIVED, NO_COVERAGE, TIMED_OUT from mutations.xml", () => {
    const xml = `<mutations>
  <mutation detected="true" status="KILLED"/>
  <mutation detected="false" status="SURVIVED"/>
  <mutation detected="false" status="NO_COVERAGE"/>
  <mutation detected="false" status="TIMED_OUT"/>
</mutations>`
    const r = parsePitReport(xml)
    expect(r.killed).toBe(1)
    expect(r.survived).toBe(1)
    expect(r.noCoverage).toBe(1)
    expect(r.timeout).toBe(1)
    expect(r.totalMutants).toBe(4)
    expect(r.score).toBeGreaterThan(0)
  })

  it("returns zero for empty xml", () => {
    const r = parsePitReport("")
    expect(r.totalMutants).toBe(0)
    expect(r.score).toBe(0)
  })
})

describe("derivePitTargetClasses", () => {
  it("maps Java source paths to comma-separated FQCNs", () => {
    const profile = makeProfile()
    expect(derivePitTargetClasses(["src/main/java/com/foo/Bar.java"], profile)).toBe("com.foo.Bar")
  })

  it("maps Kotlin paths", () => {
    const profile = makeProfile()
    expect(derivePitTargetClasses(["src/main/kotlin/a/B.kt"], profile)).toBe("a.B")
  })

  it("uses star when no files", () => {
    const profile = makeProfile()
    expect(derivePitTargetClasses(undefined, profile)).toBe("*")
  })
})

describe("getMutationProvider", () => {
  it("routes to correct provider by language", () => {
    expect(getMutationProvider("python")).toBeInstanceOf(MutmutProvider)
    expect(getMutationProvider("rust")).toBeInstanceOf(CargoMutantsProvider)
    expect(getMutationProvider("java")).toBeInstanceOf(PitestProvider)
    expect(getMutationProvider("kotlin")).toBeInstanceOf(PitestProvider)
    expect(getMutationProvider("go")).toBeUndefined()
  })
})
