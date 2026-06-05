import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { BollardConfig } from "@bollard/engine/src/context.js"
import { describe, expect, it } from "vitest"
import {
  REGISTRY_STALENESS_DAYS,
  checkModelRegistry,
  formatDoctorReport,
  formatRegistrySection,
  runDoctor,
} from "../src/doctor.js"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const TS_FIXTURE = join(REPO_ROOT, "packages/detect/tests/fixtures/ts-project")

function envWithoutLlmKeys(): NodeJS.ProcessEnv {
  const copy = { ...process.env }
  copy.ANTHROPIC_API_KEY = undefined
  copy.OPENAI_API_KEY = undefined
  copy.GOOGLE_API_KEY = undefined
  return copy
}

function configWithModel(model: string): BollardConfig {
  return {
    llm: {
      default: { provider: "anthropic", model },
      agents: {
        coder: { provider: "anthropic", model },
      },
    },
    agent: { max_cost_usd: 50, max_duration_minutes: 30 },
  }
}

describe("checkModelRegistry", () => {
  it("flags deprecated claude-sonnet-4-20250514 with replacement", () => {
    const health = checkModelRegistry(configWithModel("claude-sonnet-4-20250514"))
    expect(health.deprecatedInUse.length).toBeGreaterThan(0)
    const hit = health.deprecatedInUse.find((d) => d.model === "claude-sonnet-4-20250514")
    expect(hit?.status).toBe("deprecated")
    expect(hit?.replacement).toBe("claude-sonnet-4-6")
  })

  it("reports healthy for all-current defaults", () => {
    const health = checkModelRegistry(configWithModel("claude-sonnet-4-6"))
    expect(health.deprecatedInUse).toEqual([])
    expect(health.unknownInUse).toEqual([])
  })

  it("flags stale entries when now is far in the future", () => {
    const health = checkModelRegistry(configWithModel("claude-sonnet-4-6"), new Date("2030-01-01"))
    expect(health.staleEntries.length).toBeGreaterThan(0)
    expect(health.staleEntries.some((e) => e.id === "claude-sonnet-4-6")).toBe(true)
  })

  it("flags unknown models in config", () => {
    const health = checkModelRegistry(configWithModel("not-a-real-model-id"))
    expect(health.unknownInUse.length).toBeGreaterThan(0)
    expect(health.unknownInUse.some((u) => u.model === "not-a-real-model-id")).toBe(true)
  })
})

describe("formatRegistrySection", () => {
  it("renders healthy message when no issues", () => {
    const text = formatRegistrySection({
      deprecatedInUse: [],
      staleEntries: [],
      unknownInUse: [],
    })
    expect(text).toContain("Registry healthy")
  })

  it("renders stale entry warning", () => {
    const text = formatRegistrySection({
      deprecatedInUse: [],
      staleEntries: [{ id: "claude-sonnet-4-6", verifiedOn: "2026-06-04" }],
      unknownInUse: [],
    })
    expect(text).toContain(`${REGISTRY_STALENESS_DAYS} days old`)
  })
})

describe("runDoctor registry integration", () => {
  it("includes registryHealth and renders healthy for default config", async () => {
    const report = await runDoctor(TS_FIXTURE, envWithoutLlmKeys())
    expect(report.registryHealth).toBeDefined()
    expect(report.registryHealth.deprecatedInUse).toEqual([])
    const formatted = formatDoctorReport(report)
    expect(formatted).toContain("Model registry:")
    expect(formatted).toContain("Registry healthy")
  })
})
