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
})
