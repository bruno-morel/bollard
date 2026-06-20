import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
  auditDocs,
  checkAdrLinks,
  checkLinkIntegrity,
  checkLinkOrphans,
  checkMcpToolCount,
  checkSpecDocLinks,
  checkTestCountConsistency,
  countMcpToolsFromSource,
  extractRelativeMarkdownLinks,
  findDanglingLinks,
  findLinkOrphans,
} from "../src/audit-docs.js"
import { classifyDocPath } from "../src/docs-resolver.js"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

const FIXTURE_README = `
**MCP server:** 17 tools, 6 resource endpoints, 3 prompt templates.
**Test suite:** 1513 passed / 6 skipped · Adversarial suite: 338 passed.
[01 — Architecture](spec/01-architecture.md)
[09 — Model Selection](spec/09-model-selection.md)
[0005](spec/adr/0005-capability-based-model-selection.md)
`

const FIXTURE_CLAUDE = `
- **Latest count (authoritative, 2026-06-05):** \`1513\` passed, \`6\` skipped (main \`vitest run\`; 1519 total). Skips: 6 LLM/local smoke tests. Adversarial suite \`338\` passed.
`

function makeToolsSnippet(count: number): string {
  const names = Array.from({ length: count }, (_, i) => `  { name: "bollard_tool_${i}" },`)
  return `export const tools = [\n${names.join("\n")}\n]`
}

async function writeMinimalDocFixture(
  root: string,
  readme: string,
  claude: string,
  extraSpecFiles: string[] = [],
  extraAdrFiles: string[] = [],
): Promise<void> {
  await writeFile(join(root, "README.md"), readme, "utf-8")
  await writeFile(join(root, "CLAUDE.md"), claude, "utf-8")
  await mkdir(join(root, "spec/adr"), { recursive: true })
  await mkdir(join(root, "packages/mcp/src"), { recursive: true })
  await writeFile(join(root, "packages/mcp/src/tools.ts"), makeToolsSnippet(17), "utf-8")
  for (const name of ["01-architecture.md", "09-model-selection.md", ...extraSpecFiles]) {
    await writeFile(join(root, "spec", name), "# stub", "utf-8")
  }
  for (const name of ["0005-capability-based-model-selection.md", ...extraAdrFiles]) {
    await writeFile(join(root, "spec/adr", name), "# stub", "utf-8")
  }
}

describe("countMcpToolsFromSource", () => {
  it('counts name: "bollard_" entries in a fixture snippet', () => {
    expect(countMcpToolsFromSource(makeToolsSnippet(17))).toBe(17)
  })
})

describe("checkMcpToolCount", () => {
  it("passes when README claim matches actual count", () => {
    const result = checkMcpToolCount("**MCP server:** 17 tools", 17)
    expect(result.passed).toBe(true)
  })

  it("fails with expected/actual on mismatch", () => {
    const result = checkMcpToolCount("**MCP server:** 99 tools", 17)
    expect(result.passed).toBe(false)
    expect(result.expected).toBe("17")
    expect(result.actual).toBe("99")
  })

  it("fails when MCP claim is missing", () => {
    const result = checkMcpToolCount("No MCP line here", 17)
    expect(result.passed).toBe(false)
    expect(result.actual).toBe("claim not found")
  })
})

describe("checkSpecDocLinks", () => {
  it("fails and names missing spec files", () => {
    const result = checkSpecDocLinks("spec/01-architecture.md only", [
      "01-architecture.md",
      "09-model-selection.md",
    ])
    expect(result.passed).toBe(false)
    expect(result.actual).toContain("09-model-selection.md")
  })
})

describe("checkAdrLinks", () => {
  it("fails and names missing ADR files", () => {
    const result = checkAdrLinks("no adr links", ["0001-deterministic-filters-for-llm-output.md"])
    expect(result.passed).toBe(false)
    expect(result.actual).toContain("0001-deterministic-filters-for-llm-output.md")
  })
})

describe("checkTestCountConsistency", () => {
  it("passes when README and CLAUDE counts match", () => {
    const result = checkTestCountConsistency(FIXTURE_README, FIXTURE_CLAUDE)
    expect(result.passed).toBe(true)
  })

  it("fails when main counts differ", () => {
    const claude = FIXTURE_CLAUDE.replace("`1513`", "`1305`")
    const result = checkTestCountConsistency(FIXTURE_README, claude)
    expect(result.passed).toBe(false)
    expect(result.actual).toContain("main README")
  })

  it("fails when adversarial counts differ", () => {
    const claude = FIXTURE_CLAUDE.replace("`338`", "`200`")
    const result = checkTestCountConsistency(FIXTURE_README, claude)
    expect(result.passed).toBe(false)
    expect(result.actual).toContain("adversarial")
  })

  it("fails when README main stat line is missing", () => {
    const result = checkTestCountConsistency("no stats here", FIXTURE_CLAUDE)
    expect(result.passed).toBe(false)
    expect(result.actual).toContain("claim not found")
  })
})

describe("extractRelativeMarkdownLinks", () => {
  it("skips external URLs and anchor-only links", () => {
    const content = "[ext](https://example.com) [anchor](#section) [rel](spec/foo.md)"
    expect(extractRelativeMarkdownLinks(content)).toEqual(["spec/foo.md"])
  })
})

describe("link integrity helpers", () => {
  it("detects dangling links", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "audit-link-dangle-"))
    await writeFile(join(tempDir, "README.md"), "[bad](packages/does-not-exist.ts)\n", "utf-8")
    await writeFile(join(tempDir, "CLAUDE.md"), "# claude\n", "utf-8")
    const classifications = [classifyDocPath("README.md")]
    const docContents = new Map([["README.md", "[bad](packages/does-not-exist.ts)\n"]])
    const dangling = await findDanglingLinks({ classifications, docContents, workDir: tempDir })
    expect(dangling).toHaveLength(1)
    expect(checkLinkIntegrity(dangling).passed).toBe(false)
  })

  it("lists orphan eligible docs not reachable from roots", () => {
    const classifications = [classifyDocPath("README.md"), classifyDocPath("spec/adr/orphan.md")]
    const docContents = new Map([
      ["README.md", "# root\n"],
      ["spec/adr/orphan.md", "# orphan\n"],
    ])
    const orphans = findLinkOrphans({
      classifications,
      docContents,
      workDir: "/tmp/unused",
    })
    expect(orphans).toContain("spec/adr/orphan.md")
    const advisory = checkLinkOrphans(orphans)
    expect(advisory.advisory).toBe(true)
    expect(advisory.passed).toBe(true)
  })
})

describe("auditDocs", () => {
  it("passes all hard checks on a consistent fixture", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "audit-docs-pass-"))
    await writeMinimalDocFixture(tempDir, FIXTURE_README, FIXTURE_CLAUDE)
    const result = await auditDocs(tempDir, { toolCount: 17 })
    expect(result.checks.filter((c) => !c.advisory).every((c) => c.passed)).toBe(true)
    expect(result.checks).toHaveLength(7)
  })

  it("fails when README MCP count mismatches injected toolCount", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "audit-docs-mcp-"))
    const readme = FIXTURE_README.replace("17 tools", "99 tools")
    await writeMinimalDocFixture(tempDir, readme, FIXTURE_CLAUDE)
    const result = await auditDocs(tempDir, { toolCount: 17 })
    const mcp = result.checks.find((c) => c.id === "mcp-tool-count")
    expect(mcp?.passed).toBe(false)
    expect(mcp?.expected).toBe("17")
    expect(mcp?.actual).toBe("99")
  })

  it("fails when packages/mcp/src/tools.ts is missing", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "audit-docs-no-tools-"))
    await writeMinimalDocFixture(tempDir, FIXTURE_README, FIXTURE_CLAUDE)
    await rm(join(tempDir, "packages/mcp/src/tools.ts"))
    const result = await auditDocs(tempDir)
    const mcp = result.checks.find((c) => c.id === "mcp-tool-count")
    expect(mcp?.passed).toBe(false)
    expect(mcp?.actual).toBe("packages/mcp/src/tools.ts not found")
  })

  it("fails when a spec file on disk is not linked in README", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "audit-docs-spec-"))
    await writeMinimalDocFixture(tempDir, FIXTURE_README, FIXTURE_CLAUDE, ["99-fake.md"])
    const result = await auditDocs(tempDir, { toolCount: 17 })
    const spec = result.checks.find((c) => c.id === "spec-doc-links")
    expect(spec?.passed).toBe(false)
    expect(spec?.actual).toContain("99-fake.md")
  })

  it("fails when an ADR file on disk is not linked in README", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "audit-docs-adr-"))
    await writeMinimalDocFixture(tempDir, FIXTURE_README, FIXTURE_CLAUDE, [], ["9999-fake.md"])
    const result = await auditDocs(tempDir, { toolCount: 17 })
    const adr = result.checks.find((c) => c.id === "adr-links")
    expect(adr?.passed).toBe(false)
    expect(adr?.actual).toContain("9999-fake.md")
  })

  it("advisory checks do not flip allPassed when orphans exist", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "audit-docs-orphan-"))
    await writeMinimalDocFixture(tempDir, FIXTURE_README, FIXTURE_CLAUDE)
    await writeFile(join(tempDir, "spec/adr/unlinked.md"), "# orphan adr\n", "utf-8")
    const result = await auditDocs(tempDir, { toolCount: 17 })
    const orphans = result.checks.find((c) => c.id === "link-orphans")
    expect(orphans?.advisory).toBe(true)
    expect(orphans?.actual).toContain("unlinked.md")
    expect(result.allPassed).toBe(result.checks.filter((c) => !c.advisory).every((c) => c.passed))
  })

  it("passes on the real repo reading tools.ts from disk", async () => {
    const result = await auditDocs(REPO_ROOT)
    expect(result.allPassed).toBe(true)
  }, 60_000)
})
