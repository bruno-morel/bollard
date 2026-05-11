import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import type {
  AuditDetail,
  ChurnScore,
  ComplexityReport,
  CoverageDelta,
  ProbePerfReport,
  SastReport,
} from "./code-metrics.js"
import { extractCodeMetricParts } from "./code-metrics.js"

export interface CodeMetrics {
  coverage: CoverageDelta
  complexity: ComplexityReport
  sast: SastReport
  churn: ChurnScore[]
  audit: AuditDetail
  probePerf: ProbePerfReport
  durationMs: number
}

const EMPTY_METRICS: Omit<CodeMetrics, "durationMs"> = {
  coverage: { tool: "none", changedFiles: [], overallPct: null, note: "metrics unavailable" },
  complexity: { hotspots: [], maxDecisionPoints: 0, filesAnalysed: 0 },
  sast: { findings: [], patternsChecked: 0, filesScanned: 0, tool: "rg" },
  churn: [],
  audit: { tool: "none", criticalCount: 0, highCount: 0, details: [] },
  probePerf: { probes: [], windowMs: 0, source: "none" },
}

function timeout<T>(ms: number): Promise<T> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`code metrics timed out after ${ms}ms`)), ms)
  })
}

export async function extractCodeMetrics(
  workDir: string,
  diff: string,
  changedFiles: string[],
  profile: ToolchainProfile,
  warn: (msg: string, data?: unknown) => void,
): Promise<CodeMetrics> {
  const startMs = Date.now()
  try {
    const parts = await Promise.race([
      extractCodeMetricParts(workDir, diff, changedFiles, profile),
      timeout<Awaited<ReturnType<typeof extractCodeMetricParts>>>(90_000),
    ])
    return {
      ...parts,
      durationMs: Date.now() - startMs,
    }
  } catch (err: unknown) {
    warn("extract-code-metrics: degrading to empty metrics", {
      error: err instanceof Error ? err.message : String(err),
    })
    return {
      ...EMPTY_METRICS,
      durationMs: Date.now() - startMs,
    }
  }
}
