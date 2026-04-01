import type { ToolchainProfile } from "@bollard/detect/src/types.js"

function capitalize(s: string): string {
  if (s.length === 0) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const IF_BLOCK_RE = /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g

function processConditionalBlock(block: string, vars: Record<string, boolean>): string {
  const parts = block.split(/\{\{(?:else if\s+(\w+)|else)\}\}/)

  for (let i = 0; i < parts.length; i += 2) {
    const content = parts[i] ?? ""

    if (i === 0) {
      continue
    }

    const conditionVar = parts[i - 1]
    if (conditionVar === undefined) {
      return content
    }
    if (vars[conditionVar]) {
      return content
    }
  }

  return ""
}

function processConditionals(template: string, vars: Record<string, boolean>): string {
  return template.replace(IF_BLOCK_RE, (_match, firstVar: string, body: string) => {
    if (vars[firstVar]) {
      const elseIdx = body.search(/\{\{(?:else if\s+\w+|else)\}\}/)
      if (elseIdx === -1) {
        return body
      }
      return body.slice(0, elseIdx)
    }

    return processConditionalBlock(body, vars)
  })
}

export function fillPromptTemplate(template: string, profile: ToolchainProfile): string {
  const lang = profile.language
  const conditionVars: Record<string, boolean> = {
    isTypeScript: lang === "typescript",
    isJavaScript: lang === "javascript",
    isPython: lang === "python",
    isGo: lang === "go",
    isRust: lang === "rust",
  }

  let result = processConditionals(template, conditionVars)

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

  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.replaceAll(placeholder, value)
  }
  return result
}
