import type {
  AdversarialConcern,
  AdversarialConfig,
  AdversarialScope,
  AdversarialScopeConfig,
  ConcernConfig,
  ConcernWeight,
  LanguageId,
} from "./types.js"

export const ADVERSARIAL_CONCERNS: readonly AdversarialConcern[] = [
  "correctness",
  "security",
  "performance",
  "resilience",
]

export const ADVERSARIAL_SCOPES: readonly AdversarialScope[] = [
  "boundary",
  "contract",
  "behavioral",
]

export const DEFAULT_CONCERN_WEIGHTS: Record<AdversarialScope, ConcernConfig> = {
  boundary: {
    correctness: "high",
    security: "high",
    performance: "low",
    resilience: "low",
  },
  contract: {
    correctness: "high",
    security: "medium",
    performance: "medium",
    resilience: "medium",
  },
  behavioral: {
    correctness: "medium",
    security: "high",
    performance: "high",
    resilience: "high",
  },
}

/** True when Stage 3a deterministic contract extraction exists for the language. */
export function contractFrameworkCapable(language: LanguageId): boolean {
  return (
    language === "typescript" || language === "python" || language === "go" || language === "rust"
  )
}

export function withBoundaryOverrides(
  language: LanguageId,
  boundaryPatch: Partial<AdversarialScopeConfig>,
): AdversarialConfig {
  const base = defaultAdversarialConfig({ language })
  return {
    ...base,
    boundary: { ...base.boundary, ...boundaryPatch },
  }
}

export function defaultAdversarialConfig(profile: { language: LanguageId }): AdversarialConfig {
  const fw = contractFrameworkCapable(profile.language)
  return {
    boundary: {
      enabled: true,
      integration: "integrated",
      lifecycle: "persistent",
      concerns: { ...DEFAULT_CONCERN_WEIGHTS.boundary },
      frameworkCapable: true,
      mode: "in-language",
    },
    contract: {
      enabled: true,
      integration: "integrated",
      lifecycle: "persistent",
      concerns: { ...DEFAULT_CONCERN_WEIGHTS.contract },
      frameworkCapable: fw,
    },
    behavioral: {
      enabled: false,
      integration: "independent",
      lifecycle: "ephemeral",
      concerns: { ...DEFAULT_CONCERN_WEIGHTS.behavioral },
      frameworkCapable: false,
    },
  }
}

/** Per spec §9: scope YAML concern → global YAML concern → default matrix (see spec §4). */
export function resolveScopeConcerns(
  scope: AdversarialScope,
  globalPartial: Partial<Record<AdversarialConcern, ConcernWeight>> | undefined,
  scopePartial: Partial<Record<AdversarialConcern, ConcernWeight>> | undefined,
): ConcernConfig {
  const defaults = DEFAULT_CONCERN_WEIGHTS[scope]
  const out: ConcernConfig = { ...defaults }
  for (const c of ADVERSARIAL_CONCERNS) {
    const v = scopePartial?.[c] ?? globalPartial?.[c] ?? defaults[c]
    out[c] = v
  }
  return out
}
