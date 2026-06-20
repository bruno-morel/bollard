import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
  buildDocsCurationCorpus,
  type DocsEdit,
  extractCliCommands,
  extractFactTokens,
  parseDocsCurationPlan,
  verifyDocsCurationGrounding,
} from "../src/docs-curation.js"
import { BollardError } from "../src/errors.js"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

const SAMPLE_CORPUS = [
  "## CLAUDE.md (canonical state-of-truth)",
  "Stage 5e Phase 6 complete. Supports TypeScript, Python, Go, Rust, Java, Kotlin.",
  "Latest count: 1555 passed / 6 skipped. MCP tool count: 18.",
  "packages/engine packages/cli packages/verify",
  "@bollard/engine @bollard/cli",
  "curate-docs audit-docs",
  "## audit-docs facts",
  "auditAllPassed: true",
  "mcpToolCount: 18",
].join("\n")

const README_CONTENT = "Old stale count: 1500 passed / 6 skipped."
const CLAUDE_CONTENT = "Old stale count: 1500 passed / 6 skipped."

function validEdit(overrides: Partial<DocsEdit> = {}): DocsEdit {
  return {
    id: "e1",
    file: "README.md",
    oldText: "Old stale count: 1500 passed / 6 skipped.",
    newText: "Latest count: 1555 passed / 6 skipped.",
    rationale: "Sync test count with CLAUDE.md",
    grounding: [{ quote: "1555 passed / 6 skipped", source: "claude-md" }],
    ...overrides,
  }
}

describe("extractFactTokens", () => {
  it("extracts numbers, paths, packages, identifiers, and stage tokens", () => {
    const tokens = extractFactTokens(
      "Stage 5e adds @bollard/engine in packages/engine with 1555 tests and CostTracker.",
    )
    expect(tokens).toContain("1555")
    expect(tokens).toContain("packages/engine")
    expect(tokens).toContain("@bollard/engine")
    expect(tokens).toContain("CostTracker")
    expect(tokens.some((t) => /Stage 5e/i.test(t))).toBe(true)
  })

  it("excludes common English words", () => {
    const tokens = extractFactTokens("the test must read from spec")
    expect(tokens).not.toContain("test")
    expect(tokens).not.toContain("read")
    expect(tokens).not.toContain("spec")
  })
})

describe("extractCliCommands", () => {
  it("parses command names from index.ts if blocks", () => {
    const src = `
      if (command === "audit-docs") {}
      if (command === "curate-docs") {}
      if (command === "verify") {}
    `
    expect(extractCliCommands(src)).toEqual(["audit-docs", "curate-docs", "verify"])
  })
})

describe("verifyDocsCurationGrounding", () => {
  it("keeps a valid edit when facts and grounding are in corpus", () => {
    const edit = validEdit()
    const result = verifyDocsCurationGrounding({ edits: [edit] }, SAMPLE_CORPUS, {
      "README.md": README_CONTENT,
      "CLAUDE.md": CLAUDE_CONTENT,
    })
    expect(result.kept).toHaveLength(1)
    expect(result.dropped).toHaveLength(0)
  })

  it("drops hallucinated capability on ungrounded_fact_token", () => {
    const edit = validEdit({
      newText: "Now supports Ruby and C# with full contract graphs.",
    })
    const result = verifyDocsCurationGrounding({ edits: [edit] }, SAMPLE_CORPUS, {
      "README.md": README_CONTENT,
      "CLAUDE.md": CLAUDE_CONTENT,
    })
    expect(result.kept).toHaveLength(0)
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]?.reason).toBe("ungrounded_fact_token")
  })

  it("drops edit when oldText is not in file", () => {
    const edit = validEdit({ oldText: "text that does not exist in file" })
    const result = verifyDocsCurationGrounding({ edits: [edit] }, SAMPLE_CORPUS, {
      "README.md": README_CONTENT,
      "CLAUDE.md": CLAUDE_CONTENT,
    })
    expect(result.dropped[0]?.reason).toBe("old_text_not_in_file")
  })

  it("drops edit for non-allowlisted file", () => {
    const edit = validEdit({
      file: "CONTRIBUTING.md" as DocsEdit["file"],
    })
    const result = verifyDocsCurationGrounding({ edits: [edit] }, SAMPLE_CORPUS, {
      "README.md": README_CONTENT,
      "CLAUDE.md": CLAUDE_CONTENT,
    })
    expect(result.dropped[0]?.reason).toBe("file_not_allowed")
  })

  it("drops edit when grounding quote is not in corpus", () => {
    const edit = validEdit({
      grounding: [{ quote: "invented quote not in corpus", source: "roadmap" }],
    })
    const result = verifyDocsCurationGrounding({ edits: [edit] }, SAMPLE_CORPUS, {
      "README.md": README_CONTENT,
      "CLAUDE.md": CLAUDE_CONTENT,
    })
    expect(result.dropped[0]?.reason).toBe("grounding_not_in_corpus")
  })
})

describe("parseDocsCurationPlan", () => {
  it("parses valid JSON with optional fences", () => {
    const raw = '```json\n{"edits": []}\n```'
    expect(parseDocsCurationPlan(raw)).toEqual({ edits: [] })
  })

  it("throws CURATION_OUTPUT_INVALID on malformed JSON", () => {
    expect(() => parseDocsCurationPlan("{ not json")).toThrow(BollardError)
    try {
      parseDocsCurationPlan("{ not json")
    } catch (err: unknown) {
      expect(BollardError.hasCode(err, "CURATION_OUTPUT_INVALID")).toBe(true)
    }
  })
})

describe("buildDocsCurationCorpus", () => {
  it("includes roadmap, packages, CLI commands, audit result, and audit facts", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "docs-corpus-"))
    await writeFile(join(tempDir, "README.md"), "# README\n**MCP server:** 17 tools\n", "utf-8")
    await writeFile(join(tempDir, "CLAUDE.md"), "# CLAUDE\n", "utf-8")
    await mkdir(join(tempDir, "spec/adr"), { recursive: true })
    await writeFile(join(tempDir, "spec/ROADMAP.md"), "# Roadmap\n", "utf-8")
    await mkdir(join(tempDir, "packages/mcp/src"), { recursive: true })
    await writeFile(
      join(tempDir, "packages/mcp/src/tools.ts"),
      'export const tools = [{ name: "bollard_verify" }]',
      "utf-8",
    )
    await mkdir(join(tempDir, "packages/engine"), { recursive: true })
    await mkdir(join(tempDir, "packages/cli/src"), { recursive: true })
    await writeFile(
      join(tempDir, "packages/cli/src/index.ts"),
      'if (command === "audit-docs") {}',
      "utf-8",
    )

    const { corpus } = await buildDocsCurationCorpus({ workDir: tempDir })
    expect(corpus).toContain("## spec/ROADMAP.md")
    expect(corpus).toContain("## audit-docs result")
    expect(corpus).toContain("## audit-docs facts")
    expect(corpus).toContain("## packages/*")
    expect(corpus).toContain("engine")
    expect(corpus).toContain("## CLI commands")
    expect(corpus).toContain("audit-docs")
  })

  it("builds corpus for the real repo", async () => {
    const { corpus, auditResult } = await buildDocsCurationCorpus({ workDir: REPO_ROOT })
    expect(corpus.length).toBeGreaterThan(10_000)
    expect(corpus).toContain("## CLAUDE.md (canonical state-of-truth)")
    expect(auditResult.checks.length).toBe(4)
  })
})
