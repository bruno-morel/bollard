import type { ToolchainProfile } from "@bollard/detect/src/types.js"

function capitalize(s: string): string {
  if (s.length === 0) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function fillPromptTemplate(template: string, profile: ToolchainProfile): string {
  const replacements: Record<string, string> = {
    "{{language}}": capitalize(profile.language),
    "{{packageManager}}": profile.packageManager ?? "none",
    "{{typecheck}}": profile.checks.typecheck?.label ?? "none",
    "{{linter}}": profile.checks.lint?.label ?? "none",
    "{{testFramework}}": profile.checks.test?.label ?? "none",
    "{{auditTool}}": profile.checks.audit?.label ?? "none",
    "{{allowedCommands}}": profile.allowedCommands.join(", "),
    "{{sourcePatterns}}": profile.sourcePatterns.join(", "),
    "{{testPatterns}}": profile.testPatterns.join(", "),
  }

  let result = template
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.replaceAll(placeholder, value)
  }
  return result
}
