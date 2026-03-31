import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { createImplementFeatureBlueprint } from "@bollard/blueprints/src/implement-feature.js"
import type { Blueprint, BlueprintNode, NodeResult } from "@bollard/engine/src/blueprint.js"
import type { PipelineContext } from "@bollard/engine/src/context.js"
import { BollardError } from "@bollard/engine/src/errors.js"
import type { ProgressEvent } from "@bollard/engine/src/runner.js"
import { runBlueprint } from "@bollard/engine/src/runner.js"
import { LLMClient } from "@bollard/llm/src/client.js"
import { runStaticChecks } from "@bollard/verify/src/static.js"
import { buildProjectTree, createAgenticHandler } from "./agent-handler.js"
import { resolveConfig } from "./config.js"
import { diffToolchainProfile } from "./diff.js"
import { humanGateHandler } from "./human-gate.js"

const DIM = "\x1b[2m"
const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const YELLOW = "\x1b[33m"
const CYAN = "\x1b[36m"

function log(msg: string): void {
  process.stderr.write(`${msg}\n`)
}

function header(title: string): void {
  log(`\n${BOLD}${CYAN}bollard${RESET} ${BOLD}${title}${RESET}`)
  log(`${DIM}${"─".repeat(50)}${RESET}`)
}

function statusIcon(status: string): string {
  if (status === "ok") return `${GREEN}✓${RESET}`
  if (status === "fail") return `${RED}✗${RESET}`
  if (status === "block") return `${YELLOW}■${RESET}`
  return `${DIM}…${RESET}`
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatCost(usd: number): string {
  if (usd === 0) return ""
  return ` ${DIM}($${usd.toFixed(4)})${RESET}`
}

function cliProgress(event: ProgressEvent): void {
  const prefix = `${DIM}[${event.step}/${event.totalSteps}]${RESET}`

  if (event.type === "node_start") {
    const typeLabel =
      event.nodeType === "agentic"
        ? `${CYAN}agent${RESET}`
        : event.nodeType === "human_gate"
          ? `${YELLOW}gate${RESET}`
          : `${DIM}check${RESET}`
    log(`${prefix} ${typeLabel}  ${event.nodeName}`)
  }

  if (event.type === "node_retry") {
    log(
      `${prefix}       ${YELLOW}↻ retry${RESET} ${DIM}(attempt ${event.attempt}/${event.maxAttempts})${RESET}`,
    )
  }

  if (event.type === "node_complete") {
    const icon = statusIcon(event.status ?? "ok")
    const duration = event.durationMs ? ` ${DIM}${formatMs(event.durationMs)}${RESET}` : ""
    const cost = formatCost(event.costUsd ?? 0)
    log(`${prefix}       ${icon}${duration}${cost}`)
  }
}

function createSimpleAgenticHandler(config: Awaited<ReturnType<typeof resolveConfig>>["config"]) {
  const llmClient = new LLMClient(config)

  return async (node: BlueprintNode, ctx: PipelineContext): Promise<NodeResult> => {
    const agentRole = node.agent ?? "default"
    const startMs = Date.now()

    const { provider, model } = llmClient.forAgent(agentRole)
    const response = await provider.chat({
      system: `You are the "${agentRole}" agent in a Bollard pipeline run.`,
      messages: [
        {
          role: "user",
          content: `Task: ${ctx.task}\nNode: ${node.name}\nBlueprint: ${ctx.blueprintId}`,
        },
      ],
      maxTokens: 1024,
      temperature: 0.3,
      model,
    })

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")

    return {
      status: "ok",
      data: text,
      cost_usd: response.costUsd,
      duration_ms: Date.now() - startMs,
    }
  }
}

const demoBlueprint: Blueprint = {
  id: "demo",
  name: "Demo Blueprint",
  nodes: [
    {
      id: "greet",
      name: "Deterministic Greeting",
      type: "deterministic",
      execute: async (ctx) => {
        ctx.log.info(`Hello from deterministic node! Task: ${ctx.task}`)
        return { status: "ok", data: `Greeted for task: ${ctx.task}` }
      },
    },
    {
      id: "llm-hello",
      name: "Agentic Hello",
      type: "agentic",
      agent: "default",
    },
  ],
  maxCostUsd: 1,
  maxDurationMinutes: 5,
}

function parseArgs(raw: string[]): { command: string; rest: string[] } {
  const args = raw[0] === "--" ? raw.slice(1) : raw
  return { command: args[0] ?? "", rest: args.slice(1) }
}

function getTaskFlag(args: string[]): string | undefined {
  const idx = args.indexOf("--task")
  return idx !== -1 ? args[idx + 1] : undefined
}

function findWorkspaceRoot(start: string): string {
  let dir = resolve(start)
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir
    dir = dirname(dir)
  }
  return start
}

function printRunSummary(result: {
  status: string
  totalCostUsd: number
  totalDurationMs: number
  runId: string
  error?: { code: string; message: string }
}): void {
  log(`${DIM}${"─".repeat(50)}${RESET}`)

  const icon =
    result.status === "success"
      ? `${GREEN}✓ success${RESET}`
      : result.status === "handed_to_human"
        ? `${YELLOW}■ handed to human${RESET}`
        : `${RED}✗ failure${RESET}`

  log(`${BOLD}Result:${RESET} ${icon}`)
  log(`${DIM}Run ID:${RESET}   ${result.runId}`)
  log(`${DIM}Duration:${RESET} ${formatMs(result.totalDurationMs)}`)
  log(`${DIM}Cost:${RESET}     $${result.totalCostUsd.toFixed(4)}`)

  if (result.error) {
    log(`\n${RED}Error [${result.error.code}]:${RESET} ${result.error.message}`)
  }

  log("")
}

async function runPlanCommand(args: string[]): Promise<void> {
  const task = getTaskFlag(args)
  if (!task) {
    log("Usage: bollard plan --task <task>")
    process.exit(1)
  }

  header("plan")
  log(`${DIM}Task:${RESET} ${task}`)
  log(`${DIM}Agent:${RESET} planner (read-only tools)`)
  log("")

  const { config, profile } = await resolveConfig()
  const { executeAgent } = await import("@bollard/agents/src/executor.js")
  const { createPlannerAgent } = await import("@bollard/agents/src/planner.js")
  const { createContext } = await import("@bollard/engine/src/context.js")

  const planner = await createPlannerAgent(profile)
  const llmClient = new LLMClient(config)
  const { provider, model } = llmClient.forAgent("planner")

  log(`${DIM}Model:${RESET} ${model}`)
  log(`${DIM}Planning...${RESET}\n`)

  const workDir = findWorkspaceRoot(process.cwd())
  const projectTree = await buildProjectTree(workDir)
  const plannerMessage = projectTree ? `Task: ${task}\n\n${projectTree}` : `Task: ${task}`
  const ctx = createContext(task, "plan-only", config)
  const result = await executeAgent(planner, plannerMessage, provider, model, {
    pipelineCtx: ctx,
    workDir,
  })

  process.stdout.write(`${result.response}\n`)

  log(`\n${DIM}${"─".repeat(50)}${RESET}`)
  log(`${GREEN}✓${RESET} Plan generated`)
  log(`${DIM}Cost:${RESET}  $${result.totalCostUsd.toFixed(4)}`)
  log(`${DIM}Turns:${RESET} ${result.turns}`)
  log(`${DIM}Time:${RESET}  ${formatMs(result.totalDurationMs)}`)
  if (result.toolCalls.length > 0) {
    log(`${DIM}Tools:${RESET} ${result.toolCalls.map((tc) => tc.tool).join(", ")}`)
  }
  log("")
}

async function runVerifyCommand(args: string[]): Promise<void> {
  const workDir = findWorkspaceRoot(process.cwd())

  // Check if --profile flag is present
  if (args.includes("--profile")) {
    const { detectToolchain } = await import("@bollard/detect/src/detect.js")
    const profile = await detectToolchain(workDir)
    process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`)
    process.exit(0)
  }

  header("verify")
  log(`${DIM}Running static checks...${RESET}\n`)

  const { results, allPassed } = await runStaticChecks(workDir)

  for (const r of results) {
    const icon = r.passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`
    log(`  ${icon} ${r.check} ${DIM}(${formatMs(r.durationMs)})${RESET}`)
    if (!r.passed) {
      const lines = r.output.split("\n").slice(0, 8).join("\n    ")
      log(`    ${RED}${lines}${RESET}`)
    }
  }

  log("")

  if (allPassed) {
    log(`${GREEN}All checks passed.${RESET}\n`)
  } else {
    const failed = results.filter((r) => !r.passed).map((r) => r.check)
    log(`${RED}Failed: ${failed.join(", ")}${RESET}\n`)
  }

  process.exit(allPassed ? 0 : 1)
}

async function runDiffCommand(): Promise<void> {
  const workDir = findWorkspaceRoot(process.cwd())

  header("diff")
  log(`${DIM}Comparing detected profile against hardcoded Stage 1 defaults...${RESET}\n`)

  const { detectToolchain } = await import("@bollard/detect/src/detect.js")
  const profile = await detectToolchain(workDir)
  const diff = diffToolchainProfile(profile)

  log(`${BOLD}Checks:${RESET}`)
  for (const check of diff.checks) {
    let icon: string
    let details = ""

    switch (check.status) {
      case "unchanged":
        icon = `${GREEN}✓${RESET}`
        details = `${check.detected?.cmd} ${check.detected?.args.join(" ")}`
        break
      case "differ":
        icon = `${YELLOW}~${RESET}`
        details = `${check.hardcoded?.cmd} ${check.hardcoded?.args.join(" ")} → ${check.detected?.cmd} ${check.detected?.args.join(" ")}`
        break
      case "new":
        icon = `${CYAN}+${RESET}`
        details = `${check.detected?.cmd} ${check.detected?.args.join(" ")}`
        break
      case "removed":
        icon = `${RED}-${RESET}`
        details = `${check.hardcoded?.cmd} ${check.hardcoded?.args.join(" ")}`
        break
    }

    log(`  ${icon} ${check.name} ${DIM}${details}${RESET}`)
  }

  for (const pattern of diff.patterns) {
    log(`\n${BOLD}${pattern.type}:${RESET}`)

    for (const item of pattern.unchanged) {
      log(`  ${GREEN}✓${RESET} ${item}`)
    }
    for (const item of pattern.added) {
      log(`  ${CYAN}+${RESET} ${item}`)
    }
    for (const item of pattern.removed) {
      log(`  ${RED}-${RESET} ${item}`)
    }
  }

  log(`\n${BOLD}Summary:${RESET}`)
  log(
    `${diff.summary.unchanged} unchanged, ${diff.summary.differ} differ, ${diff.summary.new} new, ${diff.summary.removed} removed`,
  )
  log("")
}

async function runRunCommand(args: string[]): Promise<void> {
  const blueprintName = args[0]
  const task = getTaskFlag(args)

  if (!blueprintName || !task) {
    log("Usage: bollard run <blueprint> --task <task>")
    process.exit(1)
  }

  const { config, profile } = await resolveConfig()

  if (blueprintName === "demo") {
    header("run demo")
    log(`${DIM}Task:${RESET} ${task}\n`)

    const handler = createSimpleAgenticHandler(config)
    const result = await runBlueprint(demoBlueprint, task, config, handler, undefined, cliProgress)
    printRunSummary(result)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exit(result.status === "success" ? 0 : 1)
  }

  if (blueprintName === "implement-feature") {
    const workDir = findWorkspaceRoot(process.cwd())
    const blueprint = createImplementFeatureBlueprint(workDir)

    header("run implement-feature")
    log(`${DIM}Task:${RESET}      ${task}`)
    log(`${DIM}Blueprint:${RESET} ${blueprint.name} (${blueprint.nodes.length} steps)`)
    log(
      `${DIM}Limits:${RESET}    $${blueprint.maxCostUsd} cost / ${blueprint.maxDurationMinutes}min`,
    )
    log("")

    const handler = await createAgenticHandler(config, workDir, profile)
    const result = await runBlueprint(
      blueprint,
      task,
      config,
      handler,
      humanGateHandler,
      cliProgress,
    )
    printRunSummary(result)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exit(result.status === "success" ? 0 : 1)
  }

  log(`Unknown blueprint: "${blueprintName}". Available: demo, implement-feature`)
  process.exit(1)
}

async function runEvalCommand(args: string[]): Promise<void> {
  const agentFilter = args[0]
  const { loadEvalCases, availableAgents } = await import("@bollard/agents/src/eval-loader.js")
  const cases = loadEvalCases(agentFilter)

  header(`eval${agentFilter ? ` ${agentFilter}` : ""}`)

  if (cases.length === 0) {
    log(`${RED}No eval cases found${agentFilter ? ` for "${agentFilter}"` : ""}.${RESET}`)
    log(`${DIM}Available agents: ${availableAgents().join(", ")}${RESET}\n`)
    process.exit(1)
  }

  log(`${DIM}Running ${cases.length} eval case(s)...${RESET}\n`)

  const { config } = await resolveConfig()
  const { runEvals } = await import("@bollard/engine/src/eval-runner.js")
  const llmClient = new LLMClient(config)
  const { provider, model } = llmClient.forAgent("default")
  const evalProvider = { chat: provider.chat.bind(provider) }

  const results = await runEvals(cases, evalProvider, { model, runs: 1 })

  for (const r of results) {
    const icon = r.ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`
    log(`  ${icon} ${r.caseId}`)
    if (!r.ok) {
      for (const detail of r.details) {
        for (const a of detail.assertions) {
          if (!a.passed) {
            const desc = a.assertion.description ?? a.assertion.type
            log(`    ${RED}└ ${desc}: got ${String(a.actual ?? "n/a")}${RESET}`)
          }
        }
      }
    }
  }

  const passed = results.filter((r) => r.ok).length
  log(`\n${DIM}${"─".repeat(50)}${RESET}`)
  log(`${passed === results.length ? GREEN : RED}${passed}/${results.length} passed${RESET}\n`)
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
  process.exit(passed === results.length ? 0 : 1)
}

async function main(): Promise<void> {
  const { command, rest } = parseArgs(process.argv.slice(2))

  if (command === "run") {
    await runRunCommand(rest)
    return
  }

  if (command === "plan") {
    await runPlanCommand(rest)
    return
  }

  if (command === "verify") {
    await runVerifyCommand(rest)
    return
  }

  if (command === "diff") {
    await runDiffCommand()
    return
  }

  if (command === "config" && rest[0] === "show") {
    const { config, profile, sources } = await resolveConfig()
    const showSources = rest.includes("--sources")
    const output = showSources ? { config, profile, sources } : config
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
    return
  }

  if (command === "init") {
    header("init")
    const { profile, sources } = await resolveConfig()
    log("Detected project configuration:\n")
    log(`  ${BOLD}Language:${RESET}         ${profile.language}`)
    if (profile.packageManager) {
      log(`  ${BOLD}Package manager:${RESET}  ${profile.packageManager}`)
    }
    if (profile.checks.typecheck) {
      log(`  ${BOLD}Type checker:${RESET}     ${profile.checks.typecheck.label}`)
    }
    if (profile.checks.lint) {
      log(`  ${BOLD}Linter:${RESET}           ${profile.checks.lint.label}`)
    }
    if (profile.checks.test) {
      log(`  ${BOLD}Test framework:${RESET}   ${profile.checks.test.label}`)
    }
    if (profile.checks.audit) {
      log(`  ${BOLD}Dep audit:${RESET}        ${profile.checks.audit.label}`)
    }
    if (profile.checks.secretScan) {
      log(`  ${BOLD}Secret scan:${RESET}      ${profile.checks.secretScan.label}`)
    }
    log("")

    log("Detection sources:\n")
    for (const [key, val] of Object.entries(sources)) {
      if (val.source === "auto-detected") {
        log(`  ${GREEN}✓${RESET} ${key}`)
      } else {
        log(`  ${DIM}· ${key} (${val.source})${RESET}`)
      }
    }

    log("")
    log("Verification layers:")
    if (profile.checks.test) {
      log(
        `  Layer 1 (project tests):     ${profile.checks.test.cmd} ${profile.checks.test.args.join(" ")}`,
      )
    } else {
      log(`  Layer 1 (project tests):     ${DIM}(no test framework detected)${RESET}`)
    }
    log("  Layer 2 (adversarial tests): bollard/verify container (Stage 2+)")
    log(`  Layer 3 (mutation testing):  ${DIM}(Stage 3+)${RESET}`)
    log("")
    return
  }

  if (command === "eval") {
    await runEvalCommand(rest)
    return
  }

  log(`\n${BOLD}${CYAN}bollard${RESET} — artifact integrity framework\n`)
  log("Commands:\n")
  log(`  ${BOLD}run${RESET} <blueprint> --task <task>   Run a blueprint`)
  log(`  ${BOLD}plan${RESET} --task <task>              Generate a plan without implementing`)
  log(`  ${BOLD}verify${RESET} [--profile]              Run static checks (or show profile)`)
  log(`  ${BOLD}diff${RESET}                            Compare profile vs hardcoded defaults`)
  log(`  ${BOLD}eval${RESET} [agent]                    Run agent eval sets`)
  log(`  ${BOLD}config show${RESET} [--sources]         Show resolved configuration`)
  log(`  ${BOLD}init${RESET}                            Detect project configuration`)
  log("")
  log(`Blueprints: ${DIM}demo, implement-feature${RESET}`)
  log("")
  process.exit(1)
}

main().catch((err: unknown) => {
  if (BollardError.is(err)) {
    log(`\n${RED}[${err.code}]${RESET} ${err.message}\n`)
  } else {
    log(`\n${RED}Error:${RESET} ${err instanceof Error ? err.message : String(err)}\n`)
  }
  process.exit(1)
})
