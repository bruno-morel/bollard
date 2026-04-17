import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { MetricsStore, ProbeResult, ProbeSummary } from "./providers/types.js"

function dayKey(ts: number): string {
  const d = new Date(ts)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, "0")
  const day = String(d.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)
  return sorted[idx] ?? 0
}

export interface FileMetricsStoreOptions {
  workDir: string
  retentionDays: number
}

export class FileMetricsStore implements MetricsStore {
  private readonly metricsDir: string

  constructor(private readonly opts: FileMetricsStoreOptions) {
    this.metricsDir = join(opts.workDir, ".bollard", "observe", "metrics")
  }

  private async pruneOld(now: number): Promise<void> {
    const cutoff = now - this.opts.retentionDays * 24 * 60 * 60 * 1000
    let names: string[]
    try {
      names = await readdir(this.metricsDir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue
      const day = name.replace(/\.jsonl$/, "")
      const [y, m, d] = day.split("-").map(Number)
      if (!y || !m || !d) continue
      const t = Date.UTC(y, m - 1, d)
      if (t < cutoff) {
        try {
          await unlink(join(this.metricsDir, name))
        } catch {
          /* ignore */
        }
      }
    }
  }

  async record(result: ProbeResult): Promise<void> {
    await mkdir(this.metricsDir, { recursive: true })
    await this.pruneOld(result.timestamp)
    const file = join(this.metricsDir, `${dayKey(result.timestamp)}.jsonl`)
    const line = `${JSON.stringify(result)}\n`
    await writeFile(file, line, { flag: "a" })
  }

  async query(probeId: string, since: number, limit?: number): Promise<ProbeResult[]> {
    const out: ProbeResult[] = []
    let names: string[]
    try {
      names = (await readdir(this.metricsDir)).filter((n) => n.endsWith(".jsonl")).sort()
    } catch {
      return []
    }
    for (const name of names) {
      const day = name.replace(/\.jsonl$/, "")
      const [y, m, d] = day.split("-").map(Number)
      if (!y || !m || !d) continue
      const dayStart = Date.UTC(y, m - 1, d)
      if (dayStart + 86400000 < since) continue
      let content: string
      try {
        content = await readFile(join(this.metricsDir, name), "utf-8")
      } catch {
        continue
      }
      for (const line of content.split("\n")) {
        if (!line.trim()) continue
        try {
          const row = JSON.parse(line) as ProbeResult
          if (row.probeId === probeId && row.timestamp >= since) {
            out.push(row)
          }
        } catch {
          /* skip bad line */
        }
      }
    }
    out.sort((a, b) => a.timestamp - b.timestamp)
    if (limit !== undefined && out.length > limit) {
      return out.slice(-limit)
    }
    return out
  }

  async summary(probeId: string, windowMs: number): Promise<ProbeSummary> {
    const since = Date.now() - windowMs
    const rows = await this.query(probeId, since)
    const latencies = rows.map((r) => r.latencyMs).sort((a, b) => a - b)
    const passed = rows.filter((r) => r.status === "pass").length
    const failed = rows.filter((r) => r.status === "fail").length
    const sum = latencies.reduce((a, b) => a + b, 0)
    return {
      probeId,
      windowMs,
      total: rows.length,
      passed,
      failed,
      avgLatencyMs: rows.length === 0 ? 0 : sum / rows.length,
      p99LatencyMs: percentile(latencies, 0.99),
    }
  }
}
