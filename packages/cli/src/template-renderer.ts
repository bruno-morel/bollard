import type { ToolchainProfile } from "@bollard/detect/src/types.js"

function capitalize(s: string): string {
  if (s.length === 0) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function cmdString(check?: { cmd: string; args: string[] }): string {
  if (!check) return ""
  return `${check.cmd} ${check.args.join(" ")}`.trim()
}

const IF_BLOCK_RE = /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g

export function renderTemplate(template: string, profile: ToolchainProfile): string {
  const lang = profile.language
  const conditions: Record<string, boolean> = {
    isTypeScript: lang === "typescript",
    isJavaScript: lang === "javascript",
    isPython: lang === "python",
    isGo: lang === "go",
    isRust: lang === "rust",
    isJava: lang === "java",
    isKotlin: lang === "kotlin",
    hasTypecheck: profile.checks.typecheck !== undefined,
    hasLint: profile.checks.lint !== undefined,
    hasTest: profile.checks.test !== undefined,
    hasAudit: profile.checks.audit !== undefined,
    hasSecretScan: profile.checks.secretScan !== undefined,
    hasMutation: profile.mutation?.enabled === true,
  }

  let result = template.replace(IF_BLOCK_RE, (_match, varName: string, body: string) => {
    return conditions[varName] ? body : ""
  })

  const replacements: Record<string, string> = {
    "{{language}}": capitalize(lang),
    "{{languageId}}": lang,
    "{{packageManager}}": profile.packageManager ?? "none",
    "{{typecheck}}": profile.checks.typecheck?.label ?? "none",
    "{{typecheckCmd}}": cmdString(profile.checks.typecheck),
    "{{linter}}": profile.checks.lint?.label ?? "none",
    "{{lintCmd}}": cmdString(profile.checks.lint),
    "{{testFramework}}": profile.checks.test?.label ?? "none",
    "{{testCmd}}": cmdString(profile.checks.test),
    "{{auditTool}}": profile.checks.audit?.label ?? "none",
    "{{auditCmd}}": cmdString(profile.checks.audit),
    "{{secretScan}}": profile.checks.secretScan?.label ?? "none",
    "{{sourcePatterns}}": profile.sourcePatterns.join(", "),
    "{{testPatterns}}": profile.testPatterns.join(", "),
  }

  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.replaceAll(placeholder, value)
  }
  return result
}
