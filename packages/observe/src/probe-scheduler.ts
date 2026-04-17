import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

import type { ProbeDefinition } from "@bollard/engine/src/blueprint.js"

import { HttpProbeExecutor } from "./probe-runner.js"
import type {
  ProbeExecutor,
  ProbeResult,
  ProbeRunSummary,
  ProbeScheduler,
  ProbeWatchHandle,
} from "./providers/types.js"

export interface DefaultProbeSchedulerOptions {
  workDir: string
  executor?: ProbeExecutor
}

export class DefaultProbeScheduler implements ProbeScheduler {
  private readonly workDir: string
  private readonly executor: ProbeExecutor

  constructor(opts: DefaultProbeSchedulerOptions) {
    this.workDir = opts.workDir
    this.executor = opts.executor ?? new HttpProbeExecutor()
  }

  async loadProbes(): Promise<ProbeDefinition[]> {
    const dir = join(this.workDir, ".bollard", "probes")
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    const out: ProbeDefinition[] = []
    for (const name of names) {
      if (!name.endsWith(".json")) continue
      try {
        const raw = await readFile(join(dir, name), "utf-8")
        const p = JSON.parse(raw) as ProbeDefinition
        out.push(p)
      } catch {
        /* skip */
      }
    }
    return out
  }

  async runOnce(baseUrl: string): Promise<ProbeRunSummary> {
    const probes = await this.loadProbes()
    const started = Date.now()
    const results: ProbeResult[] = []
    let passed = 0
    let failed = 0
    for (const probe of probes) {
      const r = await this.executor.execute(probe, baseUrl)
      results.push(r)
      if (r.status === "pass") passed++
      else failed++
    }
    return {
      total: results.length,
      passed,
      failed,
      results,
      duration_ms: Date.now() - started,
    }
  }

  watch(baseUrl: string, onResult: (result: ProbeResult) => void): ProbeWatchHandle {
    const timers: NodeJS.Timeout[] = []
    let cancelled = false

    void (async () => {
      const probes = await this.loadProbes()
      for (const probe of probes) {
        const ms = Math.max(1000, probe.intervalSeconds * 1000)
        const tick = async () => {
          if (cancelled) return
          try {
            const r = await this.executor.execute(probe, baseUrl)
            onResult(r)
          } catch {
            /* executor may throw; surface via callback in future */
          }
        }
        timers.push(setInterval(() => void tick(), ms))
        void tick()
      }
    })()

    return {
      stop: () => {
        cancelled = true
        for (const t of timers) {
          clearInterval(t)
        }
      },
    }
  }
}
