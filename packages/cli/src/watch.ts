import { watch } from "node:fs"
import { resolve } from "node:path"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import { FileRunHistoryStore } from "@bollard/engine/src/run-history.js"
import { runStaticChecks } from "@bollard/verify/src/static.js"
import type { StaticCheckResult } from "@bollard/verify/src/static.js"
import { buildVerifyRecord } from "./history-record.js"
import { BOLD, DIM, GREEN, RED, RESET, YELLOW } from "./terminal-styles.js"

export interface WatchOptions {
  workDir: string
  profile: ToolchainProfile
  checks?: string[]
  debounceMs?: number
  quiet?: boolean
  /** Emit one ndjson line per verify run on stdout (pass, fail, or error). When set with --quiet, the quiet fail-only JSON is skipped to avoid duplicate stdout. */
  json?: boolean
}

function log(msg: string): void {
  process.stderr.write(`${msg}\n`)
}

/** Normalize a glob-ish pattern for substring ignore checks (matches user spec). */
function patternToIgnoreSubstring(pattern: string): string {
  return pattern.replace(/\*\*/g, "").replace(/\*/g, "")
}

export function matchesIgnorePattern(filename: string, patterns: string[]): boolean {
  return patterns.some((p) => filename.includes(patternToIgnoreSubstring(p)))
}

function matchPositiveGlob(filename: string, pattern: string): boolean {
  const normalized = pattern.replace(/^\.\//, "")
  if (!normalized.includes("**/")) {
    const literal = patternToIgnoreSubstring(normalized)
    return literal.length > 0 && filename.includes(literal)
  }
  const parts = normalized.split("**/")
  if (parts.length !== 2) {
    const literal = patternToIgnoreSubstring(normalized)
    return literal.length > 0 && filename.includes(literal)
  }
  const baseRaw = parts[0] ?? ""
  const base = baseRaw.replace(/\*$/, "").replace(/\/$/, "")
  const rest = parts[1] ?? ""
  let ext = rest
  if (rest.startsWith("*.")) {
    ext = `.${rest.slice(2)}`
  } else if (rest.startsWith("*")) {
    ext = rest.slice(1)
  }
  const baseOk =
    base === "" || base === "*" || filename.includes(`${base}/`) || filename.startsWith(`${base}/`)
  const extOk = ext === "" || ext === "*" || filename.endsWith(ext)
  return baseOk && extOk
}

function matchesNegationPattern(filename: string, pattern: string): boolean {
  const sub = patternToIgnoreSubstring(pattern)
  if (sub.length === 0) return false
  if (filename.includes(sub)) return true
  const trimmed = sub.replace(/^\/+/, "")
  return trimmed.length > 0 && filename.includes(trimmed)
}

export function matchesSourcePattern(filename: string, patterns: string[]): boolean {
  const negatives = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1))
  for (const neg of negatives) {
    if (matchesNegationPattern(filename, neg)) {
      return false
    }
  }
  const positives = patterns.filter((p) => !p.startsWith("!"))
  return positives.some((p) => matchPositiveGlob(filename, p))
}

export interface QuietWatchFailPayload {
  status: "fail"
  checks: Array<{
    label: string
    passed: boolean
    message?: string
  }>
  timestamp: number
}

export function buildQuietWatchOutput(results: StaticCheckResult[]): QuietWatchFailPayload {
  return {
    status: "fail",
    checks: results.map((r) => ({
      label: r.check,
      passed: r.passed,
      ...(r.passed ? {} : { message: r.output.split("\n").slice(0, 3).join("; ") }),
    })),
    timestamp: Date.now(),
  }
}

export interface WatchJsonPayload {
  status: "pass" | "fail" | "error"
  allPassed?: boolean
  checks?: StaticCheckResult[]
  error?: string
  timestamp: number
}

export function buildJsonWatchOutput(
  results: StaticCheckResult[],
  allPassed: boolean,
): WatchJsonPayload {
  return {
    status: allPassed ? "pass" : "fail",
    allPassed,
    checks: results,
    timestamp: Date.now(),
  }
}

export function buildJsonWatchErrorOutput(err: unknown): WatchJsonPayload {
  return {
    status: "error",
    error: err instanceof Error ? err.message : String(err),
    timestamp: Date.now(),
  }
}

export async function runWatch(options: WatchOptions): Promise<void> {
  const { workDir, profile, checks, debounceMs: debounceOpt, quiet = false, json = false } = options
  const debounceMs = debounceOpt ?? 1500

  const resolvedDir = resolve(workDir)
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let running = false

  async function verify(): Promise<void> {
    if (running) return
    running = true

    if (!quiet) {
      log(`\n${DIM}[${new Date().toLocaleTimeString()}]${RESET} ${BOLD}Verifying...${RESET}`)
    }

    try {
      const staticOpts =
        checks !== undefined && checks.length > 0 ? { onlyChecks: checks } : undefined
      const startedAt = Date.now()
      const { results, allPassed } = await runStaticChecks(resolvedDir, profile, staticOpts)

      try {
        const store = new FileRunHistoryStore(resolvedDir)
        const record = buildVerifyRecord({
          workDir: resolvedDir,
          profile,
          results,
          allPassed,
          startedAt,
          source: "watch",
        })
        await store.record(record).catch(() => undefined)
      } catch {
        // non-fatal history write
      }

      if (json) {
        process.stdout.write(`${JSON.stringify(buildJsonWatchOutput(results, allPassed))}\n`)
      }

      if (quiet && !json && !allPassed) {
        const payload = buildQuietWatchOutput(results)
        process.stdout.write(`${JSON.stringify(payload)}\n`)
      }

      if (!quiet) {
        for (const r of results) {
          const icon = r.passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`
          log(`  ${icon} ${r.check}`)
        }
        if (allPassed) {
          log(`${GREEN}All checks passed.${RESET}`)
        } else {
          const failed = results.filter((r) => !r.passed).map((r) => r.check)
          log(`${RED}Failed: ${failed.join(", ")}${RESET}`)
        }
      }
    } catch (err) {
      if (!quiet) {
        log(`${RED}Verification error: ${err instanceof Error ? err.message : String(err)}${RESET}`)
      }
      if (json) {
        process.stdout.write(`${JSON.stringify(buildJsonWatchErrorOutput(err))}\n`)
      }
    } finally {
      running = false
    }
  }

  function scheduleVerify(): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      void verify()
    }, debounceMs)
  }

  const watchPatterns = profile.sourcePatterns

  if (!quiet) {
    log(`${BOLD}bollard watch${RESET} — watching ${watchPatterns.length} source pattern(s)`)
    log(`${DIM}Debounce: ${debounceMs}ms | Press Ctrl+C to stop${RESET}`)
  }

  await verify()

  let sigintWatcher: ReturnType<typeof watch> | undefined

  const onSigint = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer)
    if (sigintWatcher && typeof sigintWatcher.close === "function") {
      sigintWatcher.close()
    }
    if (!quiet) {
      log(`\n${DIM}Watch stopped.${RESET}`)
    }
    process.exit(0)
  }

  try {
    sigintWatcher = watch(resolvedDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return

      if (matchesIgnorePattern(filename, profile.ignorePatterns)) return

      if (matchesSourcePattern(filename, watchPatterns)) {
        scheduleVerify()
      }
    })

    process.once("SIGINT", onSigint)
  } catch {
    log(
      `${YELLOW}Warning: recursive watch not supported on this platform. Watching top-level only.${RESET}`,
    )
    sigintWatcher = watch(resolvedDir, () => {
      scheduleVerify()
    })

    process.once("SIGINT", onSigint)
  }

  await new Promise<never>(() => {})
}
