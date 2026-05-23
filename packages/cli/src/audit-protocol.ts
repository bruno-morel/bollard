import { randomUUID } from "node:crypto"
import { readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { detectToolchain } from "@bollard/detect/src/detect.js"
import { generateIdeConfigs, writeGeneratedFiles } from "./init-ide.js"
import { BOLD, DIM, GREEN, RED, RESET } from "./terminal-styles.js"

export type ComplianceCheckId =
  | "why-section"
  | "do-not-list"
  | "self-check-section"
  | "bollard-verify-reference"
  | "no-raw-command-encouragement"

export interface ComplianceCheckResult {
  id: ComplianceCheckId
  label: string
  passed: boolean
  evidence?: string
}

export interface PlatformComplianceResult {
  platform: "cursor" | "claude-code"
  score: number
  maxScore: number
  passed: boolean
  checks: ComplianceCheckResult[]
  configPath: string
}

export interface AuditProtocolResult {
  allPassed: boolean
  platforms: PlatformComplianceResult[]
}

const COMMAND_EXAMPLES = ["pnpm run typecheck", "pnpm run lint", "biome", "npx tsc"] as const

const SELF_CHECK_HEADER = "BEFORE REPORTING COMPLETION"
const WHY_HEADER = "WHY USE BOLLARD MCP TOOLS"

function countCommandExamples(content: string): number {
  const lower = content.toLowerCase()
  return COMMAND_EXAMPLES.filter((cmd) => lower.includes(cmd.toLowerCase())).length
}

function hasDoNotHeader(content: string): boolean {
  if (content.includes("DO NOT RUN VERIFICATION COMMANDS DIRECTLY")) return true
  if (/DO NOT.*direct/i.test(content)) return true
  if (/DO NOT run/i.test(content)) return true
  return false
}

function checkWhySection(content: string): ComplianceCheckResult {
  const passed = content.toLowerCase().includes(WHY_HEADER.toLowerCase())
  return {
    id: "why-section",
    label: "WHY section present",
    passed,
    ...(passed ? {} : { evidence: "Missing '## WHY USE BOLLARD MCP TOOLS' section" }),
  }
}

function checkDoNotList(content: string): ComplianceCheckResult {
  const hasHeader = hasDoNotHeader(content)
  const exampleCount = countCommandExamples(content)
  const passed = hasHeader && exampleCount >= 2
  return {
    id: "do-not-list",
    label: "DO NOT list with specific commands",
    passed,
    ...(passed ? {} : { evidence: "Missing DO NOT list or specific command examples" }),
  }
}

function checkSelfCheckSection(content: string): ComplianceCheckResult {
  const passed = content.toLowerCase().includes(SELF_CHECK_HEADER.toLowerCase())
  return {
    id: "self-check-section",
    label: "BEFORE REPORTING COMPLETION self-check present",
    passed,
    ...(passed ? {} : { evidence: "Missing 'BEFORE REPORTING COMPLETION' section" }),
  }
}

function checkBollardVerifyReference(content: string): ComplianceCheckResult {
  const idx = content.toLowerCase().indexOf(SELF_CHECK_HEADER.toLowerCase())
  if (idx === -1) {
    return {
      id: "bollard-verify-reference",
      label: "Self-check references bollard_verify",
      passed: false,
      evidence: "Self-check section does not reference bollard_verify",
    }
  }
  const region = content.slice(idx, idx + 800)
  const passed = region.includes("bollard_verify")
  return {
    id: "bollard-verify-reference",
    label: "Self-check references bollard_verify",
    passed,
    ...(passed ? {} : { evidence: "Self-check section does not reference bollard_verify" }),
  }
}

function isInNegationContext(content: string, matchIndex: number): boolean {
  const before = content.slice(Math.max(0, matchIndex - 120), matchIndex)
  if (before.includes("❌")) return true
  if (/DO NOT/i.test(before)) return true
  return false
}

function checkNoRawCommandEncouragement(content: string): ComplianceCheckResult {
  const encouragementPatterns = [/run pnpm typecheck/i, /run pnpm lint/i, /execute.*tsc/i]

  for (const pattern of encouragementPatterns) {
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes("i") ? "gi" : "g")
    let match = globalPattern.exec(content)
    while (match !== null) {
      if (!isInNegationContext(content, match.index)) {
        return {
          id: "no-raw-command-encouragement",
          label: "No encouragement of raw verification commands",
          passed: false,
          evidence: `Found encouragement pattern: ${match[0]}`,
        }
      }
      match = globalPattern.exec(content)
    }
  }

  return {
    id: "no-raw-command-encouragement",
    label: "No encouragement of raw verification commands",
    passed: true,
  }
}

export function checkProtocolCompliance(
  platform: "cursor" | "claude-code",
  content: string,
  configPath: string,
): PlatformComplianceResult {
  const checks: ComplianceCheckResult[] = [
    checkWhySection(content),
    checkDoNotList(content),
    checkSelfCheckSection(content),
    checkBollardVerifyReference(content),
    checkNoRawCommandEncouragement(content),
  ]

  const score = checks.filter((c) => c.passed).length
  const maxScore = 5

  return {
    platform,
    score,
    maxScore,
    passed: score === maxScore,
    checks,
    configPath,
  }
}

function findProtocolFile(
  platform: "cursor" | "claude-code",
  files: { path: string; content: string }[],
): { path: string; content: string } | undefined {
  if (platform === "cursor") {
    return files.find((f) => f.path.endsWith("bollard.mdc"))
  }
  return files.find((f) => f.path === "CLAUDE.md" || f.path.endsWith("/CLAUDE.md"))
}

function generationFailedResult(
  platform: "cursor" | "claude-code",
  configPath: string,
  message: string,
): PlatformComplianceResult {
  return {
    platform,
    score: 0,
    maxScore: 5,
    passed: false,
    configPath,
    checks: [
      {
        id: "why-section",
        label: "WHY section present",
        passed: false,
        evidence: `Config generation failed: ${message}`,
      },
    ],
  }
}

async function auditPlatform(
  tempDir: string,
  platform: "cursor" | "claude-code",
  profile: Awaited<ReturnType<typeof detectToolchain>>,
): Promise<PlatformComplianceResult> {
  const defaultPath = platform === "cursor" ? ".cursor/rules/bollard.mdc" : "CLAUDE.md"

  try {
    const results = await generateIdeConfigs(tempDir, [platform], profile)
    const result = results[0]
    if (!result || result.files.length === 0) {
      return generationFailedResult(platform, defaultPath, "no files generated")
    }

    await writeGeneratedFiles(tempDir, result)

    const protocolFile = findProtocolFile(platform, result.files)
    if (!protocolFile) {
      return generationFailedResult(
        platform,
        defaultPath,
        "protocol file not found in generator output",
      )
    }

    const content = await readFile(join(tempDir, protocolFile.path), "utf-8")
    return checkProtocolCompliance(platform, content, protocolFile.path)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return generationFailedResult(platform, defaultPath, message)
  }
}

export async function auditProtocol(workDir: string): Promise<AuditProtocolResult> {
  const tempDir = join(tmpdir(), randomUUID())

  try {
    const profile = await detectToolchain(workDir)
    const cursor = await auditPlatform(tempDir, "cursor", profile)
    const claudeCode = await auditPlatform(tempDir, "claude-code", profile)
    const platforms = [cursor, claudeCode]

    return {
      allPassed: platforms.every((p) => p.passed),
      platforms,
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export function formatAuditResult(result: AuditProtocolResult): string {
  const lines: string[] = []

  for (const platform of result.platforms) {
    const icon = platform.passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`
    lines.push(
      `  ${icon} ${BOLD}${platform.platform}${RESET} (${platform.score}/${platform.maxScore}) ${DIM}—${RESET} ${platform.configPath}`,
    )
    for (const check of platform.checks) {
      const checkIcon = check.passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`
      const evidence =
        !check.passed && check.evidence !== undefined ? ` ${DIM}(${check.evidence})${RESET}` : ""
      lines.push(`    ${checkIcon} ${check.label}${evidence}`)
    }
    lines.push("")
  }

  return lines.join("\n").trimEnd()
}
