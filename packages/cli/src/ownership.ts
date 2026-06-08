import {
  detectManagedFileConflicts,
  FileOwnershipStore,
  type ManagedFileEntry,
} from "@bollard/engine/src/ownership.js"
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

const VALID_DOMAINS = new Set<ManagedFileEntry["domain"]>([
  "tests",
  "ci",
  "deps",
  "docs",
  "monitoring",
])

interface ParsedOwnershipCli {
  domain?: ManagedFileEntry["domain"]
  runId?: string
  sha?: string
  mutationScore?: number
  positional: string[]
}

function parseOwnershipCliArgs(rest: string[]): ParsedOwnershipCli {
  const out: ParsedOwnershipCli = { positional: [] }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === undefined) continue
    if (a === "--domain") {
      const v = rest[++i]
      if (!v || !VALID_DOMAINS.has(v as ManagedFileEntry["domain"])) {
        log(`${RED}Invalid --domain (use tests | ci | deps | docs | monitoring)${RESET}`)
        process.exit(1)
      }
      out.domain = v as ManagedFileEntry["domain"]
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
    if (a === "--sha") {
      const v = rest[++i]
      if (!v) {
        log(`${RED}Missing value for --sha${RESET}`)
        process.exit(1)
      }
      out.sha = v
      continue
    }
    if (a === "--mutation-score") {
      const v = Number.parseFloat(rest[++i] ?? "")
      if (!Number.isFinite(v)) {
        log(`${RED}Invalid --mutation-score${RESET}`)
        process.exit(1)
      }
      out.mutationScore = v
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

function formatScore(score: number | undefined): string {
  if (score === undefined) return "—"
  return `${score.toFixed(0)}%`
}

function printHelp(): void {
  log(`\n${BOLD}${CYAN}bollard ownership${RESET}\n`)
  log("Subcommands:\n")
  log(`  ${BOLD}list${RESET}                              List all managed and user-owned files`)
  log(`  ${BOLD}claim${RESET} <path> --domain <domain>   Claim a file for a takeover domain`)
  log(`                                    ${DIM}domains: tests ci deps docs monitoring${RESET}`)
  log(`  ${BOLD}release${RESET} <path>                   Release a file to human ownership`)
  log(
    `  ${BOLD}status${RESET}                            Show conflict summary with mutation scores`,
  )
}

async function cmdList(workDir: string): Promise<void> {
  const store = new FileOwnershipStore(workDir)
  const manifest = await store.read()
  header("ownership")
  log(`${DIM}Work dir:${RESET} ${workDir}\n`)

  log(`Bollard-managed (${manifest.bollardManaged.length} files):`)
  if (manifest.bollardManaged.length === 0) {
    log(`  ${DIM}(none)${RESET}`)
  } else {
    for (const e of manifest.bollardManaged) {
      log(
        `  ${padEndVisible(e.domain, 10)} ${e.path}  score=${formatScore(e.mutationScore)}  run=${e.lastCuratedRunId}`,
      )
    }
  }

  log(`\nUser-owned (${manifest.userOwned.length} files):`)
  if (manifest.userOwned.length === 0) {
    log(`  ${DIM}(none)${RESET}`)
  } else {
    for (const p of manifest.userOwned) {
      log(`  ${p}`)
    }
  }
  log("")
}

async function cmdClaim(workDir: string, parsed: ParsedOwnershipCli): Promise<void> {
  const filePath = parsed.positional[1]
  if (!filePath || !parsed.domain || !parsed.runId || !parsed.sha) {
    log(
      "Usage: bollard ownership claim <path> --domain <domain> --run-id <id> --sha <sha> [--mutation-score <n>]",
    )
    process.exit(1)
  }
  const store = new FileOwnershipStore(workDir)
  await store.claim(filePath, parsed.domain, parsed.runId, parsed.sha, parsed.mutationScore)
  header("ownership claim")
  log(`${GREEN}Claimed:${RESET} ${filePath}`)
  log(`${DIM}Domain:${RESET}  ${parsed.domain}`)
  log(`${DIM}Run ID:${RESET}  ${parsed.runId}`)
  log(`${DIM}SHA:${RESET}     ${parsed.sha}`)
  if (parsed.mutationScore !== undefined) {
    log(`${DIM}Score:${RESET}    ${parsed.mutationScore.toFixed(1)}%`)
  }
  log("")
}

async function cmdRelease(workDir: string, filePath: string | undefined): Promise<void> {
  if (!filePath) {
    log("Usage: bollard ownership release <path>")
    process.exit(1)
  }
  const store = new FileOwnershipStore(workDir)
  await store.release(filePath)
  header("ownership release")
  log(`${GREEN}Released:${RESET} ${filePath}`)
  log("")
}

async function cmdStatus(workDir: string): Promise<void> {
  const store = new FileOwnershipStore(workDir)
  const manifest = await store.read()
  const conflicts = await detectManagedFileConflicts(manifest, workDir)
  header("ownership status")

  if (conflicts.length === 0) {
    log(
      `${GREEN}No conflicts detected.${RESET} (${manifest.bollardManaged.length} managed files checked)`,
    )
    log("")
    return
  }

  for (const c of conflicts) {
    const sevColor = c.severity === "high" ? RED : c.severity === "medium" ? YELLOW : DIM
    log(`${RED}CONFLICT${RESET}  ${sevColor}${c.severity}${RESET}  ${c.filePath}`)
    log(`  Last Bollard SHA: ${c.lastBollardSha.slice(0, 8)}`)
    log(`  Current SHA:      ${c.currentSha.slice(0, 8)}`)
    log(`  Detail: ${c.detail}`)
    log("")
  }
}

export async function runOwnershipCommand(rest: string[], workDir: string): Promise<void> {
  const parsed = parseOwnershipCliArgs(rest)
  const sub = parsed.positional[0]

  if (sub === "list") {
    await cmdList(workDir)
    return
  }

  if (sub === "claim") {
    await cmdClaim(workDir, parsed)
    return
  }

  if (sub === "release") {
    await cmdRelease(workDir, parsed.positional[1])
    return
  }

  if (sub === "status") {
    await cmdStatus(workDir)
    return
  }

  printHelp()
  if (sub !== undefined) {
    process.exit(1)
  }
}
