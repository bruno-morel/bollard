import { join } from "node:path"
import {
  type CostBaseline,
  compareToBaseline,
  readBaseline,
  writeBaseline,
} from "@bollard/engine/src/cost-baseline.js"
import type { RunRecord } from "@bollard/engine/src/run-history.js"
import { FileRunHistoryStore } from "@bollard/engine/src/run-history.js"
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
  return join(workDir, ".bollard", "cost-baseline.json")
}

interface ParsedTagArgs {
  tag: string
  runId?: string
  thresholdPct: number
  notes?: string
  positionalTail: string[]
}

function parseTagArgs(rest: string[]): ParsedTagArgs {
  const out: ParsedTagArgs = {
    tag: "",
    thresholdPct: 15,
    positionalTail: [],
  }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === undefined) continue
    if (a === "--work-dir") {
      i++
      continue
    }
    if (a === "--run-id") {
      const v = rest[++i]
      if (!v) {
        log(`${RED}Missing value for --run-id${RESET}`)
        process.exit(1)
      }
      out.runId = v
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
      "Usage: bollard cost-baseline tag <tag-name> [--run-id <id>] [--threshold <pct>] [--notes <text>] [--work-dir <path>]",
    )
    process.exit(1)
  }
  return out
}

function formatBaselineDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

function printBaselineBody(workDir: string, b: CostBaseline): void {
  log(`${DIM}Work dir:${RESET} ${workDir}\n`)
  log(`${padEndVisible(`${BOLD}Tag${RESET}`, 14)} ${b.tag}`)
  log(`${padEndVisible(`${BOLD}Run ID${RESET}`, 14)} ${b.runId}`)
  log(`${padEndVisible(`${BOLD}Recorded${RESET}`, 14)} ${formatBaselineDate(b.timestamp)}`)
  log(`${padEndVisible(`${BOLD}Blueprint${RESET}`, 14)} ${b.blueprintId}`)
  log(`${padEndVisible(`${BOLD}Baseline cost${RESET}`, 14)} $${b.totalCostUsd.toFixed(4)}`)
  log(`${padEndVisible(`${BOLD}Threshold${RESET}`, 14)} ${b.thresholdPct}%`)
  if (b.coderTurns !== undefined) {
    log(`${padEndVisible(`${BOLD}Coder turns${RESET}`, 14)} ${String(b.coderTurns)}`)
  }
  if (b.avgInputTokensPerTurn !== undefined) {
    log(`${padEndVisible(`${BOLD}Avg in tok/turn${RESET}`, 14)} ${String(b.avgInputTokensPerTurn)}`)
  }
  if (b.notes) log(`${padEndVisible(`${BOLD}Notes${RESET}`, 14)} ${b.notes}`)
  log("")
}

async function cmdTag(workDir: string, pos: string[]): Promise<void> {
  const parsed = parseTagArgs(pos.slice(1))
  const path = baselinePathForWorkDir(workDir)
  const store = new FileRunHistoryStore(workDir)

  let rec: RunRecord | undefined
  if (parsed.runId) {
    const found = await store.findByRunId(parsed.runId)
    if (!found || found.type !== "run") {
      log(`${RED}No pipeline run found for run id:${RESET} ${parsed.runId}`)
      process.exit(1)
    }
    rec = found
  } else {
    const rows = await store.query({
      blueprintId: "implement-feature",
      status: "success",
      limit: 1,
      offset: 0,
    })
    const first = rows[0]
    if (!first || first.type !== "run") {
      log(`${RED}No successful implement-feature run found in history.${RESET}`)
      process.exit(1)
    }
    rec = first
  }

  const baseline: CostBaseline = {
    tag: parsed.tag,
    runId: rec.runId,
    timestamp: Date.now(),
    blueprintId: rec.blueprintId,
    totalCostUsd: rec.totalCostUsd,
    thresholdPct: parsed.thresholdPct,
    ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
  }

  await writeBaseline(path, baseline)
  header("cost-baseline tag")
  log(`${DIM}Wrote:${RESET}     ${path}\n`)
  printBaselineBody(workDir, baseline)
}

async function cmdShow(workDir: string): Promise<void> {
  const path = baselinePathForWorkDir(workDir)
  const b = await readBaseline(path)
  if (!b) {
    log(`${RED}No baseline file at ${path}${RESET}`)
    process.exit(1)
  }
  header("cost-baseline show")
  log(`${DIM}File:${RESET} ${path}\n`)
  printBaselineBody(workDir, b)
}

async function cmdDiff(workDir: string): Promise<void> {
  const path = baselinePathForWorkDir(workDir)
  const baseline = await readBaseline(path)
  if (!baseline) {
    log(`${RED}No baseline file at ${path}${RESET}`)
    process.exit(1)
  }

  const store = new FileRunHistoryStore(workDir)
  const cmp = await compareToBaseline(baseline, store)

  header("cost-baseline diff")
  log(`${DIM}Work dir:${RESET} ${workDir}\n`)
  log(
    `${padEndVisible(`${BOLD}Baseline:${RESET}`, 12)} ${baseline.tag}  (${baseline.runId}, ${formatBaselineDate(baseline.timestamp)})`,
  )
  log(`${padEndVisible(`${BOLD}Cost:${RESET}`, 12)} $${baseline.totalCostUsd.toFixed(4)}`)
  log(`${padEndVisible(`${BOLD}Threshold:${RESET}`, 12)} ${baseline.thresholdPct}%`)

  let currentLine: string
  if (cmp.verdict === "insufficient_data") {
    currentLine = `insufficient data (${String(cmp.current.runCount)} ${baseline.blueprintId} successful runs since baseline)`
  } else {
    currentLine = `$${cmp.current.avgCostUsd.toFixed(4)} avg over ${String(cmp.current.runCount)} run(s) since baseline`
  }
  log(`${padEndVisible(`${BOLD}Current:${RESET}`, 12)} ${currentLine}`)

  let verdictLine: string
  let exitCode = 0
  if (cmp.verdict === "insufficient_data") {
    verdictLine = `${YELLOW}INSUFFICIENT DATA${RESET} — need ≥ 3 runs to evaluate`
  } else if (cmp.verdict === "pass") {
    verdictLine = `${GREEN}PASS${RESET} — regression ${cmp.regressionPct.toFixed(2)}% (≤ ${String(baseline.thresholdPct)}%)`
  } else {
    verdictLine = `${RED}FAIL${RESET} — regression ${cmp.regressionPct.toFixed(2)}% (> ${String(baseline.thresholdPct)}%)`
    exitCode = 1
  }
  log(
    `${padEndVisible(`${BOLD}Regression:${RESET}`, 12)} ${cmp.verdict === "insufficient_data" ? "—" : `${cmp.regressionPct.toFixed(2)}%`}`,
  )
  log(`${padEndVisible(`${BOLD}Verdict:${RESET}`, 12)} ${verdictLine}`)
  log("")

  if (exitCode !== 0) {
    process.exit(exitCode)
  }
}

export async function runCostBaselineCommand(rest: string[], workDir: string): Promise<void> {
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
    "Usage: bollard cost-baseline <tag|show|diff> ... [--work-dir <path>]\n  tag <tag-name> [--run-id <id>] [--threshold <pct>] [--notes <text>]\n  show\n  diff",
  )
  process.exit(1)
}
