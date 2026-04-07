import { defaultAdversarialConfig } from "@bollard/detect/src/concerns.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { describe, expect, it } from "vitest"
import { createContractTesterAgent } from "../src/contract-tester.js"

const TS_PROFILE: ToolchainProfile = {
  language: "typescript",
  packageManager: "pnpm",
  checks: {
    test: { label: "Vitest", cmd: "pnpm", args: ["run", "test"], source: "auto-detected" },
  },
  sourcePatterns: ["**/*.ts"],
  testPatterns: ["**/*.test.ts"],
  ignorePatterns: [],
  allowedCommands: ["pnpm"],
  adversarial: defaultAdversarialConfig({ language: "typescript" }),
}

describe("createContractTesterAgent", () => {
  it("loads prompt and sets role and tuning per spec §6", async () => {
    const agent = await createContractTesterAgent(TS_PROFILE)
    expect(agent.role).toBe("contract-tester")
    expect(agent.tools).toHaveLength(0)
    expect(agent.maxTurns).toBe(10)
    expect(agent.temperature).toBe(0.4)
  })

  it("renders contract concern sections with weights", async () => {
    const agent = await createContractTesterAgent(TS_PROFILE)
    expect(agent.systemPrompt).toContain("### Correctness [HIGH]")
    expect(agent.systemPrompt).toContain("providerErrors vs consumerCatches")
  })
})
