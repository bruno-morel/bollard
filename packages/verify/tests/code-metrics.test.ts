import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { describe, expect, it } from "vitest"
import {
  aggregateProbePerf,
  buildSastFindingsFromContent,
  computeChurnScore,
  extractComplexityFromDiff,
  extractCoverageDelta,
  generateK6Script,
  parsePnpmAuditJson,
} from "../src/code-metrics.js"

function makeProfile(language: ToolchainProfile["language"] = "typescript"): ToolchainProfile {
  return {
    language,
    packageManager: "pnpm",
    checks: {},
    sourcePatterns: ["**/*.ts"],
    testPatterns: ["**/*.test.ts"],
    ignorePatterns: [],
    allowedCommands: ["pnpm"],
    adversarial: {
      boundary: {
        enabled: true,
        integration: "independent",
        lifecycle: "ephemeral",
        concerns: {
          correctness: "high",
          security: "medium",
          performance: "low",
          resilience: "off",
        },
      },
      contract: {
        enabled: false,
        integration: "independent",
        lifecycle: "ephemeral",
        concerns: {
          correctness: "high",
          security: "medium",
          performance: "low",
          resilience: "off",
        },
      },
      behavioral: {
        enabled: false,
        integration: "independent",
        lifecycle: "ephemeral",
        concerns: {
          correctness: "high",
          security: "medium",
          performance: "low",
          resilience: "off",
        },
      },
    },
  }
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(resolve(tmpdir(), "bollard-metrics-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("extractComplexityFromDiff", () => {
  it("counts decision points in added lines", () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,9 @@ function handle(input) {
+  if (input) {
+    for (const item of input) {
+      if (item.ok && item.ready || item.force) {
+        return item.flag ? item.value : undefined
+      }
+    }
+  }
 }`

    const report = extractComplexityFromDiff(diff, 5)

    expect(report.hotspots).toHaveLength(1)
    expect(report.hotspots[0]?.functionName).toBe("handle")
    expect(report.hotspots[0]?.decisionPoints).toBe(6)
  })

  it("returns no hotspots when added lines have no decisions", () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
+const value = 1`

    const report = extractComplexityFromDiff(diff, 1)

    expect(report.hotspots).toHaveLength(0)
  })
})

describe("buildSastFindingsFromContent", () => {
  it("flags embedded rg-style patterns", () => {
    const findings = buildSastFindingsFromContent(
      "src/a.ts",
      "const result = eval(userInput)",
      "typescript",
      new Set([1]),
    )

    expect(findings).toHaveLength(1)
    expect(findings[0]?.pattern).toBe("eval-misuse")
    expect(findings[0]?.severity).toBe("high")
  })

  it("returns empty for clean content and wrong-language patterns", () => {
    expect(buildSastFindingsFromContent("src/a.ts", "const x = 1", "typescript")).toHaveLength(0)
    expect(
      buildSastFindingsFromContent("src/a.go", "const result = eval(userInput)", "go"),
    ).toHaveLength(0)
  })
})

describe("computeChurnScore", () => {
  it("classifies low and high churn", () => {
    expect(
      computeChurnScore("a.ts", Array.from({ length: 5 }, (_, i) => `c${i}`).join("\n")).churnRisk,
    ).toBe("low")
    expect(
      computeChurnScore("a.ts", Array.from({ length: 35 }, (_, i) => `c${i}`).join("\n")).churnRisk,
    ).toBe("high")
  })
})

describe("aggregateProbePerf", () => {
  it("computes percentiles and degrading trend from metrics files", async () => {
    await withTempDir(async (dir) => {
      const metricsDir = resolve(dir, ".bollard", "observe", "metrics")
      await mkdir(metricsDir, { recursive: true })
      const now = Date.now()
      const rows = Array.from({ length: 100 }, (_, index) => ({
        probeId: "probe-1",
        timestamp: now - (100 - index) * 1000,
        status: "pass",
        assertions: [],
        latencyMs: index + 1,
      }))
      await writeFile(
        resolve(metricsDir, "2026-05-11.jsonl"),
        rows.map((r) => JSON.stringify(r)).join("\n"),
      )

      const report = await aggregateProbePerf(dir, 100)

      expect(report.source).toBe("file-metrics-store")
      expect(report.probes[0]?.p50Ms).toBe(50)
      expect(report.probes[0]?.p95Ms).toBe(95)
      expect(report.probes[0]?.p99Ms).toBe(99)
      expect(report.probes[0]?.trend).toBe("degrading")
    })
  })

  it("returns none when no metrics files exist", async () => {
    await withTempDir(async (dir) => {
      const report = await aggregateProbePerf(dir)
      expect(report.source).toBe("none")
      expect(report.probes).toHaveLength(0)
    })
  })
})

describe("parsePnpmAuditJson", () => {
  it("counts critical and high advisories and keeps top details", () => {
    const detail = parsePnpmAuditJson(
      JSON.stringify({
        advisories: {
          "1": {
            module_name: "pkg-a",
            severity: "critical",
            title: "critical vuln",
            url: "https://example.com/a",
          },
          "2": {
            module_name: "pkg-b",
            severity: "high",
            title: "high vuln",
          },
        },
      }),
    )

    expect(detail.tool).toBe("pnpm-audit")
    expect(detail.criticalCount).toBe(1)
    expect(detail.highCount).toBe(1)
    expect(detail.details[0]?.package).toBe("pkg-a")
  })
})

describe("generateK6Script", () => {
  it("includes endpoints and options", () => {
    const script = generateK6Script(
      [
        { method: "GET", path: "/api/health", handler: "h", sourceFile: "src/a.ts" },
        { method: "POST", path: "/api/items", handler: "h", sourceFile: "src/a.ts" },
      ],
      { vus: 3, durationSec: 7 },
    )

    expect(script).toContain("vus: 3")
    expect(script).toContain("duration: '7s'")
    expect(script).toContain("/api/health")
    expect(script).toContain("/api/items")
  })
})

describe("extractCoverageDelta", () => {
  it("degrades to none when coverage tooling is unavailable", async () => {
    await withTempDir(async (dir) => {
      const coverage = await extractCoverageDelta(dir, ["src/a.ts"], makeProfile())
      expect(coverage.tool).toBe("none")
      expect(coverage.changedFiles).toHaveLength(0)
    })
  })
})
