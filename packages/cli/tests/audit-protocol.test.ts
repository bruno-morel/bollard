import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { detectToolchain } from "@bollard/detect/src/detect.js"
import { afterEach, describe, expect, it } from "vitest"
import { checkProtocolCompliance } from "../src/audit-protocol.js"
import { generateIdeConfigs } from "../src/init-ide.js"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

const COMPLIANT_CONTENT = `
## WHY USE BOLLARD MCP TOOLS

Bollard MCP tools run the correct checks.

## CRITICAL: DO NOT RUN VERIFICATION COMMANDS DIRECTLY

Do NOT run any of the following:
- ❌ \`pnpm run typecheck\`
- ❌ \`pnpm run lint\`
- ❌ \`npx biome check\`

## BEFORE REPORTING COMPLETION — SELF-CHECK

Before telling the user you are done:
- [ ] Did you call \`bollard_verify\` after implementation?
`

describe("checkProtocolCompliance", () => {
  it("passes all 5 checks for fully compliant content", () => {
    const result = checkProtocolCompliance("cursor", COMPLIANT_CONTENT, ".cursor/rules/bollard.mdc")
    expect(result.passed).toBe(true)
    expect(result.score).toBe(5)
    expect(result.checks.every((c) => c.passed)).toBe(true)
  })

  it("fails why-section when WHY header is missing", () => {
    const content = COMPLIANT_CONTENT.replace("## WHY USE BOLLARD MCP TOOLS", "## OVERVIEW")
    const result = checkProtocolCompliance("cursor", content, ".cursor/rules/bollard.mdc")
    const why = result.checks.find((c) => c.id === "why-section")
    expect(why?.passed).toBe(false)
    expect(result.checks.filter((c) => c.passed).length).toBe(4)
  })

  it("fails do-not-list when DO NOT section and examples are missing", () => {
    const content = `
## WHY USE BOLLARD MCP TOOLS
Use Bollard MCP tools.

## BEFORE REPORTING COMPLETION — SELF-CHECK
- [ ] Did you call \`bollard_verify\`?
`
    const result = checkProtocolCompliance("cursor", content, ".cursor/rules/bollard.mdc")
    const doNot = result.checks.find((c) => c.id === "do-not-list")
    expect(doNot?.passed).toBe(false)
  })

  it("fails self-check-section when BEFORE REPORTING COMPLETION is missing", () => {
    const content = COMPLIANT_CONTENT.replace(
      "## BEFORE REPORTING COMPLETION — SELF-CHECK",
      "## DONE CHECKLIST",
    )
    const result = checkProtocolCompliance("cursor", content, ".cursor/rules/bollard.mdc")
    const selfCheck = result.checks.find((c) => c.id === "self-check-section")
    expect(selfCheck?.passed).toBe(false)
  })

  it("fails bollard-verify-reference when self-check has no bollard_verify nearby", () => {
    const content = `
## WHY USE BOLLARD MCP TOOLS
Tools are good.

## CRITICAL: DO NOT RUN VERIFICATION COMMANDS DIRECTLY
- ❌ \`pnpm run typecheck\`
- ❌ \`pnpm run lint\`

## BEFORE REPORTING COMPLETION — SELF-CHECK
- [ ] Did you finish all tasks?
- [ ] Are tests green?
`
    const result = checkProtocolCompliance("cursor", content, ".cursor/rules/bollard.mdc")
    const verifyRef = result.checks.find((c) => c.id === "bollard-verify-reference")
    expect(verifyRef?.passed).toBe(false)
  })

  it("computes score correctly when only 3 checks pass", () => {
    const content = `
## WHY USE BOLLARD MCP TOOLS
Use tools.

## CRITICAL: DO NOT RUN VERIFICATION COMMANDS DIRECTLY
- ❌ \`pnpm run typecheck\`
- ❌ \`pnpm run lint\`
`
    const result = checkProtocolCompliance("cursor", content, ".cursor/rules/bollard.mdc")
    expect(result.score).toBe(3)
    expect(result.passed).toBe(false)
  })
})

describe("checkProtocolCompliance regression", () => {
  it("regression: cursor generator output passes all compliance checks", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "audit-protocol-cursor-"))
    const profile = await detectToolchain(REPO_ROOT)
    const results = await generateIdeConfigs(tempDir, ["cursor"], profile)
    const rulesFile = results[0]?.files.find((f) => f.path.endsWith("bollard.mdc"))
    expect(rulesFile).toBeDefined()

    const result = checkProtocolCompliance(
      "cursor",
      rulesFile?.content ?? "",
      rulesFile?.path ?? "",
    )
    expect(result.passed).toBe(true)
    expect(result.score).toBe(5)
  })

  it("regression: claude-code generator output passes all compliance checks", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "audit-protocol-claude-"))
    const profile = await detectToolchain(REPO_ROOT)
    const results = await generateIdeConfigs(tempDir, ["claude-code"], profile)
    const claudeFile = results[0]?.files.find((f) => f.path === "CLAUDE.md")
    expect(claudeFile).toBeDefined()

    const result = checkProtocolCompliance(
      "claude-code",
      claudeFile?.content ?? "",
      claudeFile?.path ?? "",
    )
    expect(result.passed).toBe(true)
    expect(result.score).toBe(5)
  })
})
