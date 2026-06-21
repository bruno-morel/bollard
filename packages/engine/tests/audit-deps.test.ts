import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  auditDeps,
  checkHelperManifestVulnerabilities,
  checkNpmVulnerabilities,
  goModHasExternalRequires,
  normalizeSeverity,
  parseOsvJson,
  resolveManifestTargets,
} from "../src/audit-deps.js"

const FIXTURES = join(import.meta.dirname, "fixtures")
const WORK_DIR = "/app"
const REPO_ROOT = resolve(import.meta.dirname, "../../..")

async function loadFixture(name: string): Promise<string> {
  return readFile(join(FIXTURES, name), "utf-8")
}

describe("normalizeSeverity", () => {
  it("maps GHSA-style severity strings", () => {
    expect(normalizeSeverity("HIGH")).toBe("high")
    expect(normalizeSeverity("MODERATE")).toBe("moderate")
    expect(normalizeSeverity("CRITICAL")).toBe("critical")
    expect(normalizeSeverity("LOW")).toBe("low")
  })
})

describe("parseOsvJson", () => {
  it("parses multi-ecosystem fixture with manifests and severities", async () => {
    const raw = await loadFixture("osv-scanner-multi-ecosystem.json")
    const vulns = parseOsvJson(raw, WORK_DIR)

    const npmHigh = vulns.find((v) => v.id === "GHSA-npm-high-001")
    expect(npmHigh).toMatchObject({
      package: "lodash",
      version: "4.17.20",
      severity: "high",
      manifest: "pnpm-lock.yaml",
      fixedVersion: "4.17.21",
    })

    const javaHigh = vulns.find((v) => v.id === "GHSA-java-high-001")
    expect(javaHigh).toMatchObject({
      package: "com.github.javaparser:javaparser-core",
      severity: "high",
      manifest: "scripts/extract_java/pom.xml",
    })

    const npmMod = vulns.find((v) => v.id === "GHSA-npm-mod-001")
    expect(npmMod?.severity).toBe("moderate")
  })
})

describe("goModHasExternalRequires", () => {
  it("returns false for stdlib-only go.mod", () => {
    const content = `module example.com/foo

go 1.24
`
    expect(goModHasExternalRequires(content)).toBe(false)
  })

  it("returns true when require block has modules", () => {
    const content = `module example.com/foo

go 1.24

require (
\tgithub.com/foo/bar v1.0.0
)
`
    expect(goModHasExternalRequires(content)).toBe(true)
  })
})

describe("resolveManifestTargets", () => {
  it("skips stdlib-only extract_go go.mod", async () => {
    const targets = await resolveManifestTargets(REPO_ROOT)
    expect(targets).not.toContain("scripts/extract_go/go.mod")
    expect(targets).toContain("pnpm-lock.yaml")
    expect(targets).toContain("scripts/extract_rs/Cargo.lock")
    expect(targets).toContain("scripts/extract_java/pom.xml")
  })
})

describe("checkNpmVulnerabilities", () => {
  it("fails on HIGH npm vuln", () => {
    const result = checkNpmVulnerabilities([
      {
        package: "lodash",
        version: "4.17.20",
        id: "GHSA-npm-high-001",
        severity: "high",
        manifest: "pnpm-lock.yaml",
      },
    ])
    expect(result.passed).toBe(false)
    expect(result.advisory).toBeUndefined()
  })

  it("advises on moderate-only npm vulns", () => {
    const result = checkNpmVulnerabilities([
      {
        package: "qs",
        version: "6.15.1",
        id: "GHSA-npm-mod-only",
        severity: "moderate",
        manifest: "pnpm-lock.yaml",
      },
    ])
    expect(result.passed).toBe(true)
    expect(result.advisory).toBe(true)
  })
})

describe("checkHelperManifestVulnerabilities", () => {
  it("fails on HIGH helper manifest vuln (blind-spot closer)", () => {
    const result = checkHelperManifestVulnerabilities([
      {
        package: "com.github.javaparser:javaparser-core",
        version: "3.26.4",
        id: "GHSA-java-high-001",
        severity: "high",
        manifest: "scripts/extract_java/pom.xml",
      },
    ])
    expect(result.passed).toBe(false)
    expect(result.id).toBe("helper-manifest-vulnerabilities")
  })
})

describe("auditDeps", () => {
  it("returns allPassed false when npm has HIGH vuln", async () => {
    const raw = await loadFixture("osv-scanner-multi-ecosystem.json")
    const result = await auditDeps(WORK_DIR, {
      osvRunner: async () => ({ ok: true, stdout: raw }),
    })

    const npmCheck = result.checks.find((c) => c.id === "npm-vulnerabilities")
    expect(npmCheck?.passed).toBe(false)
    expect(result.allPassed).toBe(false)
  })

  it("returns helper check failed for HIGH java pom vuln", async () => {
    const raw = await loadFixture("osv-scanner-multi-ecosystem.json")
    const result = await auditDeps(WORK_DIR, {
      osvRunner: async () => ({ ok: true, stdout: raw }),
    })

    const helperCheck = result.checks.find((c) => c.id === "helper-manifest-vulnerabilities")
    expect(helperCheck?.passed).toBe(false)
  })

  it("keeps allPassed true for moderate-only npm vulns", async () => {
    const raw = await loadFixture("osv-scanner-moderate-only.json")
    const result = await auditDeps(WORK_DIR, {
      osvRunner: async () => ({ ok: true, stdout: raw }),
    })

    const npmCheck = result.checks.find((c) => c.id === "npm-vulnerabilities")
    expect(npmCheck?.advisory).toBe(true)
    expect(npmCheck?.passed).toBe(true)
    expect(result.allPassed).toBe(true)
  })

  it("advisory skip when osv-scanner unavailable", async () => {
    const result = await auditDeps(WORK_DIR, {
      osvRunner: async () => ({ ok: false, unavailable: true }),
    })

    expect(result.checks).toHaveLength(1)
    expect(result.checks[0]?.id).toBe("osv-scanner-available")
    expect(result.checks[0]?.advisory).toBe(true)
    expect(result.allPassed).toBe(true)
  })

  it("passes on clean scan", async () => {
    const raw = await loadFixture("osv-scanner-clean.json")
    const result = await auditDeps(WORK_DIR, {
      osvRunner: async () => ({ ok: true, stdout: raw }),
    })

    expect(result.allPassed).toBe(true)
    expect(result.checks.every((c) => c.passed)).toBe(true)
  })
})
