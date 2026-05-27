import { execFile } from "node:child_process"
import { resolve, sep } from "node:path"
import { promisify } from "node:util"
import type { AgentTool } from "../types.js"

const execFileAsync = promisify(execFile)

const MAX_OUTPUT_LINES = 100

/** Hard stop after this many test-command invocations per coder session. */
const MAX_TEST_INVOCATIONS = 5

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g")

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "")
}

export function isTestCommand(parts: string[]): boolean {
  if (parts[0] === "pnpm") {
    if (parts[1] === "test") return true
    if (parts[1] === "run" && parts[2] === "test") return true
    if (parts[1] === "exec" && parts[2] === "vitest") return true
  }
  if (parts[0] === "vitest") return true
  if (parts[0] === "npx" && parts[1] === "vitest") return true
  return false
}

export function formatVitestFailureSummary(stdout: string, stderr: string): string {
  const combined = stripAnsi(`${stdout}\n${stderr}`)
  const lines = combined.split("\n")

  const failedSuites: string[] = []
  for (const line of lines) {
    if (/^\s*(FAIL|×)\s+\S+\.test\.(ts|js)/.test(line)) {
      const match = line.match(/\S+\.test\.(ts|js)/)
      if (match?.[0] && !failedSuites.includes(match[0])) {
        failedSuites.push(match[0])
      }
    }
  }

  const failedTests: string[] = []
  for (const line of lines) {
    const failPathMatch = line.match(/FAIL\s+\S+\.test\.(?:ts|js)\s*>\s*(.+)/)
    if (failPathMatch?.[1]) {
      const name = failPathMatch[1].trim()
      if (name && !failedTests.includes(name)) {
        failedTests.push(name)
      }
    }
    if (/^\s+[×✗✕]\s+/.test(line)) {
      const name = line.replace(/^\s+[×✗✕]\s+/, "").trim()
      if (name && !failedTests.includes(name)) {
        failedTests.push(name)
      }
    }
  }

  const errorMessages: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    if (/^\s+(AssertionError|Error|Expected|Received):/.test(line) && errorMessages.length < 3) {
      const snippet = [line, lines[i + 1] ?? "", lines[i + 2] ?? ""]
        .filter((l) => l.trim() !== "")
        .map((l) => l.trimEnd())
        .slice(0, 3)
        .join("\n")
      errorMessages.push(snippet)
      i += 2
    }
  }

  let summaryLine = ""
  for (const line of lines) {
    if (/Tests?\s+\d+\s+failed/i.test(line) || /\d+\s+passed/.test(line)) {
      summaryLine = line.trim()
      break
    }
  }

  const parts: string[] = []

  if (summaryLine) {
    parts.push(`Summary: ${summaryLine}`)
  }

  if (failedSuites.length > 0) {
    parts.push(`\nFailing suites (${failedSuites.length}):`)
    for (const suite of failedSuites.slice(0, 10)) {
      parts.push(`  • ${suite}`)
    }
    if (failedSuites.length > 10) {
      parts.push(`  ... and ${failedSuites.length - 10} more`)
    }
  }

  if (failedTests.length > 0) {
    parts.push(`\nFailing tests (${failedTests.length}):`)
    for (const test of failedTests.slice(0, 15)) {
      parts.push(`  × ${test}`)
    }
    if (failedTests.length > 15) {
      parts.push(`  ... and ${failedTests.length - 15} more`)
    }
  }

  if (errorMessages.length > 0) {
    parts.push("\nFirst error(s):")
    for (const msg of errorMessages) {
      parts.push(msg)
    }
  }

  if (parts.length === 0) {
    return truncateStream(stdout || stderr, "stdout")
  }

  return parts.join("\n")
}

function truncateStream(stream: string, label: "stdout" | "stderr"): string {
  const streamLines = stream.split("\n")
  const truncated = streamLines.length > MAX_OUTPUT_LINES
  const displayed = streamLines.slice(0, MAX_OUTPUT_LINES).join("\n")
  return `${label}:\n${displayed}${truncated ? `\n[...truncated: ${streamLines.length - MAX_OUTPUT_LINES} more lines not shown]` : ""}\n`
}

const DEFAULT_ALLOWED_COMMANDS = [
  "pnpm",
  "npx",
  "node",
  "tsc",
  "biome",
  "git",
  "cat",
  "head",
  "tail",
  "wc",
  "diff",
  "rm",
]

export const runCommandTool: AgentTool = {
  name: "run_command",
  description:
    "Execute a shell command. Only whitelisted commands are allowed. Returns stdout and stderr.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run (e.g. 'pnpm run test')" },
      cwd: {
        type: "string",
        description: "Working directory relative to project root (default: root)",
      },
    },
    required: ["command"],
  },
  async execute(input, ctx) {
    const cmdStr = String(input["command"] ?? "")
    const parts = cmdStr.split(/\s+/)
    const executable = parts[0]

    if (isTestCommand(parts)) {
      ctx.testInvocationCount = (ctx.testInvocationCount ?? 0) + 1
      if (ctx.testInvocationCount > MAX_TEST_INVOCATIONS) {
        return [
          `Error: test suite invoked ${ctx.testInvocationCount} times this session (max ${MAX_TEST_INVOCATIONS}).`,
          "Stop retrying. Report the remaining failures as-is and end your response.",
          "Continuing to loop on test failures wastes the turn budget without making progress.",
        ].join(" ")
      }
    }

    if (executable === "cd") {
      return [
        `Error: "cd" is a shell builtin and cannot be run as a command.`,
        `To run a command in a subdirectory, use the "cwd" parameter instead:`,
        `{ "command": "...", "cwd": "packages/engine" }`,
      ].join(" ")
    }

    const allowed = ctx.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS

    if (!executable || !allowed.includes(executable)) {
      throw new Error(`Command "${executable}" is not allowed. Allowed: ${allowed.join(", ")}`)
    }

    const cwd = resolve(ctx.workDir, String(input["cwd"] ?? "."))
    if (!cwd.startsWith(resolve(ctx.workDir))) {
      throw new Error("Path traversal detected")
    }

    if (executable === "rm") {
      if (parts.includes("-rf") || parts.includes("-r")) {
        throw new Error("Recursive rm is not allowed. Delete files individually.")
      }
      const workRoot = resolve(ctx.workDir)
      const rmTargets = parts.slice(1).filter((arg) => !arg.startsWith("-"))
      for (const target of rmTargets) {
        const resolvedTarget = resolve(cwd, target)
        const inside = resolvedTarget === workRoot || resolvedTarget.startsWith(workRoot + sep)
        if (!inside) {
          throw new Error(`rm target "${target}" is outside the work directory`)
        }
      }
    }

    try {
      const { stdout, stderr } = await execFileAsync(executable, parts.slice(1), {
        cwd,
        maxBuffer: 2 * 1024 * 1024,
        timeout: 180_000,
        env: { ...process.env, NODE_ENV: "test" },
      })
      let result = ""
      if (stdout) result += truncateStream(stdout, "stdout")
      if (stderr) result += truncateStream(stderr, "stderr")
      return result || "(no output)"
    } catch (err: unknown) {
      if (err && typeof err === "object" && "stdout" in err) {
        const e = err as { stdout: string; stderr: string; code: number }

        if (isTestCommand(parts)) {
          const summary = formatVitestFailureSummary(e.stdout ?? "", e.stderr ?? "")
          return `Command failed (exit ${String(e.code)}) — test failure summary:\n${summary}`
        }

        let body = ""
        if (e.stdout) body += truncateStream(e.stdout, "stdout")
        if (e.stderr) body += truncateStream(e.stderr, "stderr")
        return `Command failed (exit ${String(e.code)}):\n${body}`
      }
      throw err
    }
  },
}
