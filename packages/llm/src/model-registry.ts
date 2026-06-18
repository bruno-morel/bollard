import { BollardError } from "@bollard/engine/src/errors.js"
import { type ModelRequirements, ROLE_REQUIREMENTS } from "./role-requirements.js"

export type CapabilityLevel = "frontier" | "standard" | "light"

export interface ModelCapabilities {
  reasoning: CapabilityLevel
  codegen: CapabilityLevel
  toolUse: boolean
  streaming: boolean
  contextWindow: number
  maxOutput: number
}

export interface ModelPricing {
  /** USD per 1M tokens. */
  input: number
  output: number
  cacheRead?: number
  cacheWrite5m?: number
}

export type ModelStatus = "current" | "deprecated" | "retired"

export interface ModelRegistryEntry {
  id: string
  provider: "anthropic" | "openai" | "google" | "local"
  status: ModelStatus
  capabilities: ModelCapabilities
  pricing: ModelPricing
  /** ISO date this entry was last checked against vendor docs. */
  verifiedOn: string
  notes?: string
}

const VERIFIED_ON = "2026-06-04"

const frontierCaps = (contextWindow: number, maxOutput: number): ModelCapabilities => ({
  reasoning: "frontier",
  codegen: "frontier",
  toolUse: true,
  streaming: true,
  contextWindow,
  maxOutput,
})

const standardCaps = (contextWindow: number, maxOutput: number): ModelCapabilities => ({
  reasoning: "standard",
  codegen: "standard",
  toolUse: true,
  streaming: true,
  contextWindow,
  maxOutput,
})

const lightCaps = (contextWindow: number, maxOutput: number): ModelCapabilities => ({
  reasoning: "light",
  codegen: "light",
  toolUse: true,
  streaming: true,
  contextWindow,
  maxOutput,
})

export const MODEL_REGISTRY: ModelRegistryEntry[] = [
  {
    id: "claude-opus-4-8",
    provider: "anthropic",
    status: "current",
    capabilities: frontierCaps(1_000_000, 32_000),
    pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25 },
    verifiedOn: VERIFIED_ON,
    notes: "88.6% SWE-bench Verified; tokenizer emits up to ~35% more tokens",
  },
  {
    id: "claude-opus-4-6",
    provider: "anthropic",
    status: "current",
    capabilities: frontierCaps(1_000_000, 32_000),
    pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25 },
    verifiedOn: VERIFIED_ON,
  },
  {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    status: "current",
    capabilities: frontierCaps(1_000_000, 64_000),
    pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75 },
    verifiedOn: VERIFIED_ON,
    notes: "79.6% SWE-bench Verified; best $/quality for agentic coding",
  },
  {
    id: "claude-sonnet-4-5-20250929",
    provider: "anthropic",
    status: "current",
    capabilities: standardCaps(200_000, 64_000),
    pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75 },
    verifiedOn: VERIFIED_ON,
  },
  {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    status: "current",
    capabilities: standardCaps(200_000, 64_000),
    pricing: { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25 },
    verifiedOn: VERIFIED_ON,
  },
  {
    id: "claude-sonnet-4-20250514",
    provider: "anthropic",
    status: "deprecated",
    capabilities: standardCaps(200_000, 64_000),
    pricing: { input: 3, output: 15 },
    verifiedOn: VERIFIED_ON,
    notes: "deprecated upstream; replaced by claude-sonnet-4-6",
  },
  {
    id: "claude-opus-4-20250514",
    provider: "anthropic",
    status: "deprecated",
    capabilities: {
      reasoning: "frontier",
      codegen: "standard",
      toolUse: true,
      streaming: true,
      contextWindow: 200_000,
      maxOutput: 32_000,
    },
    pricing: { input: 15, output: 75 },
    verifiedOn: VERIFIED_ON,
  },
  {
    id: "gpt-4o",
    provider: "openai",
    status: "current",
    capabilities: standardCaps(128_000, 16_384),
    pricing: { input: 2.5, output: 10 },
    verifiedOn: VERIFIED_ON,
  },
  {
    id: "gpt-4o-mini",
    provider: "openai",
    status: "current",
    capabilities: lightCaps(128_000, 16_384),
    pricing: { input: 0.15, output: 0.6 },
    verifiedOn: VERIFIED_ON,
  },
  {
    id: "o3-mini",
    provider: "openai",
    status: "current",
    capabilities: {
      reasoning: "standard",
      codegen: "light",
      toolUse: true,
      streaming: true,
      contextWindow: 200_000,
      maxOutput: 100_000,
    },
    pricing: { input: 1.1, output: 4.4 },
    verifiedOn: VERIFIED_ON,
  },
  {
    id: "gemini-2.0-flash",
    provider: "google",
    status: "current",
    capabilities: lightCaps(1_000_000, 8_192),
    pricing: { input: 0.1, output: 0.4 },
    verifiedOn: VERIFIED_ON,
  },
  {
    id: "gemini-2.5-pro-preview-05-06",
    provider: "google",
    status: "current",
    capabilities: standardCaps(1_000_000, 65_536),
    pricing: { input: 1.25, output: 10 },
    verifiedOn: VERIFIED_ON,
  },
  {
    id: "qwen2.5-coder-1.5b-q4",
    provider: "local",
    status: "current",
    capabilities: {
      reasoning: "light",
      codegen: "light",
      toolUse: false,
      streaming: true,
      contextWindow: 32_000,
      maxOutput: 4_096,
    },
    pricing: { input: 0, output: 0 },
    verifiedOn: VERIFIED_ON,
    notes: "local tier-2 (ADR-0004), patcher only",
  },
]

const warnedUnknownModels = new Set<string>()

export function findModelEntry(id: string): ModelRegistryEntry | undefined {
  return MODEL_REGISTRY.find((entry) => entry.id === id)
}

export function registryEntriesForProvider(provider: string): ModelRegistryEntry[] {
  return MODEL_REGISTRY.filter((entry) => entry.provider === provider)
}

const CAPABILITY_RANK: Record<CapabilityLevel, number> = {
  light: 0,
  standard: 1,
  frontier: 2,
}

export function capabilityRank(level: CapabilityLevel): number {
  return CAPABILITY_RANK[level]
}

export function modelSatisfiesRequirements(
  entry: ModelRegistryEntry,
  req: ModelRequirements,
): boolean {
  const caps = entry.capabilities
  if (capabilityRank(caps.reasoning) < capabilityRank(req.reasoning)) return false
  if (capabilityRank(caps.codegen) < capabilityRank(req.codegen)) return false
  if (req.needsToolUse && !caps.toolUse) return false
  if (caps.contextWindow < req.minContext) return false
  if (caps.maxOutput < req.minOutput) return false
  return true
}

/**
 * Cheapest current model of `provider` satisfying the role's requirements.
 * Returns undefined when the role has no requirements entry or the provider
 * has zero registry entries (caller falls back to llm.default).
 * Throws MODEL_NOT_AVAILABLE when the provider is known but no current model satisfies.
 */
export function resolveModelForRole(
  role: string,
  provider: string,
  registry: ModelRegistryEntry[] = MODEL_REGISTRY,
): ModelRegistryEntry | undefined {
  const req = ROLE_REQUIREMENTS[role]
  if (req === undefined) return undefined

  const currentEntries = registry.filter(
    (entry) => entry.provider === provider && entry.status === "current",
  )
  if (currentEntries.length === 0) return undefined

  const satisfying = currentEntries.filter((entry) => modelSatisfiesRequirements(entry, req))
  if (satisfying.length === 0) {
    throw new BollardError({
      code: "MODEL_NOT_AVAILABLE",
      message: `No current ${provider} model satisfies requirements for role "${role}"`,
      context: { role, provider, requirements: req },
    })
  }

  satisfying.sort((a, b) => {
    const outputDiff = a.pricing.output - b.pricing.output
    if (outputDiff !== 0) return outputDiff
    const inputDiff = a.pricing.input - b.pricing.input
    if (inputDiff !== 0) return inputDiff
    return b.verifiedOn.localeCompare(a.verifiedOn)
  })

  return satisfying[0]
}

/**
 * Single cost estimator for all providers. Unknown model: uses the provided
 * fallback pricing (never zero) and emits ONE stderr warning per model id per
 * process.
 */
export function estimateCostForModel(
  model: string,
  inputTokens: number,
  outputTokens: number,
  fallback: ModelPricing,
): number {
  const entry = findModelEntry(model)
  const pricing = entry?.pricing ?? fallback
  if (entry === undefined && !warnedUnknownModels.has(model)) {
    warnedUnknownModels.add(model)
    process.stderr.write(
      `[bollard] unknown model "${model}" — cost estimates use fallback pricing; add it to model-registry.ts\n`,
    )
  }
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000
}
