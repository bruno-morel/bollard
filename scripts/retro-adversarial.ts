#!/usr/bin/env tsx
/**
 * Retroactive adversarial test generation for Stage 0 and Stage 1 code.
 *
 * Iterates source files, extracts signatures, invokes the tester agent,
 * writes .adversarial.test.ts files, and runs them.
 *
 * Usage:
 *   docker compose run --rm --entrypoint sh dev -c "pnpm exec tsx scripts/retro-adversarial.ts"
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { basename, dirname, relative, resolve } from "node:path"
import { executeAgent } from "@bollard/agents/src/executor.js"
import { createTesterAgent } from "@bollard/agents/src/tester.js"
import type { AgentContext } from "@bollard/agents/src/types.js"
import type { BollardConfig, PipelineContext } from "@bollard/engine/src/context.js"
import { createContext } from "@bollard/engine/src/context.js"
import { LLMClient } from "@bollard/llm/src/client.js"
import { runTests } from "@bollard/verify/src/dynamic.js"
import { extractSignatures } from "@bollard/verify/src/type-extractor.js"

const WORK_DIR = resolve(dirname(new URL(import.meta.url).pathname), "..")

const PACKAGES = ["engine", "llm", "agents", "cli", "verify", "blueprints"]

const SKIP_FILENAMES = new Set(["types.ts", "index.ts"])

/**
 * Context hints provide runtime constraints that are invisible in type signatures
 * but essential for writing valid tests. Keyed by substring match on relativePath.
 *
 * These same hints will feed the plan → tester handoff in the implement-feature
 * pipeline (Stage 2). For now they live here for retro testing.
 */
function getContextHints(relativePath: string): string[] {
  const hints: string[] = []

  // All agent tools: execute(input, ctx) needs a real temp directory
  if (relativePath.includes("agents/src/tools/")) {
    hints.push(
      "## Fixture: AgentContext with real filesystem",
      "All tool `execute(input, ctx)` functions perform real filesystem I/O against `ctx.workDir`.",
      "You MUST create a real temp directory for each test:",
      "```typescript",
      'import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"',
      'import { tmpdir } from "node:os"',
      'import { join } from "node:path"',
      'import type { AgentContext } from "../../src/types.js"',
      "",
      "let workDir: string",
      "let ctx: AgentContext",
      "beforeEach(() => {",
      '  workDir = mkdtempSync(join(tmpdir(), "bollard-test-"))',
      "  ctx = {",
      "    pipelineCtx: {} as AgentContext[\"pipelineCtx\"],",
      "    workDir,",
      "  }",
      "})",
      "afterEach(() => { rmSync(workDir, { recursive: true, force: true }) })",
      "```",
      "The path-traversal guard rejects any resolved path that escapes `workDir`.",
      'Test traversal with inputs like `{ path: "../../../etc/passwd" }`.',
    )
  }

  // run-command: allowed commands list
  if (relativePath.includes("tools/run-command")) {
    hints.push(
      "## Runtime constraint: command allowlist",
      "Only these commands are allowed by default: pnpm, npx, node, tsc, biome, git, cat, head, tail, wc, diff.",
      'Any other command (echo, pwd, ls, sleep, rm, etc.) is rejected with an error: `Command "X" is not allowed.`',
      "Commands are split on whitespace; the first token is checked against the allowlist.",
      '`ctx.allowedCommands` can override the default list — if set, only those commands are accepted.',
    )
  }

  // search: uses grep, needs files to exist
  if (relativePath.includes("tools/search")) {
    hints.push(
      "## Runtime constraint: grep-based search",
      "The search tool runs `grep` against real files. Create test files in the temp `workDir` before searching.",
      'Pattern matching is regex-based. The tool returns "No matches found." when grep exits with code 1 (no matches).',
      "Results are capped at 100 lines.",
    )
  }

  // list-dir: needs directory entries
  if (relativePath.includes("tools/list-dir")) {
    hints.push(
      "## Runtime constraint: real directory listing",
      "The tool reads real directory contents. Create files and subdirectories in `workDir` before calling.",
      'Directories appear with a trailing "/" in the output. Files appear without.',
      "Output is newline-separated.",
    )
  }

  // write-file: creates parent dirs automatically
  if (relativePath.includes("tools/write-file")) {
    hints.push(
      "## Runtime constraint: auto-creates parent directories",
      "write_file creates parent directories with `{ recursive: true }` if they don't exist.",
      'After writing, verify with `readFileSync(join(workDir, path), "utf-8")`.',
      "Returns a confirmation string with byte count.",
    )
  }

  // read-file: needs files to exist
  if (relativePath.includes("tools/read-file")) {
    hints.push(
      "## Runtime constraint: reads real files",
      "Create files in `workDir` with `writeFileSync` before testing read_file.",
      "The tool reads as UTF-8. It throws on nonexistent files.",
    )
  }

  // config: Zod strict schema + env vars required
  if (relativePath.includes("cli/src/config")) {
    hints.push(
      "## Runtime constraint: Zod strict validation",
      "The `.bollard.yml` schema is validated with `z.object({...}).strict()` — any extra properties cause rejection.",
      "Valid `.bollard.yml` top-level keys: `llm`, `agent`, `risk` (and nothing else).",
      "Valid `llm` shape: `{ default?: { provider?: string, model?: string }, agents?: Record<string, { provider: string, model: string }> }`",
      "Valid `agent` shape: `{ max_cost_usd?: number, max_duration_minutes?: number }`",
      "",
      "## Runtime constraint: API key required",
      "`resolveConfig()` throws `BollardError` with code `CONFIG_INVALID` if neither `ANTHROPIC_API_KEY` nor `OPENAI_API_KEY` is set in `process.env`.",
      "In tests, set `process.env.ANTHROPIC_API_KEY = 'test-key'` in `beforeEach` and clean up in `afterEach`.",
      "",
      "## Runtime constraint: filesystem-dependent detection",
      "`resolveConfig()` checks for files (tsconfig.json, biome.json, etc.) in `cwd`. Use a temp directory with/without these files to test detection.",
    )
  }

  // eval-loader: filter semantics
  if (relativePath.includes("eval-loader")) {
    hints.push(
      "## Runtime constraint: filter edge cases",
      '`loadEvalCases(agentFilter)` returns ALL cases when `agentFilter` is `undefined`, empty string `""`, or any string not matching a registered agent name.',
      'It only filters when given an exact match: `"planner"`, `"coder"`, or `"tester"`.',
      '`availableAgents()` returns `["planner", "coder", "tester"]`.',
    )
  }

  // agent-handler: complex mocking needed
  if (relativePath.includes("cli/src/agent-handler")) {
    hints.push(
      "## Runtime constraint: heavy external dependencies",
      "This module creates agents and calls `executeAgent` from @bollard/agents. Tests must mock:",
      "- `executeAgent` — returns `AgentResult` with `response`, `totalCostUsd`, `totalDurationMs`, `turns`, `toolCalls`",
      "- `createPlannerAgent` and `createCoderAgent` — return `AgentDefinition`",
      "- `LLMClient` — `forAgent(role)` returns `{ provider, model }`",
      'Use `vi.mock("@bollard/agents/src/executor.js", ...)` etc.',
    )
  }

  return hints
}

const filesIdx = process.argv.indexOf("--files")
const FILE_FILTER: string[] | null = filesIdx !== -1 ? process.argv.slice(filesIdx + 1) : null

const SOURCE_DIRS = PACKAGES.map((pkg) => ({
  pkg,
  srcDir: resolve(WORK_DIR, "packages", pkg, "src"),
}))

async function discoverSourceFiles(): Promise<
  { pkg: string; filePath: string; relativePath: string }[]
> {
  const files: { pkg: string; filePath: string; relativePath: string }[] = []

  for (const { pkg, srcDir } of SOURCE_DIRS) {
    try {
      const entries = await readdir(srcDir, { recursive: true })
      for (const entry of entries as string[]) {
        if (
          entry.endsWith(".ts") &&
          !entry.endsWith(".test.ts") &&
          !entry.includes("evals/") &&
          !SKIP_FILENAMES.has(basename(entry))
        ) {
          files.push({
            pkg,
            filePath: resolve(srcDir, entry),
            relativePath: `packages/${pkg}/src/${entry}`,
          })
        }
      }
    } catch {
      // package might not have src dir
    }
  }

  return files
}

interface RetroResult {
  relativePath: string
  testFile: string
  costUsd: number
  turns: number
  status: "written" | "skipped" | "error"
  error?: string
}

async function main() {
  const config: BollardConfig = {
    llm: {
      default: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
    },
    agent: { max_cost_usd: 10, max_duration_minutes: 60 },
  }

  const llmClient = new LLMClient(config)
  const { provider, model } = llmClient.forAgent("tester")
  const tester = await createTesterAgent()
  const ctx = createContext("Retroactive adversarial testing", "retro-adversarial", config)

  const agentCtx: AgentContext = { pipelineCtx: ctx as PipelineContext, workDir: WORK_DIR }

  const sourceFiles = await discoverSourceFiles()
  process.stderr.write(`Found ${sourceFiles.length} source files across ${PACKAGES.join(", ")}\n\n`)

  const written: string[] = []
  const results: RetroResult[] = []

  for (const { filePath, relativePath } of sourceFiles) {
    if (FILE_FILTER && !FILE_FILTER.some((f) => relativePath.endsWith(f))) {
      continue
    }

    const source = await readFile(filePath, "utf-8")
    const sig = extractSignatures(filePath, source)

    if (!sig.signatures) {
      process.stderr.write(`  skip: ${relativePath} (no function/class/const signatures)\n`)
      results.push({ relativePath, testFile: "", costUsd: 0, turns: 0, status: "skipped" })
      continue
    }

    const moduleName = basename(filePath, ".ts")
    const testPath = filePath.replace(/\/src\//, "/tests/").replace(/\.ts$/, ".adversarial.test.ts")
    const importRel = relative(dirname(testPath), filePath).replace(/\.ts$/, ".js")
    const importPath = importRel.startsWith(".") ? importRel : `./${importRel}`

    process.stderr.write(`  generating: ${relativePath}\n`)

    const hints = getContextHints(relativePath)

    const userMessage = [
      "# Task",
      `Write adversarial tests for the public API in ${relativePath}`,
      "",
      "# Acceptance Criteria",
      "1. All exported functions and classes have at least one behavioral test",
      "2. Property-based tests for functions with numeric/string/collection params",
      "3. Negative tests for error conditions",
      "4. Every test must assert a domain-specific property — tests that only check existence or non-throwing are insufficient",
      "",
      ...(hints.length > 0
        ? ["# Runtime Constraints (not visible in type signatures)", "", ...hints, ""]
        : []),
      "# Public API Surface",
      "",
      "## Imports (what this module depends on)",
      sig.imports ? `\`\`\`typescript\n${sig.imports}\n\`\`\`` : "(none)",
      "",
      "## Types",
      sig.types ? `\`\`\`typescript\n${sig.types}\n\`\`\`` : "(none)",
      "",
      "## Signatures (bodies stripped — you cannot see the implementation)",
      `\`\`\`typescript\n${sig.signatures}\n\`\`\``,
      "",
      "# Import Path for Tests",
      `The test file will be placed at \`${basename(testPath)}\`. Import the module under test as:`,
      "```typescript",
      `import { ... } from "${importPath}"`,
      "```",
      "",
      "# Instructions",
      "Write a complete test file. Output ONLY the TypeScript test code, no markdown fences, no explanations.",
    ].join("\n")

    try {
      const result = await executeAgent(tester, userMessage, provider, model, agentCtx)
      ctx.costTracker.add(result.totalCostUsd)

      let testCode = result.response
      const fenced = testCode.match(/```(?:typescript|ts)?\s*\n([\s\S]*?)\n```/)
      if (fenced?.[1]) {
        testCode = fenced[1]
      }

      await mkdir(dirname(testPath), { recursive: true })
      await writeFile(testPath, testCode, "utf-8")
      written.push(testPath)
      results.push({
        relativePath,
        testFile: testPath,
        costUsd: result.totalCostUsd,
        turns: result.turns,
        status: "written",
      })
      process.stderr.write(
        `    wrote: ${basename(testPath)} (${result.turns} turns, $${result.totalCostUsd.toFixed(4)})\n`,
      )
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`    error: ${msg}\n`)
      results.push({
        relativePath,
        testFile: "",
        costUsd: 0,
        turns: 0,
        status: "error",
        error: msg,
      })
    }
  }

  process.stderr.write(`\n${"=".repeat(60)}\n`)
  process.stderr.write(`Generated ${written.length} adversarial test files\n`)
  process.stderr.write(`Total cost: $${ctx.costTracker.total().toFixed(4)}\n`)

  if (written.length > 0) {
    process.stderr.write("\nRunning adversarial tests...\n")
    const testResult = await runTests(WORK_DIR, written)
    process.stderr.write(
      `  Result: ${testResult.passed} passed, ${testResult.failed} failed out of ${testResult.total}\n`,
    )

    if (testResult.output) {
      process.stderr.write("\n--- Test Output (last 3000 chars) ---\n")
      process.stderr.write(testResult.output.slice(-3000))
      process.stderr.write("\n")
    }
  }

  process.stdout.write(
    JSON.stringify(
      {
        filesGenerated: written.length,
        totalCostUsd: ctx.costTracker.total(),
        results,
      },
      null,
      2,
    ),
  )
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
