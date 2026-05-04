import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { detectToolchain } from "@bollard/detect/src/detect.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { FileRunHistoryStore } from "@bollard/engine/src/run-history.js"
import type { RunRecord } from "@bollard/engine/src/run-history.js"
import { parseHistoryLine } from "@bollard/engine/src/run-history.js"
import { BOLD, DIM, GREEN, RED, RESET, YELLOW } from "./terminal-styles.js"

const execFileAsync = promisify(execFile)

export type DoctorCheckStatus = "pass" | "fail"

export type DoctorCheckId = "docker" | "llm-key" | "toolchain"

export interface DoctorCheck {
  id: DoctorCheckId
  label: string
  status: DoctorCheckStatus
  detail: string
}

export type DoctorConfigNote = "custom config" | "using defaults"

export interface HistoryHealth {
  jsonlExists: boolean
  jsonlRecordCount: number
  dbExists: boolean
  dbCurrent: boolean
  dbRecordCount: number
  lastRebuildIso?: string
  lastRun?: { runId: string; status: string; timestamp: number; costUsd: number }
  costTrend?: "increasing" | "stable" | "decreasing"
  recentFailingNodes: string[]
  mutationScoreRange?: { min: number; max: number }
}

export interface DoctorReport {
  allPassed: boolean
  checks: DoctorCheck[]
  configNote: DoctorConfigNote
  historyHealth?: HistoryHealth
}

const LLM_KEY_NAMES = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY"] as const

function countVerificationChecks(checks: ToolchainProfile["checks"]): number {
  return Object.values(checks).filter((c) => c !== undefined).length
}

async function readJsonlRecordCount(jsonlPath: string): Promise<number> {
  if (!existsSync(jsonlPath)) return 0
  const text = await readFile(jsonlPath, "utf-8")
  let n = 0
  for (const line of text.split("\n")) {
    if (parseHistoryLine(line)) n++
  }
  return n
}

async function readSqliteMetadata(
  dbPath: string,
): Promise<{ recordCount: number; lastRebuildIso?: string } | null> {
  if (!existsSync(dbPath)) return null
  try {
    const { default: Database } = await import("better-sqlite3")
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    try {
      const countRow = db.prepare(`SELECT value FROM metadata WHERE key = 'record_count'`).get() as
        | { value: string }
        | undefined
      const rebuildRow = db
        .prepare(`SELECT value FROM metadata WHERE key = 'last_rebuild'`)
        .get() as { value: string } | undefined
      const recordCount = countRow?.value !== undefined ? Number.parseInt(countRow.value, 10) : 0
      return {
        recordCount: Number.isFinite(recordCount) ? recordCount : 0,
        ...(rebuildRow?.value !== undefined ? { lastRebuildIso: rebuildRow.value } : {}),
      }
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

function formatRelativeShort(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function formatRebuildAgo(iso?: string): string {
  if (!iso) return "unknown"
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return iso
  return formatRelativeShort(ms)
}

export async function checkHistoryHealth(workDir: string): Promise<HistoryHealth> {
  const jsonlPath = join(workDir, ".bollard", "runs", "history.jsonl")
  const dbPath = join(workDir, ".bollard", "runs", "history.db")
  const jsonlExists = existsSync(jsonlPath)
  const jsonlRecordCount = jsonlExists ? await readJsonlRecordCount(jsonlPath) : 0

  const store = new FileRunHistoryStore(workDir)
  const recent = await store.query({ limit: 200, offset: 0 })

  const dbExists = existsSync(dbPath)
  const meta = dbExists ? await readSqliteMetadata(dbPath) : null
  const dbRecordCount = meta?.recordCount ?? 0
  const dbCurrent = Boolean(dbExists && meta !== null && jsonlRecordCount === dbRecordCount)
  const runs = recent.filter((r): r is RunRecord => r.type === "run")
  const lastRun = runs[0]
    ? {
        runId: runs[0].runId,
        status: runs[0].status,
        timestamp: runs[0].timestamp,
        costUsd: runs[0].totalCostUsd,
      }
    : undefined

  const summary = await store.summary()
  const costTrend = summary.costTrend

  const runRecordsChrono = [...runs].sort((a, b) => a.timestamp - b.timestamp)
  const lastThree = runRecordsChrono.slice(-3)
  const recentFailingNodes: string[] = []
  for (const r of lastThree) {
    for (const n of r.nodes) {
      if (n.status === "fail" || n.status === "block") {
        recentFailingNodes.push(`${r.runId.slice(0, 12)}…/${n.id}`)
      }
    }
  }

  const lastFiveRuns = runRecordsChrono.filter((r) => r.mutationScore !== undefined).slice(-5)
  const mutScores = lastFiveRuns.map((r) => r.mutationScore as number)
  let mutationScoreRange: { min: number; max: number } | undefined
  if (mutScores.length > 0) {
    mutationScoreRange = { min: Math.min(...mutScores), max: Math.max(...mutScores) }
  }

  return {
    jsonlExists,
    jsonlRecordCount,
    dbExists,
    dbCurrent,
    dbRecordCount,
    ...(meta?.lastRebuildIso !== undefined ? { lastRebuildIso: meta.lastRebuildIso } : {}),
    ...(lastRun !== undefined ? { lastRun } : {}),
    costTrend,
    recentFailingNodes,
    ...(mutationScoreRange !== undefined ? { mutationScoreRange } : {}),
  }
}

async function checkDocker(): Promise<DoctorCheck> {
  const label = "Docker"
  try {
    const { stdout } = await execFileAsync("docker", ["compose", "version"], { timeout: 5000 })
    const firstLine = stdout.trim().split("\n")[0] ?? stdout.trim()
    return {
      id: "docker",
      label,
      status: "pass",
      detail: firstLine.length > 0 ? firstLine : "docker compose version",
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      id: "docker",
      label,
      status: "fail",
      detail: message,
    }
  }
}

function checkLlmKeys(env: NodeJS.ProcessEnv): DoctorCheck {
  const label = "LLM API key"
  const found = LLM_KEY_NAMES.filter((name) => {
    const v = env[name]
    return typeof v === "string" && v.trim().length > 0
  })
  if (found.length > 0) {
    return {
      id: "llm-key",
      label,
      status: "pass",
      detail: `set: ${found.join(", ")}`,
    }
  }
  return {
    id: "llm-key",
    label,
    status: "fail",
    detail: "set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY",
  }
}

async function checkToolchain(workDir: string): Promise<DoctorCheck> {
  const label = "Toolchain"
  try {
    const profile = await detectToolchain(workDir)
    const n = countVerificationChecks(profile.checks)
    const ok = profile.language !== "unknown" && n >= 1
    return {
      id: "toolchain",
      label,
      status: ok ? "pass" : "fail",
      detail: ok
        ? `${profile.language}, ${n} verification check(s)`
        : profile.language === "unknown"
          ? "no language detected"
          : "no verification checks detected",
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      id: "toolchain",
      label,
      status: "fail",
      detail: message,
    }
  }
}

function resolveConfigNote(workDir: string): DoctorConfigNote {
  return existsSync(join(workDir, ".bollard.yml")) ? "custom config" : "using defaults"
}

export async function runDoctor(
  workDir: string,
  env: NodeJS.ProcessEnv = process.env,
  options?: { history?: boolean },
): Promise<DoctorReport> {
  const [dockerCheck, toolchainCheck] = await Promise.all([checkDocker(), checkToolchain(workDir)])
  const llmCheck = checkLlmKeys(env)
  const checks = [dockerCheck, llmCheck, toolchainCheck]
  const allPassed = checks.every((c) => c.status === "pass")
  const base: DoctorReport = {
    allPassed,
    checks,
    configNote: resolveConfigNote(workDir),
  }
  if (options?.history !== true) return base
  const historyHealth = await checkHistoryHealth(workDir)
  return { ...base, historyHealth }
}

function formatHistorySection(h: HistoryHealth): string {
  const lines: string[] = []
  lines.push(`\n  ${BOLD}Run history:${RESET}`)

  const jsonlMark = h.jsonlExists ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`
  const jsonlMsg = h.jsonlExists
    ? `history.jsonl exists (${h.jsonlRecordCount} records)`
    : "history.jsonl missing"
  lines.push(`    ${jsonlMark} ${jsonlMsg}`)

  if (!h.dbExists) {
    lines.push(`    ${DIM}○${RESET} history.db not present (JSONL-only or not built yet)`)
  } else if (h.dbCurrent) {
    const rebuild =
      h.lastRebuildIso !== undefined ? `, last rebuild ${formatRebuildAgo(h.lastRebuildIso)}` : ""
    lines.push(`    ${GREEN}✓${RESET} history.db is current (${h.dbRecordCount} records${rebuild})`)
  } else {
    lines.push(
      `    ${YELLOW}⚠${RESET} history.db stale or unreadable (db: ${h.dbRecordCount} vs jsonl: ${h.jsonlRecordCount})`,
    )
  }

  if (h.lastRun !== undefined) {
    const lr = h.lastRun
    lines.push(
      `    ${GREEN}✓${RESET} Last run: ${lr.runId.slice(0, 16)} (${lr.status}, ${formatRelativeShort(lr.timestamp)})`,
    )
  } else {
    lines.push(`    ${DIM}○${RESET} No pipeline runs in recent history`)
  }

  if (h.costTrend === "increasing") {
    lines.push(`    ${YELLOW}⚠${RESET} Cost trend: increasing over recent runs`)
  } else {
    const arrow = h.costTrend === "decreasing" ? "↓" : "→"
    lines.push(`    ${GREEN}✓${RESET} Cost trend: ${h.costTrend ?? "stable"} ${arrow}`)
  }

  if (h.recentFailingNodes.length > 0) {
    lines.push(
      `    ${YELLOW}⚠${RESET} Failing nodes in last 3 runs: ${h.recentFailingNodes.slice(0, 8).join(", ")}`,
    )
  } else {
    lines.push(`    ${GREEN}✓${RESET} No failing nodes in last 3 runs`)
  }

  if (h.mutationScoreRange !== undefined) {
    const { min, max } = h.mutationScoreRange
    const spread = max - min
    if (spread <= 5) {
      lines.push(
        `    ${GREEN}✓${RESET} Mutation score stable (${min.toFixed(0)}–${max.toFixed(0)}% over last 5 runs with scores)`,
      )
    } else {
      lines.push(
        `    ${YELLOW}⚠${RESET} Mutation score varied (${min.toFixed(0)}–${max.toFixed(0)}% over last 5 runs with scores)`,
      )
    }
  } else {
    lines.push(`    ${DIM}○${RESET} No mutation scores in recent runs`)
  }

  return lines.join("\n")
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = []
  for (const c of report.checks) {
    const icon = c.status === "pass" ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`
    lines.push(`  ${icon} ${BOLD}${c.label}${RESET} ${DIM}—${RESET} ${c.detail}`)
  }
  lines.push("")
  lines.push(`  ${DIM}Config:${RESET} ${report.configNote}`)
  if (report.historyHealth !== undefined) {
    lines.push(formatHistorySection(report.historyHealth))
  }
  return lines.join("\n")
}
