import type { AuditDepsResult, DepsCheckResult } from "@bollard/engine/src/audit-deps.js"
import { auditDeps } from "@bollard/engine/src/audit-deps.js"
import { BOLD, DIM, GREEN, RED, RESET, YELLOW } from "./terminal-styles.js"

export type {
  AuditDepsResult,
  DepsCheckId,
  DepsCheckResult,
  DepsSeverity,
  DepsVulnerability,
} from "@bollard/engine/src/audit-deps.js"

export { auditDeps }

function severitySummary(vulns: DepsCheckResult["vulnerabilities"]): string {
  const counts: Record<string, number> = {}
  for (const v of vulns) {
    counts[v.severity] = (counts[v.severity] ?? 0) + 1
  }
  const order = ["critical", "high", "moderate", "low", "unknown"] as const
  const parts = order.filter((s) => (counts[s] ?? 0) > 0).map((s) => `${counts[s]} ${s}`)
  return parts.join(", ")
}

function formatVulnerabilityLine(vuln: DepsCheckResult["vulnerabilities"][number]): string {
  const parts = [`${vuln.package}@${vuln.version}`, vuln.id, vuln.severity, vuln.manifest]
  if (vuln.fixedVersion) {
    parts.push(`fix: ${vuln.fixedVersion}`)
  }
  return `      ${DIM}${parts.join("  ")}${RESET}`
}

export function formatAuditDepsResult(result: AuditDepsResult): string {
  const lines: string[] = []

  for (const check of result.checks) {
    const icon = check.advisory
      ? `${YELLOW}⚠${RESET}`
      : check.passed
        ? `${GREEN}✓${RESET}`
        : `${RED}✗${RESET}`
    let detail = ""
    if (check.error) {
      detail = ` ${DIM}(${check.error})${RESET}`
    } else if (check.advisory && check.vulnerabilities.length > 0) {
      detail = ` ${DIM}(advisory: ${severitySummary(check.vulnerabilities)})${RESET}`
    } else if (!check.passed && check.vulnerabilities.length > 0) {
      detail = ` ${DIM}(${check.vulnerabilities.length} critical/high)${RESET}`
    }
    lines.push(`  ${icon} ${BOLD}${check.label}${RESET}${detail}`)
    for (const vuln of check.vulnerabilities) {
      lines.push(formatVulnerabilityLine(vuln))
    }
  }

  return lines.join("\n").trimEnd()
}
