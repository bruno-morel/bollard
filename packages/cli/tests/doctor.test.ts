import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { formatDoctorReport, runDoctor } from "../src/doctor.js"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const TS_FIXTURE = join(REPO_ROOT, "packages/detect/tests/fixtures/ts-project")

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

function envWithoutLlmKeys(): NodeJS.ProcessEnv {
  const copy = { ...process.env }
  copy.ANTHROPIC_API_KEY = undefined
  copy.OPENAI_API_KEY = undefined
  copy.GOOGLE_API_KEY = undefined
  return copy
}

describe("runDoctor", () => {
  it("includes docker check with pass or fail status", async () => {
    const report = await runDoctor(TS_FIXTURE, envWithoutLlmKeys())
    const docker = report.checks.find((c) => c.id === "docker")
    expect(docker).toBeDefined()
    expect(docker?.status === "pass" || docker?.status === "fail").toBe(true)
  })

  it("passes llm-key when ANTHROPIC_API_KEY is set", async () => {
    const env = { ...envWithoutLlmKeys(), ANTHROPIC_API_KEY: "sk-test" }
    const report = await runDoctor(TS_FIXTURE, env)
    const llm = report.checks.find((c) => c.id === "llm-key")
    expect(llm?.status).toBe("pass")
    expect(llm?.detail).toContain("ANTHROPIC_API_KEY")
  })

  it("fails llm-key when no LLM env vars are set", async () => {
    const report = await runDoctor(TS_FIXTURE, envWithoutLlmKeys())
    const llm = report.checks.find((c) => c.id === "llm-key")
    expect(llm?.status).toBe("fail")
    expect(llm?.detail).toContain("ANTHROPIC_API_KEY")
  })

  it("passes toolchain for TypeScript fixture with verification checks", async () => {
    const report = await runDoctor(TS_FIXTURE, envWithoutLlmKeys())
    const tc = report.checks.find((c) => c.id === "toolchain")
    expect(tc?.status).toBe("pass")
    expect(tc?.detail).toContain("typescript")
    expect(tc?.detail).toMatch(/\d+ verification check/)
  })

  it("reports using defaults when .bollard.yml is absent", async () => {
    const report = await runDoctor(TS_FIXTURE, envWithoutLlmKeys())
    expect(report.configNote).toBe("using defaults")
  })

  it("reports custom config when .bollard.yml exists", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bollard-doctor-"))
    await writeFile(join(tempDir, "tsconfig.json"), '{"compilerOptions":{}}', "utf-8")
    await writeFile(join(tempDir, "package.json"), "{}", "utf-8")
    await writeFile(join(tempDir, ".bollard.yml"), "# minimal\n", "utf-8")
    const report = await runDoctor(tempDir, envWithoutLlmKeys())
    expect(report.configNote).toBe("custom config")
  })

  it("includes historyHealth when options.history is true", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bollard-doctor-hist-"))
    await writeFile(join(tempDir, "tsconfig.json"), '{"compilerOptions":{}}', "utf-8")
    await writeFile(join(tempDir, "package.json"), "{}", "utf-8")
    const report = await runDoctor(tempDir, envWithoutLlmKeys(), { history: true })
    expect(report.historyHealth).toBeDefined()
    expect(report.historyHealth?.jsonlExists).toBe(false)
    expect(report.historyHealth?.jsonlRecordCount).toBe(0)
  })
})

describe("doctor --json payload", () => {
  it("round-trips DoctorReport through JSON with stable shape", () => {
    const report = {
      allPassed: false,
      configNote: "using defaults" as const,
      checks: [
        { id: "docker" as const, label: "Docker", status: "pass" as const, detail: "Docker ok" },
        {
          id: "llm-key" as const,
          label: "LLM API key",
          status: "fail" as const,
          detail: "set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY",
        },
        {
          id: "toolchain" as const,
          label: "Toolchain",
          status: "pass" as const,
          detail: "typescript, 2 verification check(s)",
        },
      ],
    }
    const payload = JSON.parse(JSON.stringify(report, null, 2)) as typeof report
    expect(payload.allPassed).toBe(false)
    expect(payload.configNote).toBe("using defaults")
    expect(payload.checks).toHaveLength(3)
    expect(payload.checks.map((c) => c.id)).toEqual(["docker", "llm-key", "toolchain"])
    for (const c of payload.checks) {
      expect(c).toMatchObject({
        id: expect.any(String),
        label: expect.any(String),
        status: expect.stringMatching(/^(pass|fail)$/),
        detail: expect.any(String),
      })
    }
  })
})

describe("formatDoctorReport", () => {
  it("renders pass and fail lines plus config footer", () => {
    const report = {
      allPassed: false,
      configNote: "using defaults" as const,
      checks: [
        { id: "docker" as const, label: "Docker", status: "pass" as const, detail: "Docker ok" },
        {
          id: "llm-key" as const,
          label: "LLM API key",
          status: "fail" as const,
          detail: "set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY",
        },
        {
          id: "toolchain" as const,
          label: "Toolchain",
          status: "pass" as const,
          detail: "typescript, 2 verification check(s)",
        },
      ],
    }
    const out = formatDoctorReport(report)
    expect(out).toContain("Docker")
    expect(out).toContain("LLM API key")
    expect(out).toContain("Toolchain")
    expect(out).toContain("✓")
    expect(out).toContain("✗")
    expect(out).toContain("Config:")
    expect(out).toContain("using defaults")
  })

  it("renders Run history section when historyHealth is present", () => {
    const report = {
      allPassed: true,
      configNote: "using defaults" as const,
      checks: [
        { id: "docker" as const, label: "Docker", status: "pass" as const, detail: "ok" },
        { id: "llm-key" as const, label: "LLM API key", status: "pass" as const, detail: "set: X" },
        {
          id: "toolchain" as const,
          label: "Toolchain",
          status: "pass" as const,
          detail: "typescript",
        },
      ],
      historyHealth: {
        jsonlExists: true,
        jsonlRecordCount: 2,
        dbExists: true,
        dbCurrent: true,
        dbRecordCount: 2,
        lastRebuildIso: new Date().toISOString(),
        costTrend: "stable" as const,
        recentFailingNodes: [],
        mutationScoreRange: { min: 68, max: 72 },
      },
    }
    const out = formatDoctorReport(report)
    expect(out).toContain("Run history")
    expect(out).toContain("history.jsonl exists (2 records)")
  })
})
