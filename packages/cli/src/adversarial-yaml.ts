import { defaultAdversarialConfig, resolveScopeConcerns } from "@bollard/detect/src/concerns.js"
import type { AdversarialScope, ToolchainProfile } from "@bollard/detect/src/types.js"

/** Parsed root `adversarial` block from .bollard.yml (snake_case fields). */
export interface RootAdversarialYaml {
  concerns?: Partial<Record<"correctness" | "security" | "performance" | "resilience", string>>
  boundary?: ScopeBlockYaml
  contract?: ScopeBlockYaml
  behavioral?: ScopeBlockYaml
}

export interface ScopeBlockYaml {
  enabled?: boolean
  integration?: "integrated" | "independent"
  lifecycle?: "ephemeral" | "persistent"
  mode?: "blackbox" | "in-language" | "both"
  runtime_image?: string
  framework_capable?: boolean
  concerns?: Partial<Record<"correctness" | "security" | "performance" | "resilience", string>>
}

const SCOPES: readonly AdversarialScope[] = ["boundary", "contract", "behavioral"]

function normalizeConcernWeight(
  v: string | undefined,
): "high" | "medium" | "low" | "off" | undefined {
  if (v === undefined) return undefined
  if (v === "high" || v === "medium" || v === "low" || v === "off") return v
  return undefined
}

/** Merge root YAML adversarial config onto profile (spec §4 / §9 resolution). */
export function applyRootAdversarialYaml(
  profile: ToolchainProfile,
  yaml: RootAdversarialYaml,
): void {
  const globalPart: Partial<
    Record<
      "correctness" | "security" | "performance" | "resilience",
      "high" | "medium" | "low" | "off"
    >
  > = {}
  if (yaml.concerns) {
    for (const k of ["correctness", "security", "performance", "resilience"] as const) {
      const w = normalizeConcernWeight(yaml.concerns[k])
      if (w !== undefined) globalPart[k] = w
    }
  }

  for (const scope of SCOPES) {
    const block =
      scope === "boundary" ? yaml.boundary : scope === "contract" ? yaml.contract : yaml.behavioral
    const cur = profile.adversarial[scope]
    const scopeConcernPart: Partial<
      Record<
        "correctness" | "security" | "performance" | "resilience",
        "high" | "medium" | "low" | "off"
      >
    > = {}
    if (block?.concerns) {
      for (const k of ["correctness", "security", "performance", "resilience"] as const) {
        const w = normalizeConcernWeight(block.concerns[k])
        if (w !== undefined) scopeConcernPart[k] = w
      }
    }
    const concerns = resolveScopeConcerns(scope, globalPart, scopeConcernPart)
    const next = { ...cur, concerns }

    if (block) {
      if (block.enabled !== undefined) next.enabled = block.enabled
      if (block.integration !== undefined) next.integration = block.integration
      if (block.lifecycle !== undefined) next.lifecycle = block.lifecycle
      if (block.runtime_image !== undefined) next.runtimeImage = block.runtime_image
      if (block.framework_capable !== undefined) next.frameworkCapable = block.framework_capable
      if (scope === "boundary" && block.mode !== undefined) next.mode = block.mode
    }

    profile.adversarial[scope] = next
  }
}

/** Fields in resolved adversarial that differ from defaultAdversarialConfig(language). */
export function diffAdversarialVsDefaults(profile: ToolchainProfile): Record<string, unknown> {
  const defaults = defaultAdversarialConfig({ language: profile.language })
  const out: Record<string, unknown> = {}
  for (const scope of SCOPES) {
    const a = profile.adversarial[scope]
    const d = defaults[scope]
    const scopeDiff: Record<string, unknown> = {}
    if (a["enabled"] !== d["enabled"]) scopeDiff["enabled"] = a["enabled"]
    if (a["integration"] !== d["integration"]) scopeDiff["integration"] = a["integration"]
    if (a["lifecycle"] !== d["lifecycle"]) scopeDiff["lifecycle"] = a["lifecycle"]
    if (JSON.stringify(a["concerns"]) !== JSON.stringify(d["concerns"]))
      scopeDiff["concerns"] = a["concerns"]
    if (a["frameworkCapable"] !== d["frameworkCapable"])
      scopeDiff["frameworkCapable"] = a["frameworkCapable"]
    if (a["runtimeImage"] !== d["runtimeImage"]) scopeDiff["runtimeImage"] = a["runtimeImage"]
    if (scope === "boundary" && a["mode"] !== d["mode"]) scopeDiff["mode"] = a["mode"]
    if (Object.keys(scopeDiff).length > 0) {
      out[scope] = scopeDiff
    }
  }
  return out
}
