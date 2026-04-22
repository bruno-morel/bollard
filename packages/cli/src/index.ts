import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { AgentResult } from "@bollard/agents/src/types.js"
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
import { collectAffectedPathsFromPlan } from "./contract-plan.js"
import { diffToolchainProfile } from "./diff.js"
import { formatDoctorReport, runDoctor } from "./doctor.js"
import { humanGateHandler } from "./human-gate.js"
import {
  runDeployCommand,
  runDriftCommand,
  runFlagCommand,
  runProbeCommand,
} from "./observe-commands.js"
import { formatQuietVerifyResult } from "./quiet-verify.js"
import { createAgentSpinner } from "./spinner.js"
import { BOLD, CYAN, DIM, GREEN, RED, RESET, YELLOW } from "./terminal-styles.js"
import { findWorkspaceRoot } from "./workspace-root.js"

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
    if (event.nodeType === "agentic") {
      log("")
    }
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

function getWorkDirFlag(args: string[]): string | undefined {
  const idx = args.indexOf("--work-dir")
  return idx !== -1 ? args[idx + 1] : undefined
}

/** Monorepo root for config detection when running via `pnpm --filter` (cwd may be a package dir). */
function resolveWorkspaceDirFromArgs(args: string[]): string {
  const explicit = getWorkDirFlag(args)
  return explicit ? resolve(explicit) : findWorkspaceRoot(process.cwd())
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

  const workDir = resolveWorkspaceDirFromArgs(args)
  const { config, profile } = await resolveConfig(undefined, workDir)
  const { executeAgent } = await import("@bollard/agents/src/executor.js")
  const { createPlannerAgent } = await import("@bollard/agents/src/planner.js")
  const { createContext } = await import("@bollard/engine/src/context.js")

  const planner = await createPlannerAgent(profile)
  const llmClient = new LLMClient(config)
  const { provider, model } = llmClient.forAgent("planner")

  log(`${DIM}Model:${RESET} ${model}`)
  log(`${DIM}Work dir:${RESET} ${workDir}`)
  log(`${DIM}Planning...${RESET}\n`)

  const projectTree = await buildProjectTree(workDir)
  const plannerMessage = projectTree ? `Task: ${task}\n\n${projectTree}` : `Task: ${task}`
  const ctx = createContext(task, "plan-only", config)
  const spinner = createAgentSpinner()
  let result: AgentResult
  try {
    result = await executeAgent(planner, plannerMessage, provider, model, {
      pipelineCtx: ctx,
      workDir,
      progress: (ev) => spinner.handleEvent(ev),
    })
  } finally {
    spinner.finalize()
  }

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

async function runContractCommand(args: string[]): Promise<void> {
  const workDir = resolveWorkspaceDirFromArgs(args)

  header("contract")
  log(`${DIM}Work dir:${RESET} ${workDir}`)

  const planIdx = args.indexOf("--plan")
  let plan: unknown
  if (planIdx !== -1) {
    const planPath = args[planIdx + 1]
    if (!planPath) {
      log("Usage: bollard contract [--work-dir <path>] [--plan <file.json>]")
      process.exit(1)
    }
    const text = await readFile(resolve(planPath), "utf-8")
    plan = JSON.parse(text) as unknown
  }

  const { profile } = await resolveConfig(undefined, workDir)
  const affected = collectAffectedPathsFromPlan(plan)
  const { buildContractContext } = await import("@bollard/verify/src/contract-extractor.js")
  const contract = await buildContractContext(affected, profile, workDir, (m) =>
    log(`${DIM}${m}${RESET}`),
  )

  process.stdout.write(`${JSON.stringify(contract, null, 2)}\n`)
  log("")
}

async function runBehavioralCommand(args: string[]): Promise<void> {
  const workDir = resolveWorkspaceDirFromArgs(args)

  header("behavioral")
  log(`${DIM}Work dir:${RESET} ${workDir}`)

  const { profile } = await resolveConfig(undefined, workDir)
  const { buildBehavioralContext } = await import("@bollard/verify/src/behavioral-extractor.js")
  const behavioral = await buildBehavioralContext(profile, workDir, (m) =>
    log(`${DIM}${m}${RESET}`),
  )

  process.stdout.write(`${JSON.stringify(behavioral, null, 2)}\n`)
  log("")
}

async function runVerifyCommand(args: string[]): Promise<void> {
  const workDir = resolveWorkspaceDirFromArgs(args)

  // Check if --profile flag is present
  if (args.includes("--profile")) {
    const { detectToolchain } = await import("@bollard/detect/src/detect.js")
    const profile = await detectToolchain(workDir)
    process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`)
    process.exit(0)
  }

  const quiet = args.includes("--quiet")

  const { results, allPassed } = await runStaticChecks(workDir)

  if (quiet) {
    const payload = formatQuietVerifyResult(results, allPassed)
    if (payload) {
      process.stdout.write(`${JSON.stringify(payload)}\n`)
    }
    process.exit(allPassed ? 0 : 1)
  }

  header("verify")
  log(`${DIM}Running static checks...${RESET}\n`)

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

async function runDiffCommand(args: string[]): Promise<void> {
  const workDir = resolveWorkspaceDirFromArgs(args)

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

  const advKeys = Object.keys(diff.adversarial)
  if (advKeys.length > 0) {
    log(`\n${BOLD}Adversarial (vs defaults):${RESET}`)
    log(`  ${DIM}${JSON.stringify(diff.adversarial, null, 2).split("\n").join("\n  ")}${RESET}`)
  } else {
    log(
      `\n${BOLD}Adversarial:${RESET} ${DIM}matches default matrix for ${profile.language}${RESET}`,
    )
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

  const configCwd = resolveWorkspaceDirFromArgs(args)
  const { config, profile } = await resolveConfig(undefined, configCwd)

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
    const workDir = configCwd
    const { handler, llmConfig } = await createAgenticHandler(config, workDir, profile)
    const blueprint = createImplementFeatureBlueprint(workDir, {
      provider: llmConfig.provider,
      model: llmConfig.model,
    })

    header("run implement-feature")
    log(`${DIM}Task:${RESET}      ${task}`)
    log(`${DIM}Work dir:${RESET}  ${workDir}`)
    log(`${DIM}Blueprint:${RESET} ${blueprint.name} (${blueprint.nodes.length} steps)`)
    log(
      `${DIM}Limits:${RESET}    $${blueprint.maxCostUsd} cost / ${blueprint.maxDurationMinutes}min`,
    )
    log("")

    const result = await runBlueprint(
      blueprint,
      task,
      config,
      handler,
      humanGateHandler,
      cliProgress,
      profile,
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

async function runPromoteTestCommand(args: string[]): Promise<void> {
  const testPath = args[0]
  if (!testPath) {
    log("Usage: bollard promote-test <path-to-adversarial-test>")
    process.exit(1)
  }

  const workDir = findWorkspaceRoot(process.cwd())
  const { access, copyFile, mkdir, readFile: rf, writeFile: wf } = await import("node:fs/promises")
  const { basename } = await import("node:path")

  header("promote-test")

  const fullSource = resolve(workDir, testPath)

  try {
    await access(fullSource)
  } catch {
    log(`${RED}✗${RESET} Source file not found: ${testPath}`)
    process.exit(1)
  }

  const fileName = basename(testPath)
  const testsDir = join(workDir, "tests")
  await mkdir(testsDir, { recursive: true })

  const destPath = join(testsDir, fileName)

  try {
    await access(destPath)
    log(`${YELLOW}!${RESET} File already exists: tests/${fileName} — overwriting`)
  } catch {
    // destination doesn't exist — good
  }

  await copyFile(fullSource, destPath)

  let content = await rf(destPath, "utf-8")
  content = content.replace(/\/\/\s*@bollard-generated.*\n?/g, "")
  content = content.replace(/#\s*@bollard-generated.*\n?/g, "")
  await wf(destPath, content, "utf-8")

  log(`${GREEN}✓${RESET} Promoted: ${testPath} → tests/${fileName}`)
  log("")
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

  if (command === "contract") {
    await runContractCommand(rest)
    return
  }

  if (command === "behavioral") {
    await runBehavioralCommand(rest)
    return
  }

  if (command === "diff") {
    await runDiffCommand(rest)
    return
  }

  if (command === "config" && rest[0] === "show") {
    const configCwd = resolveWorkspaceDirFromArgs(rest)
    const { config, profile, sources } = await resolveConfig(undefined, configCwd)
    const showSources = rest.includes("--sources")
    const output = showSources ? { config, profile, sources } : config
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
    return
  }

  if (command === "init") {
    header("init")
    const workDir = resolveWorkspaceDirFromArgs(rest)
    const { profile, sources } = await resolveConfig(undefined, workDir)
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
    log("  Layer 2 (adversarial tests): bollard/verify container")
    if (profile.mutation?.enabled) {
      log(
        `  Layer 3 (mutation testing):  ${BOLD}${profile.mutation.tool}${RESET} (threshold: ${profile.mutation.threshold}%, concurrency: ${profile.mutation.concurrency})`,
      )
    } else {
      log(`  Layer 3 (mutation testing):  ${DIM}not configured${RESET}`)
    }
    log("")

    const adversarialMode = rest.includes("--mode=in-language")
      ? "in-language"
      : rest.includes("--mode=both")
        ? "both"
        : "blackbox"

    const adversarialPersist = rest.includes("--persist")
    const boundaryLifecycle = adversarialPersist ? "persistent" : "ephemeral"

    const formatScope = (name: "boundary" | "contract" | "behavioral") => {
      const s = profile.adversarial[name]
      const concernStr = Object.entries(s.concerns)
        .filter(([, w]) => w !== "off")
        .map(([k, w]) => `${k}=${w}`)
        .join(", ")
      log(`  ${BOLD}${name}:${RESET}`)
      log(`    enabled:      ${s.enabled}`)
      log(`    integration:  ${s.integration}`)
      log(`    lifecycle:    ${s.lifecycle}`)
      log(`    frameworkOK:  ${String(s.frameworkCapable ?? false)}`)
      if (name === "boundary" && s.mode !== undefined) log(`    mode:         ${s.mode}`)
      log(`    concerns:     ${concernStr || "(all off)"}`)
    }

    log("Adversarial scopes (see examples/bollard.yml for full YAML options):")
    formatScope("boundary")
    formatScope("contract")
    formatScope("behavioral")
    log("")

    const mcpManifest = {
      mcpServers: {
        bollard: {
          command: "pnpm",
          args: ["--filter", "@bollard/mcp", "run", "start"],
          env: {
            ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}",
          },
        },
      },
    }

    const { mkdir: mkdirFs, writeFile: writeFs } = await import("node:fs/promises")
    const bollardDir = join(workDir, ".bollard")
    await mkdirFs(bollardDir, { recursive: true })
    await writeFs(join(bollardDir, "mcp.json"), JSON.stringify(mcpManifest, null, 2), "utf-8")
    log(`${GREEN}✓${RESET} Created .bollard/mcp.json`)

    const bollardYml = [
      "# Bollard configuration",
      "# Generated by bollard init — see examples/bollard.yml for all adversarial options",
      "",
      "adversarial:",
      "  boundary:",
      `    mode: ${adversarialMode}`,
      `    lifecycle: ${boundaryLifecycle}`,
      "  contract:",
      "    enabled: true",
      "  behavioral:",
      "    enabled: false",
      "",
    ].join("\n")

    await writeFs(join(workDir, ".bollard.yml"), bollardYml, "utf-8")
    log(`${GREEN}✓${RESET} Created .bollard.yml`)
    log("")

    const ideIdx = rest.indexOf("--ide")
    if (ideIdx !== -1) {
      const ideFlag = rest[ideIdx + 1]
      if (!ideFlag) {
        throw new BollardError({
          code: "IDE_CONFIG_INVALID",
          message:
            "Missing value for --ide. Use: bollard init --ide <platform> (cursor, claude-code, codex, antigravity, or all)",
        })
      }
      const { parseIdePlatform } = await import("./ide-detect.js")
      const { generateIdeConfigs, writeGeneratedFiles } = await import("./init-ide.js")

      const platforms = parseIdePlatform(ideFlag)
      const ideResults = await generateIdeConfigs(workDir, platforms, profile)

      for (const result of ideResults) {
        log(`\n${BOLD}${result.platform}:${RESET}`)
        const { written, skipped } = await writeGeneratedFiles(workDir, result)
        for (const f of written) {
          log(`  ${GREEN}✓${RESET} ${f}`)
        }
        for (const f of skipped) {
          log(`  ${YELLOW}⊘${RESET} ${f} (already exists, skipped)`)
        }
        for (const msg of result.messages) {
          if (msg.startsWith("⚠")) {
            log(`  ${YELLOW}${msg}${RESET}`)
          } else {
            log(`  ${DIM}${msg}${RESET}`)
          }
        }
      }
      log("")
    }

    return
  }

  if (command === "watch") {
    const workDir = resolveWorkspaceDirFromArgs(rest)
    const { profile } = await resolveConfig(undefined, workDir)
    const quiet = rest.includes("--quiet")
    const json = rest.includes("--json")
    const debounceIdx = rest.indexOf("--debounce")
    const debounceMs =
      debounceIdx !== -1 ? Number.parseInt(rest[debounceIdx + 1] ?? "1500", 10) : undefined

    const { runWatch } = await import("./watch.js")
    await runWatch({
      workDir,
      profile,
      quiet,
      json,
      ...(debounceMs !== undefined ? { debounceMs } : {}),
    })
    return
  }

  if (command === "doctor") {
    const workDir = resolveWorkspaceDirFromArgs(rest)
    const jsonMode = rest.includes("--json")
    const report = await runDoctor(workDir)
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    } else {
      header("doctor")
      log(formatDoctorReport(report))
    }
    process.exit(report.allPassed ? 0 : 1)
  }

  if (command === "eval") {
    await runEvalCommand(rest)
    return
  }

  if (command === "promote-test") {
    await runPromoteTestCommand(rest)
    return
  }

  if (command === "probe") {
    await runProbeCommand(rest)
    return
  }

  if (command === "deploy") {
    await runDeployCommand(rest)
    return
  }

  if (command === "flag") {
    await runFlagCommand(rest)
    return
  }

  if (command === "drift") {
    await runDriftCommand(rest)
    return
  }

  log(`\n${BOLD}${CYAN}bollard${RESET} — artifact integrity framework\n`)
  log("Commands:\n")
  log(`  ${BOLD}run${RESET} <blueprint> --task <task>   Run a blueprint`)
  log(`  ${BOLD}plan${RESET} --task <task>              Generate a plan without implementing`)
  log(
    `  ${BOLD}verify${RESET} [--profile] [--quiet]   Run static checks (or show profile; --quiet JSON on fail)`,
  )
  log(
    `  ${BOLD}contract${RESET} [--plan <file>]         Print ContractContext JSON (optional planner plan)`,
  )
  log(`  ${BOLD}behavioral${RESET} [--work-dir <path>]   Print BehavioralContext JSON`)
  log(`  ${BOLD}diff${RESET}                            Compare profile vs hardcoded defaults`)
  log(`  ${BOLD}eval${RESET} [agent]                    Run agent eval sets`)
  log(`  ${BOLD}config show${RESET} [--sources]         Show resolved configuration`)
  log(
    `  ${BOLD}init${RESET} [--ide <platform>]        Detect project configuration + optional IDE configs`,
  )
  log(
    `  ${BOLD}watch${RESET} [--quiet] [--json] [--debounce N] Continuous verification on file changes`,
  )
  log(
    `    ${DIM}--json: one ndjson line per verify on stdout (pass|fail|error); with --quiet, skips quiet fail-only JSON${RESET}`,
  )
  log(
    `  ${BOLD}doctor${RESET} [--json]                  Check environment health (docker, LLM key, toolchain)`,
  )
  log(
    `  ${BOLD}promote-test${RESET} <path>             Promote adversarial test to project test dir`,
  )
  log(`  ${BOLD}probe${RESET} run|watch|list           Production probes (HTTP)`)
  log(`  ${BOLD}deploy${RESET} record|list|current      Deployment metadata`)
  log(`  ${BOLD}flag${RESET} set|list|kill             Feature flags (file-based)`)
  log(`  ${BOLD}drift${RESET} check|watch             Git drift vs last verified`)
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
