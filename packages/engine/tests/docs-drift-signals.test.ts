import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AuditDocsResult } from "@bollard/engine/src/audit-docs.js"
import {
  collectAuditImplicatedDocs,
  effectiveDocCommitTime,
  isDocStaleVsRefs,
  parseLinkIntegrityOwners,
  selectDriftCandidates,
} from "@bollard/engine/src/docs-drift-signals.js"
import { afterEach, describe, expect, it } from "vitest"

const editable = ["README.md", "CLAUDE.md", "CODE_OF_CONDUCT.md", "packages/cli/README.md"]

function fakeAudit(
  checks: Array<
    Partial<AuditDocsResult["checks"][number]> & { id: AuditDocsResult["checks"][number]["id"] }
  >,
): AuditDocsResult {
  return {
    allPassed: false,
    checks: checks.map((o) => ({
      label: "test",
      passed: false,
      ...o,
    })),
  }
}

describe("collectAuditImplicatedDocs", () => {
  it("implicates README and CLAUDE for test-count-consistency", () => {
    const map = collectAuditImplicatedDocs(
      fakeAudit([{ id: "test-count-consistency", passed: false }]),
    )
    expect(map.get("README.md")).toContain("audit: test-count-consistency")
    expect(map.get("CLAUDE.md")).toContain("audit: test-count-consistency")
  })

  it("implicates README for mcp-tool-count, spec-doc-links, adr-links", () => {
    for (const id of ["mcp-tool-count", "spec-doc-links", "adr-links"] as const) {
      const map = collectAuditImplicatedDocs(fakeAudit([{ id, passed: false }]))
      expect(map.get("README.md")).toContain(`audit: ${id}`)
      expect(map.has("CLAUDE.md")).toBe(false)
    }
  })

  it("implicates dangling-link owners for link-integrity", () => {
    const map = collectAuditImplicatedDocs(
      fakeAudit([
        {
          id: "link-integrity",
          passed: false,
          actual: "README.md: missing.ts; docs/foo.md: bar.ts",
        },
      ]),
    )
    expect(map.get("README.md")).toContain("audit: link-integrity (dangling link)")
    expect(map.get("docs/foo.md")).toContain("audit: link-integrity (dangling link)")
  })

  it("excludes doc-placement offenders", () => {
    const map = collectAuditImplicatedDocs(
      fakeAudit([
        {
          id: "doc-placement",
          passed: true,
          advisory: true,
          actual: "notes/stray.md",
        },
      ]),
    )
    expect(map.size).toBe(0)
  })

  it("excludes link-orphans", () => {
    const map = collectAuditImplicatedDocs(
      fakeAudit([
        {
          id: "link-orphans",
          passed: true,
          advisory: true,
          actual: "orphan.md",
        },
      ]),
    )
    expect(map.size).toBe(0)
  })
})

describe("parseLinkIntegrityOwners", () => {
  it("parses semicolon-separated from: target pairs", () => {
    expect(parseLinkIntegrityOwners("README.md: a.ts; docs/x.md: b.ts")).toEqual([
      "README.md",
      "docs/x.md",
    ])
  })
})

describe("isDocStaleVsRefs", () => {
  it("returns true when any ref is newer", () => {
    expect(isDocStaleVsRefs(100, [50, 200])).toBe(true)
  })

  it("returns false when doc is newer or equal", () => {
    expect(isDocStaleVsRefs(200, [100, 200])).toBe(false)
  })
})

describe("effectiveDocCommitTime", () => {
  it("uses MAX for null (uncommitted doc)", () => {
    expect(effectiveDocCommitTime(null)).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe("selectDriftCandidates", () => {
  let workDir: string

  afterEach(() => {
    void workDir
  })

  it("returns all editable with --all", async () => {
    workDir = join(tmpdir(), `drift-all-${Date.now()}`)
    await mkdir(workDir, { recursive: true })
    const result = await selectDriftCandidates(workDir, editable, { all: true })
    expect(result).toHaveLength(editable.length)
    expect(result.every((c) => c.reasons.includes("--all"))).toBe(true)
  })

  it("selects audit-implicated README for test-count failure", async () => {
    workDir = join(tmpdir(), `drift-audit-${Date.now()}`)
    await mkdir(workDir, { recursive: true })
    const auditResult: AuditDocsResult = {
      allPassed: false,
      checks: [
        {
          id: "test-count-consistency",
          label: "test counts",
          passed: false,
        },
      ],
    }
    const result = await selectDriftCandidates(workDir, editable, {
      auditResult,
      getLastCommitTime: async () => null,
    })
    const paths = result.map((c) => c.path)
    expect(paths).toContain("README.md")
    expect(paths).toContain("CLAUDE.md")
    expect(paths).not.toContain("CODE_OF_CONDUCT.md")
  })

  it("does not select doc-placement offender only", async () => {
    workDir = join(tmpdir(), `drift-placement-${Date.now()}`)
    await mkdir(workDir, { recursive: true })
    await writeFile(join(workDir, "CODE_OF_CONDUCT.md"), "# Code of Conduct\n", "utf-8")
    const auditResult: AuditDocsResult = {
      allPassed: true,
      checks: [
        {
          id: "doc-placement",
          label: "placement",
          passed: true,
          advisory: true,
          actual: "CODE_OF_CONDUCT.md",
        },
      ],
    }
    const result = await selectDriftCandidates(workDir, ["CODE_OF_CONDUCT.md"], {
      auditResult,
      getLastCommitTime: async () => null,
    })
    expect(result).toHaveLength(0)
  })

  it("selects stale doc when code ref is newer", async () => {
    workDir = join(tmpdir(), `drift-stale-${Date.now()}`)
    await mkdir(join(workDir, "packages/cli/src"), { recursive: true })
    await writeFile(
      join(workDir, "packages/cli/README.md"),
      "# CLI\n\nSee [index](./src/index.ts)\n",
      "utf-8",
    )
    await writeFile(join(workDir, "packages/cli/src/index.ts"), "export {}\n", "utf-8")

    const times: Record<string, number> = {
      "packages/cli/README.md": 100,
      "packages/cli/src/index.ts": 200,
      "packages/cli/src": 200,
    }

    const result = await selectDriftCandidates(workDir, ["packages/cli/README.md"], {
      getLastCommitTime: async (_wd, path) => times[path] ?? null,
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.path).toBe("packages/cli/README.md")
    expect(result[0]?.reasons[0]).toMatch(/code newer than doc/)
    expect(result[0]?.reasons[0]).toMatch(/packages\/cli\/src/)
  })

  it("does not select fresh doc when doc time >= refs", async () => {
    workDir = join(tmpdir(), `drift-fresh-${Date.now()}`)
    await mkdir(join(workDir, "packages/engine/src"), { recursive: true })
    await writeFile(
      join(workDir, "packages/engine/README.md"),
      "# Engine\n\n[src](./src/foo.ts)\n",
      "utf-8",
    )
    await writeFile(join(workDir, "packages/engine/src/foo.ts"), "export {}\n", "utf-8")

    const times: Record<string, number> = {
      "packages/engine/README.md": 300,
      "packages/engine/src/foo.ts": 200,
      "packages/engine/src": 200,
    }

    const result = await selectDriftCandidates(workDir, ["packages/engine/README.md"], {
      getLastCommitTime: async (_wd, path) => times[path] ?? null,
    })
    expect(result).toHaveLength(0)
  })

  it("does not select no-signal doc", async () => {
    workDir = join(tmpdir(), `drift-nosignal-${Date.now()}`)
    await mkdir(workDir, { recursive: true })
    await writeFile(join(workDir, "CODE_OF_CONDUCT.md"), "# CoC\n\nBe nice.\n", "utf-8")
    const result = await selectDriftCandidates(workDir, ["CODE_OF_CONDUCT.md"], {
      auditResult: { allPassed: true, checks: [] },
      getLastCommitTime: async () => 100,
    })
    expect(result).toHaveLength(0)
  })

  it("git-absent degrades to audit-only without throwing", async () => {
    workDir = join(tmpdir(), `drift-gitabsent-${Date.now()}`)
    await mkdir(workDir, { recursive: true })
    const auditResult: AuditDocsResult = {
      allPassed: false,
      checks: [{ id: "mcp-tool-count", label: "mcp", passed: false }],
    }
    const result = await selectDriftCandidates(workDir, editable, {
      auditResult,
      getLastCommitTime: async () => null,
    })
    expect(result.map((c) => c.path)).toEqual(["README.md"])
  })

  it("merges audit and staleness reasons on same doc", async () => {
    workDir = join(tmpdir(), `drift-merge-${Date.now()}`)
    await mkdir(workDir, { recursive: true })
    await writeFile(
      join(workDir, "README.md"),
      "# Readme\n\n[cli](packages/cli/src/index.ts)\n",
      "utf-8",
    )
    await mkdir(join(workDir, "packages/cli/src"), { recursive: true })
    await writeFile(join(workDir, "packages/cli/src/index.ts"), "export {}\n", "utf-8")

    const times: Record<string, number> = {
      "README.md": 100,
      "packages/cli/src/index.ts": 200,
      "packages/cli/src": 200,
    }
    const auditResult: AuditDocsResult = {
      allPassed: false,
      checks: [{ id: "mcp-tool-count", label: "mcp", passed: false }],
    }

    const result = await selectDriftCandidates(workDir, ["README.md"], {
      auditResult,
      getLastCommitTime: async (_wd, path) => times[path] ?? null,
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.reasons.length).toBeGreaterThanOrEqual(2)
    expect(result[0]?.reasons.some((r) => r.startsWith("audit:"))).toBe(true)
    expect(result[0]?.reasons.some((r) => r.startsWith("code newer than doc:"))).toBe(true)
  })

  it("scores detect-only spec doc when linked code is newer", async () => {
    workDir = join(tmpdir(), `drift-detectonly-${Date.now()}`)
    await mkdir(join(workDir, "spec"), { recursive: true })
    await mkdir(join(workDir, "packages/engine/src"), { recursive: true })
    await writeFile(
      join(workDir, "spec/stage5d-token-economy.md"),
      "# Stage 5d\n\nSee [engine](../packages/engine/src/index.ts)\n",
      "utf-8",
    )
    await writeFile(join(workDir, "packages/engine/src/index.ts"), "export {}\n", "utf-8")

    const times: Record<string, number> = {
      "spec/stage5d-token-economy.md": 100,
      "packages/engine/src/index.ts": 200,
    }

    const result = await selectDriftCandidates(workDir, ["spec/stage5d-token-economy.md"], {
      getLastCommitTime: async (_wd, path) => times[path] ?? null,
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.path).toBe("spec/stage5d-token-economy.md")
    expect(result[0]?.reasons[0]).toContain("code newer than doc")
  })

  it("omits fresh detect-only spec doc with no signals", async () => {
    workDir = join(tmpdir(), `drift-detectonly-fresh-${Date.now()}`)
    await mkdir(join(workDir, "spec"), { recursive: true })
    await writeFile(join(workDir, "spec/README.md"), "# Spec index\n", "utf-8")

    const result = await selectDriftCandidates(workDir, ["spec/README.md"], {
      getLastCommitTime: async () => 200,
    })
    expect(result).toHaveLength(0)
  })

  it("implicates detect-only doc for link-integrity audit failure", async () => {
    workDir = join(tmpdir(), `drift-detectonly-audit-${Date.now()}`)
    await mkdir(workDir, { recursive: true })
    const auditResult: AuditDocsResult = {
      allPassed: false,
      checks: [
        {
          id: "link-integrity",
          label: "links",
          passed: false,
          actual: "spec/stage6-docs-integrity.md: missing.ts",
        },
      ],
    }
    const result = await selectDriftCandidates(workDir, ["spec/stage6-docs-integrity.md"], {
      auditResult,
      getLastCommitTime: async () => null,
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.reasons).toContain("audit: link-integrity (dangling link)")
  })

  it("shares gitTimeCache across two calls — each path queried once", async () => {
    workDir = join(tmpdir(), `drift-shared-cache-${Date.now()}`)
    await mkdir(join(workDir, "spec"), { recursive: true })
    await mkdir(join(workDir, "packages/cli/src"), { recursive: true })
    await writeFile(
      join(workDir, "README.md"),
      "# Readme\n\n[cli](packages/cli/src/index.ts)\n",
      "utf-8",
    )
    await writeFile(
      join(workDir, "spec/stage5d-token-economy.md"),
      "# Stage 5d\n\n[cli](../packages/cli/src/index.ts)\n",
      "utf-8",
    )
    await writeFile(join(workDir, "packages/cli/src/index.ts"), "export {}\n", "utf-8")

    const queryCounts = new Map<string, number>()
    const times: Record<string, number> = {
      "README.md": 100,
      "spec/stage5d-token-economy.md": 100,
      "packages/cli/src/index.ts": 200,
      "packages/cli/src": 200,
    }
    const getLastCommitTime = async (_wd: string, path: string): Promise<number | null> => {
      queryCounts.set(path, (queryCounts.get(path) ?? 0) + 1)
      return times[path] ?? null
    }

    const gitTimeCache = new Map<string, number | null>()
    const driftOpts = { getLastCommitTime, gitTimeCache }

    await selectDriftCandidates(workDir, ["README.md"], driftOpts)
    await selectDriftCandidates(workDir, ["spec/stage5d-token-economy.md"], driftOpts)

    expect(queryCounts.get("packages/cli/src/index.ts")).toBe(1)
    expect(queryCounts.get("README.md")).toBe(1)
    expect(queryCounts.get("spec/stage5d-token-economy.md")).toBe(1)
  })
})
