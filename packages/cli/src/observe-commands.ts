import { existsSync } from "node:fs"
import { mkdir, readdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { BollardError } from "@bollard/engine/src/errors.js"
import { emergencyKillFlag } from "@bollard/observe/src/flag-manager.js"
import { DefaultProbeScheduler } from "@bollard/observe/src/probe-scheduler.js"
import { resolveProviders } from "@bollard/observe/src/providers/resolve.js"
import type { DeploymentMetadata } from "@bollard/observe/src/providers/types.js"

import { resolveConfig } from "./config.js"
import { BOLD, CYAN, DIM, GREEN, RED, RESET } from "./terminal-styles.js"

function log(msg: string): void {
  process.stderr.write(`${msg}\n`)
}

function header(title: string): void {
  log(`\n${BOLD}${CYAN}bollard${RESET} ${BOLD}${title}${RESET}`)
  log(`${DIM}${"─".repeat(50)}${RESET}`)
}

function getUrlFlag(args: string[], fallback?: string): string | undefined {
  const idx = args.indexOf("--url")
  if (idx !== -1 && args[idx + 1]) return args[idx + 1]
  return fallback
}

function getWorkDirFlag(args: string[]): string | undefined {
  const idx = args.indexOf("--work-dir")
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

function resolveWorkDir(args: string[]): string {
  const w = getWorkDirFlag(args)
  return w ? resolve(w) : findWorkspaceRoot(process.cwd())
}

export async function runProbeCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? ""
  const rest = args.slice(1)
  const workDir = resolveWorkDir(args)
  const { observe } = await resolveConfig(undefined, workDir)
  const providers = resolveProviders(observe, workDir)
  const baseUrl =
    getUrlFlag(args, providers.options.baseUrl) ??
    process.env["BOLLARD_PROBE_BASE_URL"] ??
    "http://127.0.0.1:3000"

  if (sub === "list") {
    const dir = join(workDir, ".bollard", "probes")
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      names = []
    }
    const jsonFiles = names.filter((n) => n.endsWith(".json"))
    process.stdout.write(`${JSON.stringify({ probes: jsonFiles }, null, 2)}\n`)
    return
  }

  const scheduler = new DefaultProbeScheduler({ workDir, executor: providers.probeExecutor })

  if (sub === "run") {
    const maybeId = rest[0] && !rest[0].startsWith("-") ? rest[0] : undefined
    const all = await scheduler.loadProbes()
    const probes = maybeId ? all.filter((p) => p.id === maybeId) : all
    if (maybeId && probes.length === 0) {
      throw new BollardError({
        code: "CONFIG_INVALID",
        message: `Probe not found: ${maybeId}`,
        context: { maybeId },
      })
    }
    const started = Date.now()
    const results = []
    for (const probe of probes) {
      const r = await providers.probeExecutor.execute(probe, baseUrl)
      await providers.metricsStore.record(r)
      results.push(r)
    }
    const passed = results.filter((r) => r.status === "pass").length
    const failed = results.filter((r) => r.status === "fail").length
    const summary = {
      total: results.length,
      passed,
      failed,
      results,
      duration_ms: Date.now() - started,
    }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    if (failed > 0) {
      process.exitCode = 1
    }
    return
  }

  if (sub === "watch") {
    header("probe watch")
    log(`Base URL: ${baseUrl}`)
    log(`${DIM}Press Ctrl+C to stop${RESET}\n`)
    const handle = scheduler.watch(baseUrl, (r) => {
      void providers.metricsStore.record(r)
      const icon = r.status === "pass" ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`
      log(`${icon} ${r.probeId} ${r.latencyMs}ms`)
    })
    await new Promise<void>(() => {
      process.on("SIGINT", () => {
        handle.stop()
        process.exit(0)
      })
    })
    return
  }

  log("Usage: bollard probe run [probeId] [--url <url>] [--work-dir <path>]")
  log("       bollard probe watch [--url <url>] [--work-dir <path>]")
  log("       bollard probe list [--work-dir <path>]")
  process.exit(1)
}

export async function runDeployCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? ""
  const workDir = resolveWorkDir(args)
  const { observe } = await resolveConfig(undefined, workDir)
  const { deploymentTracker } = resolveProviders(observe, workDir)

  if (sub === "record") {
    const shaIdx = args.indexOf("--sha")
    const envIdx = args.indexOf("--env")
    const shaArg = shaIdx !== -1 ? args[shaIdx + 1] : undefined
    let sha = process.env["GITHUB_SHA"] ?? process.env["GIT_SHA"] ?? "unknown"
    if (shaArg !== undefined) {
      sha = shaArg
    }
    const envArg = envIdx !== -1 ? args[envIdx + 1] : undefined
    let env = "production"
    if (envArg !== undefined) {
      env = envArg
    }
    const meta: DeploymentMetadata = {
      deploymentId: sha,
      timestamp: Date.now(),
      sourceRunIds: [],
      relatedCommits: [sha],
      environment: env,
    }
    await deploymentTracker.record(meta)
    process.stdout.write(`${JSON.stringify({ recorded: meta }, null, 2)}\n`)
    return
  }

  if (sub === "list") {
    const h = await deploymentTracker.getHistory(50)
    process.stdout.write(`${JSON.stringify({ deployments: h }, null, 2)}\n`)
    return
  }

  if (sub === "current") {
    const c = await deploymentTracker.getCurrent()
    process.stdout.write(`${JSON.stringify({ current: c ?? null }, null, 2)}\n`)
    return
  }

  log("Usage: bollard deploy record [--sha <sha>] [--env <env>] [--work-dir <path>]")
  log("       bollard deploy list [--work-dir <path>]")
  log("       bollard deploy current [--work-dir <path>]")
  process.exit(1)
}

export async function runFlagCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? ""
  const workDir = resolveWorkDir(args)
  const { observe } = await resolveConfig(undefined, workDir)
  const { flagProvider } = resolveProviders(observe, workDir)

  if (sub === "list") {
    const flags = await flagProvider.list()
    process.stdout.write(`${JSON.stringify({ flags }, null, 2)}\n`)
    return
  }

  if (sub === "set") {
    const id = args[1]
    const val = args[2]
    if (!id || !val) {
      log("Usage: bollard flag set <flagId> <on|off|<percent>> [--work-dir <path>]")
      process.exit(1)
    }
    let enabled = false
    let percent = 0
    if (val === "on") {
      enabled = true
      percent = 100
    } else if (val === "off") {
      enabled = false
      percent = 0
    } else {
      const n = Number(val.replace(/%$/, ""))
      if (Number.isNaN(n)) {
        log(`${RED}Invalid value${RESET}: use on, off, or a percent (0-100)`)
        process.exit(1)
      }
      percent = Math.min(100, Math.max(0, n))
      enabled = percent > 0
    }
    const next = {
      id,
      enabled,
      percent,
      updatedAt: Date.now(),
      updatedBy: "human",
    }
    await flagProvider.set(id, next)
    process.stdout.write(`${JSON.stringify({ flag: next }, null, 2)}\n`)
    return
  }

  if (sub === "kill") {
    const id = args[1]
    if (!id) {
      log("Usage: bollard flag kill <flagId> [--work-dir <path>]")
      process.exit(1)
    }
    await emergencyKillFlag(flagProvider, id)
    await mkdir(join(workDir, ".bollard", "observe"), { recursive: true })
    const { appendFile } = await import("node:fs/promises")
    await appendFile(
      join(workDir, ".bollard", "observe", "flag-kill-log.jsonl"),
      `${JSON.stringify({ flagId: id, at: Date.now(), investigation: true })}\n`,
    )
    process.stdout.write(`${JSON.stringify({ killed: id }, null, 2)}\n`)
    return
  }

  log("Usage: bollard flag set <flagId> <on|off|percent> [--work-dir <path>]")
  log("       bollard flag list [--work-dir <path>]")
  log("       bollard flag kill <flagId> [--work-dir <path>]")
  process.exit(1)
}

export async function runDriftCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? ""
  const workDir = resolveWorkDir(args)
  const { observe } = await resolveConfig(undefined, workDir)
  const { driftDetector } = resolveProviders(observe, workDir)

  if (sub === "check") {
    const report = await driftDetector.check()
    process.stdout.write(`${JSON.stringify({ drift: report }, null, 2)}\n`)
    if (report.hasDrift && report.severity === "high") {
      process.exitCode = 1
    }
    return
  }

  if (sub === "watch") {
    header("drift watch")
    log(`${DIM}Polling every 60s (Ctrl+C to stop)${RESET}\n`)
    const tick = async () => {
      const report = await driftDetector.check()
      if (report.hasDrift) {
        log(`${RED}Drift:${RESET} ${report.severity} — ${report.recommendation}`)
      } else {
        log(`${GREEN}OK${RESET} — no drift`)
      }
    }
    await tick()
    const t = setInterval(() => void tick(), 60_000)
    await new Promise<void>(() => {
      process.on("SIGINT", () => {
        clearInterval(t)
        process.exit(0)
      })
    })
    return
  }

  log("Usage: bollard drift check [--work-dir <path>]")
  log("       bollard drift watch [--work-dir <path>]")
  process.exit(1)
}
