import { join } from "node:path"
import {
  type AgentEvalScore,
  type EvalBaseline,
  compareToEvalBaseline,
  readEvalBaseline,
  writeEvalBaseline,
} from "@bollard/engine/src/eval-baseline.js"
import { runEvals } from "@bollard/engine/src/eval-runner.js"
import { LLMClient } from "@bollard/llm/src/client.js"
import { resolveConfig } from "./config.js"
import { BOLD, CYAN, DIM, GREEN, RED, RESET, YELLOW } from "./terminal-styles.js"

function log(msg: string): void {
  process.stderr.write(`${msg}\n`)
}

function header(title: string): void {
  log(`\n${BOLD}${CYAN}bollard${RESET} ${BOLD}${title}${RESET}`)
  log(`${DIM}${"─".repeat(50)}${RESET}`)
}

function padEndVisible(s: string, width: number): string {
  const stripped = s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "")
  const pad = Math.max(0, width - stripped.length)
  return `${s}${" ".repeat(pad)}`
}

function baselinePathForWorkDir(workDir: string): string {
  return join(workDir, ".bollard", "eval-baseline.json")
}

function formatBaselineDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

function formatPassRatePct(passRate: number): string {
  return `${(passRate * 100).toFixed(1)}%`
}

const EVAL_AGENTS = [
  "planner",
  "coder",
  "boundary-tester",
  "contract-tester",
  "behavioral-tester",
] as const

interface ParsedTagArgs {
  tag: string
  model?: string
  thresholdPct: number
  notes?: string
  positionalTail: string[]
}

function parseTagArgs(rest: string[]): ParsedTagArgs {
  const out: ParsedTagArgs = {
    tag: "",
    thresholdPct: 10,
    positionalTail: [],
  }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === undefined) continue
    if (a === "--work-dir") {
      i++
      continue
    }
    if (a === "--model") {
      const v = rest[++i]
      if (!v) {
        log(`${RED}Missing value for --model${RESET}`)
        process.exit(1)
      }
      out.model = v
      continue
    }
    if (a === "--threshold") {
      const v = Number.parseFloat(rest[++i] ?? "")
      if (!Number.isFinite(v) || v <= 0) {
        log(`${RED}Invalid --threshold${RESET}`)
        process.exit(1)
      }
      out.thresholdPct = v
      continue
    }
    if (a === "--notes") {
      const v = rest[++i]
      if (v === undefined) {
        log(`${RED}Missing value for --notes${RESET}`)
        process.exit(1)
      }
      out.notes = v
      continue
    }
    if (a.startsWith("-")) {
      log(`${RED}Unknown flag:${RESET} ${a}`)
      process.exit(1)
    }
    out.positionalTail.push(a)
  }
  out.tag = out.positionalTail[0] ?? ""
  if (!out.tag) {
    log(
      "Usage: bollard eval tag <tag-name> [--model <model>] [--threshold <pct>] [--notes <text>] [--work-dir <path>]\n  --model forces all agents onto one model (A/B override; default resolves per agent via forAgent)",
    )
    process.exit(1)
  }
  return out
}

export async function runAllAgentScores(
  workDir: string,
  modelOverride: string | undefined,
  thresholdPct: number,
): Promise<{ scores: AgentEvalScore[]; model: string }> {
  const { config } = await resolveConfig(undefined, workDir)
  const llmClient = new LLMClient(config)
  const { model: defaultModel } = llmClient.forAgent("default")

  const { loadEvalCases } = await import("@bollard/agents/src/eval-loader.js")
  const scores: AgentEvalScore[] = []

  for (const agent of EVAL_AGENTS) {
    const cases = loadEvalCases(agent)
    if (cases.length === 0) continue

    const { provider, model: agentModel } = llmClient.forAgent(agent)
    const model = modelOverride ?? agentModel
    const evalProvider = { chat: provider.chat.bind(provider) }

    log(`${DIM}Running ${agent} (${String(cases.length)} case(s))...${RESET}`)
    const results = await runEvals(cases, evalProvider, { model, runs: 1 })
    const passRate = results.length > 0 ? results.filter((r) => r.ok).length / results.length : 0

    scores.push({
      agent,
      caseCount: cases.length,
      passRate,
      thresholdPct,
      model,
    })
  }

  return { scores, model: modelOverride ?? defaultModel }
}

function printScoresTable(scores: AgentEvalScore[]): void {
  log(
    `${padEndVisible(`${BOLD}Agent${RESET}`, 22)} ${padEndVisible(`${BOLD}Cases${RESET}`, 8)} ${padEndVisible(`${BOLD}Pass rate${RESET}`, 12)} ${BOLD}Threshold${RESET}`,
  )
  for (const s of scores) {
    const agentLabel = s.model ? `${s.agent} ${DIM}${s.model}${RESET}` : s.agent
    log(
      `${padEndVisible(agentLabel, 22)} ${padEndVisible(String(s.caseCount), 8)} ${padEndVisible(formatPassRatePct(s.passRate), 12)} ${String(s.thresholdPct)}%`,
    )
  }
  log("")
}

function printBaselineBody(workDir: string, b: EvalBaseline): void {
  log(`${DIM}Work dir:${RESET} ${workDir}\n`)
  log(`${padEndVisible(`${BOLD}Tag${RESET}`, 14)} ${b.tag}`)
  log(`${padEndVisible(`${BOLD}Recorded${RESET}`, 14)} ${formatBaselineDate(b.timestamp)}`)
  log(`${padEndVisible(`${BOLD}Model${RESET}`, 14)} ${b.model}`)
  if (b.notes) log(`${padEndVisible(`${BOLD}Notes${RESET}`, 14)} ${b.notes}`)
  log("")
  printScoresTable(b.scores)
}

async function cmdTag(workDir: string, pos: string[]): Promise<void> {
  const parsed = parseTagArgs(pos.slice(1))
  const path = baselinePathForWorkDir(workDir)

  log(`${DIM}Tagging eval baseline (live LLM calls)...${RESET}\n`)
  const { scores, model } = await runAllAgentScores(workDir, parsed.model, parsed.thresholdPct)

  if (scores.length === 0) {
    log(`${RED}No eval cases found for any agent.${RESET}`)
    process.exit(1)
  }

  const baseline: EvalBaseline = {
    tag: parsed.tag,
    timestamp: Date.now(),
    model,
    scores,
    ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
  }

  await writeEvalBaseline(path, baseline)
  header("eval tag")
  log(`${DIM}Wrote:${RESET}     ${path}\n`)
  printBaselineBody(workDir, baseline)
}

async function cmdShow(workDir: string): Promise<void> {
  const path = baselinePathForWorkDir(workDir)
  const b = await readEvalBaseline(path)
  if (!b) {
    log(`${RED}No baseline file at ${path}${RESET}`)
    process.exit(1)
  }
  header("eval show")
  log(`${DIM}File:${RESET} ${path}\n`)
  printBaselineBody(workDir, b)
}

async function cmdDiff(workDir: string): Promise<void> {
  const path = baselinePathForWorkDir(workDir)
  const baseline = await readEvalBaseline(path)
  if (!baseline) {
    log(`${RED}No baseline file at ${path}${RESET}`)
    process.exit(1)
  }

  const firstThreshold = baseline.scores[0]?.thresholdPct ?? 10
  log(`${DIM}Re-running evals (live LLM calls, ~$0.10)...${RESET}\n`)
  const { scores: current, model } = await runAllAgentScores(workDir, undefined, firstThreshold)

  if (model !== baseline.model) {
    log(
      `${YELLOW}Warning:${RESET} current default model (${model}) differs from baseline default model (${baseline.model})`,
    )
    log("")
  }

  const baselineByAgentForModel = new Map(baseline.scores.map((s) => [s.agent, s]))
  for (const cur of current) {
    const base = baselineByAgentForModel.get(cur.agent)
    if (!base?.model || !cur.model || base.model === cur.model) continue
    log(`${YELLOW}Warning:${RESET} ${cur.agent} model changed (${base.model} → ${cur.model})`)
  }
  if (
    current.some((cur) => {
      const base = baselineByAgentForModel.get(cur.agent)
      return base?.model && cur.model && base.model !== cur.model
    })
  ) {
    log("")
  }

  const cmp = compareToEvalBaseline(baseline, current)
  const baselineByAgent = new Map(baseline.scores.map((s) => [s.agent, s]))
  const regressionAgents = new Set(cmp.regressions.map((r) => r.agent))

  header("eval diff")
  log(`${DIM}Work dir:${RESET} ${workDir}\n`)
  log(
    `${padEndVisible(`${BOLD}Baseline:${RESET}`, 12)} ${baseline.tag}  (${formatBaselineDate(baseline.timestamp)})`,
  )
  log(`${padEndVisible(`${BOLD}Model:${RESET}`, 12)} ${baseline.model}`)
  log("")

  log(
    `${padEndVisible(`${BOLD}Agent${RESET}`, 22)} ${padEndVisible(`${BOLD}Baseline${RESET}`, 10)} ${padEndVisible(`${BOLD}Current${RESET}`, 10)} ${padEndVisible(`${BOLD}Delta${RESET}`, 10)} ${BOLD}Result${RESET}`,
  )

  for (const cur of current) {
    const base = baselineByAgent.get(cur.agent)
    if (!base) continue

    const deltaPp = (cur.passRate - base.passRate) * 100
    const deltaStr = `${deltaPp >= 0 ? "+" : ""}${deltaPp.toFixed(1)}pp`
    const failed = regressionAgents.has(cur.agent)
    const result = failed ? `${RED}FAIL${RESET}` : `${GREEN}PASS${RESET}`

    log(
      `${padEndVisible(cur.agent, 22)} ${padEndVisible(formatPassRatePct(base.passRate), 10)} ${padEndVisible(formatPassRatePct(cur.passRate), 10)} ${padEndVisible(deltaStr, 10)} ${result}`,
    )
  }
  log("")

  if (cmp.verdict === "fail") {
    log(`${RED}FAIL${RESET} — ${String(cmp.regressions.length)} agent(s) regressed`)
    log("")
    process.exit(1)
  }

  log(`${GREEN}PASS${RESET} — all agents within threshold`)
  log("")
}

export async function runEvalBaselineCommand(rest: string[], workDir: string): Promise<void> {
  const pos = rest.filter((a, i, arr) => {
    if (a === "--work-dir") return false
    if (i > 0 && arr[i - 1] === "--work-dir") return false
    return true
  })
  const sub = pos[0]
  if (sub === "tag") {
    await cmdTag(workDir, pos)
    return
  }
  if (sub === "show") {
    await cmdShow(workDir)
    return
  }
  if (sub === "diff") {
    await cmdDiff(workDir)
    return
  }

  log(
    "Usage: bollard eval <tag|show|diff> ... [--work-dir <path>]\n  tag <tag-name> [--model <model>] [--threshold <pct>] [--notes <text>]\n    --model forces all agents onto one model (A/B override; default resolves per agent)\n  show\n  diff",
  )
  process.exit(1)
}
