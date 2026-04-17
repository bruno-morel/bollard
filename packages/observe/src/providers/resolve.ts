import { BollardError } from "@bollard/engine/src/errors.js"

import { FileDeploymentTracker } from "../deployment-tracker.js"
import { GitDriftDetector } from "../drift-detector.js"
import { FileFlagProvider } from "../flag-manager.js"
import { FileMetricsStore } from "../metrics-store.js"
import { HttpProbeExecutor } from "../probe-runner.js"

import type { ObserveProviderConfig, ResolvedObserveOptions, ResolvedProviders } from "./types.js"

function slotProvider(
  slot: { provider: string; config?: Record<string, unknown> } | undefined,
  envName: string,
  fallback: string,
): string {
  if (slot?.provider) return slot.provider
  const e = process.env[envName]
  if (e && e.length > 0) return e
  return fallback
}

export function resolveProviders(
  observeConfig: ObserveProviderConfig | undefined,
  workDir: string,
): ResolvedProviders {
  const probes = slotProvider(observeConfig?.probes, "BOLLARD_PROBE_PROVIDER", "built-in")
  const flags = slotProvider(observeConfig?.flags, "BOLLARD_FLAG_PROVIDER", "built-in")
  const deployments = slotProvider(
    observeConfig?.deployments,
    "BOLLARD_DEPLOYMENT_PROVIDER",
    "built-in",
  )
  const drift = slotProvider(observeConfig?.drift, "BOLLARD_DRIFT_PROVIDER", "built-in")
  const metrics = slotProvider(observeConfig?.metrics, "BOLLARD_METRICS_PROVIDER", "built-in")

  const names = { probes, flags, deployments, drift, metrics }
  for (const [k, v] of Object.entries(names)) {
    if (v !== "built-in") {
      throw new BollardError({
        code: "PROVIDER_NOT_FOUND",
        message: `Observe provider "${v}" for ${k} is not available in Stage 4b (built-in only)`,
        context: { slot: k, provider: v },
      })
    }
  }

  const retentionDays =
    typeof observeConfig?.metrics?.retentionDays === "number"
      ? observeConfig.metrics.retentionDays
      : 30

  const options: ResolvedObserveOptions = {
    workDir,
    ...(observeConfig?.baseUrl !== undefined ? { baseUrl: observeConfig.baseUrl } : {}),
    retentionDays,
  }

  const deploymentTracker = new FileDeploymentTracker(workDir)
  const metricsStore = new FileMetricsStore({ workDir, retentionDays })
  const driftDetector = new GitDriftDetector({
    workDir,
    deploymentTracker,
  })

  return {
    probeExecutor: new HttpProbeExecutor(),
    metricsStore,
    flagProvider: new FileFlagProvider(workDir),
    deploymentTracker,
    driftDetector,
    options,
  }
}
