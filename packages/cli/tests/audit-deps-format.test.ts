import { describe, expect, it } from "vitest"
import { formatAuditDepsResult } from "../src/audit-deps.js"

describe("formatAuditDepsResult", () => {
  it("renders pass lines", () => {
    const output = formatAuditDepsResult({
      allPassed: true,
      checks: [
        {
          id: "npm-vulnerabilities",
          label: "npm workspace vulnerabilities (pnpm-lock.yaml / package.json)",
          passed: true,
          vulnerabilities: [],
        },
      ],
    })
    expect(output).toContain("npm workspace vulnerabilities")
    expect(output).toContain("✓")
  })

  it("renders fail lines with vuln count", () => {
    const output = formatAuditDepsResult({
      allPassed: false,
      checks: [
        {
          id: "helper-manifest-vulnerabilities",
          label: "helper extractor manifest vulnerabilities (Go/Rust/Java)",
          passed: false,
          vulnerabilities: [
            {
              package: "com.github.javaparser:javaparser-core",
              version: "3.26.4",
              id: "GHSA-java-high-001",
              severity: "high",
              manifest: "scripts/extract_java/pom.xml",
            },
          ],
        },
      ],
    })
    expect(output).toContain("✗")
    expect(output).toContain("critical/high")
    expect(output).toContain("GHSA-java-high-001")
  })

  it("renders advisory lines with moderate/low count", () => {
    const output = formatAuditDepsResult({
      allPassed: true,
      checks: [
        {
          id: "npm-vulnerabilities",
          label: "npm workspace vulnerabilities (pnpm-lock.yaml / package.json)",
          passed: true,
          advisory: true,
          vulnerabilities: [
            {
              package: "qs",
              version: "6.15.1",
              id: "GHSA-npm-mod-only",
              severity: "moderate",
              manifest: "pnpm-lock.yaml",
            },
          ],
        },
      ],
    })
    expect(output).toContain("⚠")
    expect(output).toContain("advisory:")
    expect(output).toContain("1 moderate")
    expect(output).toContain("GHSA-npm-mod-only")
  })
})
