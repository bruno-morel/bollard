import type { HistoryFilter, HistoryRecord, RunRecord } from "@bollard/engine/src/run-history.js"
import { FileRunHistoryStore } from "@bollard/engine/src/run-history.js"
import { BOLD, CYAN, DIM, GREEN, RED, RESET, YELLOW } from "./terminal-styles.js"

function log(msg: string): void {
  process.stderr.write(`${msg}\n`)
}

function header(title: string): void {
  log(`\n${BOLD}${CYAN}bollard${RESET} ${BOLD}${title}${RESET}`)
  log(`${DIM}${"─".repeat(50)}${RESET}`)
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const sec = s % 60
  if (m === 0) return `${sec}s`
  return `${m}m ${sec.toString().padStart(2, "0")}s`
}

function statusIcon(status: string): string {
  if (status === "ok") return `${GREEN}✓${RESET}`
  if (status === "fail") return `${RED}✗${RESET}`
  if (status === "block") return `${YELLOW}■${RESET}`
  return `${DIM}…${RESET}`
}

function padEndVisible(s: string, width: number): string {
  const stripped = s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "")
  const pad = Math.max(0, width - stripped.length)
  return `${s}${" ".repeat(pad)}`
}

interface ParsedHistoryCli {
  json: boolean
  limit: number
  offset: number
  sinceMs?: number
  untilMs?: number
  status?: RunRecord["status"]
  blueprintId?: string
  positional: string[]
}

function parseSinceArg(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) {
    log(`${RED}Invalid --since or --until date:${RESET} ${value}`)
    process.exit(1)
  }
  return ms
}

function parseHistoryCliArgs(rest: string[]): ParsedHistoryCli {
  const out: ParsedHistoryCli = {
    json: false,
    limit: 10,
    offset: 0,
    positional: [],
  }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === undefined) continue
    if (a === "--json") {
      out.json = true
      continue
    }
    if (a === "--limit") {
      out.limit = Number.parseInt(rest[++i] ?? "", 10)
      if (!Number.isFinite(out.limit) || out.limit < 0) {
        log(`${RED}Invalid --limit${RESET}`)
        process.exit(1)
      }
      continue
    }
    if (a === "--offset") {
      out.offset = Number.parseInt(rest[++i] ?? "", 10)
      if (!Number.isFinite(out.offset) || out.offset < 0) {
        log(`${RED}Invalid --offset${RESET}`)
        process.exit(1)
      }
      continue
    }
    if (a === "--since") {
      const v = parseSinceArg(rest[++i])
      if (v !== undefined) {
        out.sinceMs = v
      }
      continue
    }
    if (a === "--until") {
      const v = parseSinceArg(rest[++i])
      if (v !== undefined) {
        out.untilMs = v
      }
      continue
    }
    if (a === "--status") {
      const v = rest[++i]
      if (v !== "success" && v !== "failure" && v !== "handed_to_human") {
        log(`${RED}Invalid --status (use success | failure | handed_to_human)${RESET}`)
        process.exit(1)
      }
      out.status = v
      continue
    }
    if (a === "--blueprint") {
      const v = rest[++i]
      if (!v) {
        log(`${RED}Missing value for --blueprint${RESET}`)
        process.exit(1)
      }
      out.blueprintId = v
      continue
    }
    if (a === "--work-dir") {
      i++
      continue
    }
    if (a.startsWith("-")) {
      log(`${RED}Unknown flag:${RESET} ${a}`)
      process.exit(1)
    }
    out.positional.push(a)
  }
  return out
}

function listRow(rec: HistoryRecord): { cells: string[] } {
  if (rec.type === "verify") {
    const status = rec.allPassed ? "success" : "failure"
    return {
      cells: [
        padEndVisible(rec.runId, 40),
        "verify",
        status,
        "—",
        formatMs(rec.totalDurationMs),
        "—",
      ],
    }
  }
  const t = rec.testCount
  const testStr = `${t.passed}p ${t.failed}f`
  return {
    cells: [
      padEndVisible(rec.runId, 40),
      "run",
      rec.status,
      `$${rec.totalCostUsd.toFixed(2)}`,
      formatMs(rec.totalDurationMs),
      testStr,
    ],
  }
}

async function cmdList(workDir: string, parsed: ParsedHistoryCli): Promise<void> {
  const store = new FileRunHistoryStore(workDir)
  const filter: HistoryFilter = {
    limit: parsed.limit,
    offset: parsed.offset,
    ...(parsed.sinceMs !== undefined ? { since: parsed.sinceMs } : {}),
    ...(parsed.untilMs !== undefined ? { until: parsed.untilMs } : {}),
    ...(parsed.status !== undefined ? { status: parsed.status } : {}),
    ...(parsed.blueprintId !== undefined ? { blueprintId: parsed.blueprintId } : {}),
  }
  const rows = await store.query(filter)
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
    return
  }
  header("history")
  log(`${DIM}Work dir:${RESET} ${workDir}\n`)
  const headers = ["Run ID", "Type", "Status", "Cost", "Duration", "Tests"]
  const widths = [40, 8, 14, 8, 10, 10]
  const headLine = headers.map((h, i) => padEndVisible(h, widths[i] ?? 8)).join("  ")
  log(`${BOLD}${headLine}${RESET}`)
  log(`${DIM}${"─".repeat(92)}${RESET}`)
  for (const rec of rows) {
    const { cells } = listRow(rec)
    log(cells.map((c, i) => padEndVisible(c, widths[i] ?? 8)).join("  "))
  }
  log("")
}

async function cmdShow(workDir: string, runId: string, json: boolean): Promise<void> {
  const store = new FileRunHistoryStore(workDir)
  const rec = await store.findByRunId(runId)
  if (!rec) {
    log(`${RED}No record found for run id:${RESET} ${runId}`)
    process.exit(1)
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(rec, null, 2)}\n`)
    return
  }
  header("history show")
  if (rec.type === "verify") {
    log(`${BOLD}Verify:${RESET} ${rec.runId}`)
    log(`${DIM}Work dir:${RESET} ${rec.workDir}`)
    log(`${DIM}When:${RESET}     ${new Date(rec.timestamp).toISOString()}`)
    log(
      `${DIM}Result:${RESET}   ${rec.allPassed ? `${GREEN}all passed${RESET}` : `${RED}failed${RESET}`}`,
    )
    log(`${DIM}Duration:${RESET} ${formatMs(rec.totalDurationMs)}`)
    if (rec.language) log(`${DIM}Language:${RESET} ${rec.language}`)
    if (rec.gitSha) log(`${DIM}SHA:${RESET}       ${rec.gitSha.slice(0, 7)}`)
    log(`\n${BOLD}Checks:${RESET}`)
    for (const c of rec.checks) {
      log(
        `  ${statusIcon(c.passed ? "ok" : "fail")} ${c.name}  ${DIM}${formatMs(c.durationMs)}${RESET}`,
      )
    }
    log("")
    return
  }

  log(`${BOLD}Run:${RESET}       ${rec.runId}`)
  log(`${BOLD}Task:${RESET}      ${rec.task}`)
  log(`${BOLD}Blueprint:${RESET} ${rec.blueprintId}`)
  log(`${BOLD}Status:${RESET}    ${rec.status}`)
  log(
    `${DIM}Cost:${RESET}      $${rec.totalCostUsd.toFixed(2)} | ${DIM}Duration:${RESET} ${formatMs(rec.totalDurationMs)}`,
  )
  if (rec.gitBranch) log(`${DIM}Branch:${RESET}    ${rec.gitBranch}`)
  if (rec.gitSha) log(`${DIM}SHA:${RESET}        ${rec.gitSha.slice(0, 7)}`)
  log(`\n${BOLD}Nodes:${RESET}`)
  for (const n of rec.nodes) {
    const cost =
      n.costUsd !== undefined && n.costUsd > 0
        ? ` $${n.costUsd.toFixed(2)}`
        : ` ${DIM}$0.00${RESET}`
    const dur = n.durationMs !== undefined ? formatMs(n.durationMs) : "—"
    log(`  ${statusIcon(n.status)} ${padEndVisible(n.name, 28)} ${padEndVisible(dur, 8)}${cost}`)
    if (n.error) {
      log(`      ${RED}${n.error.code}:${RESET} ${n.error.message}`)
    }
  }
  log(`\n${BOLD}Scopes:${RESET}`)
  for (const s of rec.scopes) {
    const en = s.enabled ? "on" : "off"
    const claims =
      s.claimsProposed !== undefined
        ? `${s.claimsProposed} claims → ${s.claimsGrounded ?? 0} grounded (${s.claimsDropped ?? 0} dropped)`
        : "—"
    const tests =
      s.testsPassed !== undefined
        ? ` | ${s.testsPassed} passed${s.testsFailed ? `, ${s.testsFailed} failed` : ""}`
        : ""
    log(`  ${s.scope.padEnd(12)} ${en.padEnd(4)} ${claims}${tests}`)
  }
  if (rec.mutationScore !== undefined) {
    log(`\n${BOLD}Mutation:${RESET} ${rec.mutationScore}%`)
  }
  const tc = rec.testCount
  log(`\n${BOLD}Tests:${RESET} ${tc.passed} passed, ${tc.skipped} skipped, ${tc.failed} failed`)
  log("")
}

async function cmdSummary(workDir: string, parsed: ParsedHistoryCli): Promise<void> {
  const store = new FileRunHistoryStore(workDir)
  const summary = await store.summary(parsed.sinceMs)
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    return
  }
  header("history summary")
  if (parsed.sinceMs !== undefined) {
    log(`${DIM}Since:${RESET} ${new Date(parsed.sinceMs).toISOString().slice(0, 10)}\n`)
  }
  log(`${BOLD}Total runs:${RESET}     ${summary.totalRuns}`)
  log(`${BOLD}Success rate:${RESET}   ${(summary.successRate * 100).toFixed(1)}%`)
  log(`${BOLD}Avg cost:${RESET}       $${summary.avgCostUsd.toFixed(2)}`)
  log(`${BOLD}Avg duration:${RESET}   ${formatMs(summary.avgDurationMs)}`)
  log(`${BOLD}Avg tests:${RESET}      ${Math.round(summary.avgTestCount)}`)
  if (summary.avgMutationScore !== undefined) {
    log(`${BOLD}Avg mutation:${RESET}   ${summary.avgMutationScore.toFixed(1)}%`)
  }
  const trendIcon =
    summary.costTrend === "increasing" ? "↑" : summary.costTrend === "decreasing" ? "↓" : "→"
  log(`${BOLD}Cost trend:${RESET}     ${summary.costTrend} ${trendIcon}`)

  const bpEntries = Object.entries(summary.byBlueprint)
  if (bpEntries.length > 0) {
    log(`\n${BOLD}By blueprint:${RESET}`)
    for (const [bp, stats] of bpEntries) {
      log(
        `  ${bp.padEnd(24)} ${String(stats.runs).padEnd(6)} runs  ${(stats.successRate * 100).toFixed(0)}% success  $${stats.avgCostUsd.toFixed(2)} avg`,
      )
    }
  }
  log("")
}

async function cmdRebuild(workDir: string, json: boolean): Promise<void> {
  const store = new FileRunHistoryStore(workDir)
  const result = await store.rebuild()
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  header("history rebuild")
  log(
    `${GREEN}Rebuilt SQLite index:${RESET} ${result.runCount} records in ${formatMs(result.durationMs)}`,
  )
  log("")
}

async function cmdCompare(workDir: string, idA: string, idB: string, json: boolean): Promise<void> {
  const store = new FileRunHistoryStore(workDir)
  try {
    const cmp = await store.compare(idA, idB)
    if (json) {
      process.stdout.write(`${JSON.stringify(cmp, null, 2)}\n`)
      return
    }
    header("history compare")
    log(`${DIM}A:${RESET} ${idA}`)
    log(`${DIM}B:${RESET} ${idB}\n`)
    const d = cmp.delta
    log(`${BOLD}Delta (B − A)${RESET}`)
    log(`  Cost:        $${d.costUsd.toFixed(4)}`)
    log(`  Duration:    ${formatMs(d.durationMs)}`)
    log(`  Test total:  ${d.testCountDelta >= 0 ? "+" : ""}${d.testCountDelta}`)
    if (d.mutationScoreDelta !== undefined) {
      log(
        `  Mutation:    ${d.mutationScoreDelta >= 0 ? "+" : ""}${d.mutationScoreDelta.toFixed(1)} pts`,
      )
    }
    if (d.newFailingNodes.length > 0) {
      log(`\n${RED}New failing nodes:${RESET} ${d.newFailingNodes.join(", ")}`)
    }
    if (d.newPassingNodes.length > 0) {
      log(`\n${GREEN}New passing nodes:${RESET} ${d.newPassingNodes.join(", ")}`)
    }
    if (d.scopeChanges.length > 0) {
      log(`\n${BOLD}Scope changes:${RESET}`)
      for (const ch of d.scopeChanges) {
        log(`  ${ch.scope}.${ch.field}: ${ch.from} → ${ch.to}`)
      }
    }
    log("")
  } catch (e) {
    log(`${RED}${e instanceof Error ? e.message : String(e)}${RESET}`)
    process.exit(1)
  }
}

export async function runHistoryCommand(rest: string[], workDir: string): Promise<void> {
  const parsed = parseHistoryCliArgs(rest)
  const pos = parsed.positional

  if (pos[0] === "show") {
    const id = pos[1]
    if (!id) {
      log("Usage: bollard history show <run-id> [--json]")
      process.exit(1)
    }
    await cmdShow(workDir, id, parsed.json)
    return
  }

  if (pos[0] === "compare") {
    const a = pos[1]
    const b = pos[2]
    if (!a || !b) {
      log("Usage: bollard history compare <run-id-a> <run-id-b> [--json]")
      process.exit(1)
    }
    await cmdCompare(workDir, a, b, parsed.json)
    return
  }

  if (pos[0] === "summary") {
    await cmdSummary(workDir, parsed)
    return
  }

  if (pos[0] === "rebuild") {
    await cmdRebuild(workDir, parsed.json)
    return
  }

  await cmdList(workDir, parsed)
}
