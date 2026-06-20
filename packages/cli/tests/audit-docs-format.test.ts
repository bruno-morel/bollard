import { describe, expect, it } from "vitest"
import { formatAuditDocsResult } from "../src/audit-docs.js"

describe("formatAuditDocsResult", () => {
  it("renders pass lines", () => {
    const output = formatAuditDocsResult({
      allPassed: true,
      checks: [
        {
          id: "mcp-tool-count",
          label: "README MCP tool count matches source",
          passed: true,
        },
      ],
    })
    expect(output).toContain("README MCP tool count matches source")
    expect(output).toContain("✓")
  })

  it("renders fail lines with expected/actual", () => {
    const output = formatAuditDocsResult({
      allPassed: false,
      checks: [
        {
          id: "mcp-tool-count",
          label: "README MCP tool count matches source",
          passed: false,
          expected: "17",
          actual: "99",
        },
      ],
    })
    expect(output).toContain("✗")
    expect(output).toContain("expected: 17")
    expect(output).toContain("actual: 99")
  })
})
