import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { BollardError } from "@bollard/engine/src/errors.js"
import { describe, expect, it } from "vitest"

import { resolveProviders } from "../src/providers/resolve.js"

describe("resolveProviders", () => {
  it("returns built-in providers", async () => {
    const root = join(process.cwd(), `.bollard-prov-${Date.now()}`)
    await mkdir(root, { recursive: true })
    const r = resolveProviders(undefined, root)
    expect(r.probeExecutor).toBeDefined()
    expect(r.metricsStore).toBeDefined()
    expect(r.flagProvider).toBeDefined()
    expect(r.deploymentTracker).toBeDefined()
    expect(r.driftDetector).toBeDefined()
    await rm(root, { recursive: true, force: true })
  })

  it("throws PROVIDER_NOT_FOUND for unknown", () => {
    const root = join(process.cwd(), `.bollard-prov2-${Date.now()}`)
    expect(() =>
      resolveProviders({ probes: { provider: "datadog", config: {} } }, root),
    ).toThrowError(BollardError)
  })
})
