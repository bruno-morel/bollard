import type { AuditDocsResult } from "@bollard/engine/src/audit-docs.js"
import {
  auditDocs,
  checkAdrLinks,
  checkMcpToolCount,
  checkSpecDocLinks,
  checkTestCountConsistency,
  countMcpToolsFromSource,
} from "@bollard/engine/src/audit-docs.js"
import { BOLD, DIM, GREEN, RED, RESET } from "./terminal-styles.js"

export type {
  AuditDocsResult,
  DocsCheckId,
  DocsCheckResult,
} from "@bollard/engine/src/audit-docs.js"

export {
  auditDocs,
  checkAdrLinks,
  checkMcpToolCount,
  checkSpecDocLinks,
  checkTestCountConsistency,
  countMcpToolsFromSource,
}

export function formatAuditDocsResult(result: AuditDocsResult): string {
  const lines: string[] = []

  for (const check of result.checks) {
    const icon = check.passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`
    let detail = ""
    if (!check.passed) {
      const parts: string[] = []
      if (check.expected !== undefined) parts.push(`expected: ${check.expected}`)
      if (check.actual !== undefined) parts.push(`actual: ${check.actual}`)
      if (parts.length > 0) detail = ` ${DIM}(${parts.join(", ")})${RESET}`
    }
    lines.push(`  ${icon} ${BOLD}${check.label}${RESET}${detail}`)
  }

  return lines.join("\n").trimEnd()
}
