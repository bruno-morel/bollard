import type { ConcernConfig, ToolchainProfile } from "@bollard/detect/src/types.js"

function capitalize(s: string): string {
  if (s.length === 0) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const IF_BLOCK_RE = /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g

const CONCERN_KEYS: (keyof ConcernConfig)[] = [
  "correctness",
  "security",
  "performance",
  "resilience",
]

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function weightDisplay(w: ConcernConfig[keyof ConcernConfig]): string {
  if (w === "high") return "HIGH"
  if (w === "medium") return "MEDIUM"
  if (w === "low") return "LOW"
  return "OFF"
}

/** Spec §4 / §9: strip or render weighted concern sections in agent prompts. */
function processConcernBlocks(template: string, scopeConcerns?: ConcernConfig): string {
  if (!scopeConcerns) {
    let t = template.replace(/\{\{#concern\s+(\w+)\}\}[\s\S]*?\{\{\/concern\}\}/g, "")
    t = t.replace(/^[\t ]*###[^\n]*\{\{concerns\.\w+\.weight\}\}[^\n]*\n/gm, "")
    t = t.replace(/\{\{concerns\.\w+\.weight\}\}/g, "")
    return t
  }

  let t = template
  for (const name of CONCERN_KEYS) {
    const w = scopeConcerns[name]
    const ph = `{{concerns.${name}.weight}}`
    if (w === "off") {
      const re = new RegExp(
        `^[ \\t]*###[^\\n]*${escapeRegExp(ph)}[^\\n]*\\n(?:[ \\t]*\\{\\{#concern ${name}\\}\\}[\\s\\S]*?\\{\\{/concern\\}\\}\\s*\\n?)?`,
        "gm",
      )
      t = t.replace(re, "")
    } else {
      t = t.split(ph).join(weightDisplay(w))
    }
  }
  t = t.replace(/\{\{#concern\s+\w+\}\}\s*/g, "")
  t = t.replace(/\s*\{\{\/concern\}\}/g, "")
  return t
}

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

export function fillPromptTemplate(
  template: string,
  profile: ToolchainProfile,
  scopeConcerns?: ConcernConfig,
): string {
  const lang = profile.language
  const conditionVars: Record<string, boolean> = {
    isTypeScript: lang === "typescript",
    isJavaScript: lang === "javascript",
    isPython: lang === "python",
    isGo: lang === "go",
    isRust: lang === "rust",
    isJava: lang === "java",
    isKotlin: lang === "kotlin",
  }

  let result = processConditionals(template, conditionVars)
  result = processConcernBlocks(result, scopeConcerns)

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
