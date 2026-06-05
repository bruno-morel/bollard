import {
  assessTestQualityForWorkDir,
  createCurateTestsBlueprint,
} from "@bollard/blueprints/src/curate-tests.js"
import { countBlueprintSteps } from "@bollard/engine/src/blueprint.js"
import { FileRunHistoryStore } from "@bollard/engine/src/run-history.js"
import type { RunBlueprintCompleteCallback } from "@bollard/engine/src/runner.js"
import { runBlueprint } from "@bollard/engine/src/runner.js"
import { createAgenticHandler } from "./agent-handler.js"
import { resolveConfig } from "./config.js"
import { getHeadSha } from "./git-utils.js"
import { buildRunRecord, enrichScopeFingerprints } from "./history-record.js"
import { humanGateHandler } from "./human-gate.js"
import { BOLD, CYAN, DIM, RESET, YELLOW } from "./terminal-styles.js"

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

function printHelp(): void {
  log("Usage: bollard curate <subcommand> [--work-dir <path>]")
  log("")
  log("Subcommands:")
  log("  list-quality   Score managed test files from run history signals")
  log("  run            Run the curate-tests blueprint (requires API key)")
}

export async function runListQuality(workDir: string): Promise<void> {
  header("curate list-quality")
  const result = await assessTestQualityForWorkDir(workDir)

  if (result.skipped && result.scores.length === 0) {
    log(`${YELLOW}No managed test files or promotion candidates found.${RESET}`)
    log(`${DIM}Use 'bollard ownership claim' to register managed files.${RESET}\n`)
    return
  }

  const colPath = 48
  const colScore = 6
  const colMut = 8
  const colFlags = 20

  log(
    `${padEndVisible("PATH", colPath)}${padEndVisible("SCORE", colScore)}${padEndVisible("MUT%", colMut)}${padEndVisible("FLAGS", colFlags)}`,
  )
  log(`${DIM}${"─".repeat(colPath + colScore + colMut + colFlags)}${RESET}`)

  for (const s of result.scores) {
    const flags: string[] = []
    if (s.isManaged) flags.push("managed")
    if (s.coveredByAdversarial) flags.push("covered")
    const mut = s.mutationScore !== undefined ? `${s.mutationScore.toFixed(1)}` : "—"
    log(
      `${padEndVisible(s.filePath, colPath)}${padEndVisible(String(s.score), colScore)}${padEndVisible(mut, colMut)}${padEndVisible(flags.join(","), colFlags)}`,
    )
  }

  if (result.promotionCandidates.length > 0) {
    log(`\n${DIM}Promotion candidates (${result.promotionCandidates.length}):${RESET}`)
    for (const p of result.promotionCandidates) {
      log(`  ${p}`)
    }
  }

  if (result.pruneCandidates.length > 0) {
    log(`\n${DIM}Prune candidates (${result.pruneCandidates.length}):${RESET}`)
    for (const p of result.pruneCandidates) {
      log(`  ${p}`)
    }
  }

  log("")
}

export async function runCuratePipeline(workDir: string): Promise<unknown> {
  const { config, profile } = await resolveConfig(undefined, workDir)

  if (config.takeover?.tests?.enabled !== true) {
    log(
      `${YELLOW}Warning: takeover.tests.enabled is false — curation runs anyway (Phase 2).${RESET}`,
    )
  }

  const persistRunHistory: RunBlueprintCompleteCallback = async (ctx, result, bp) => {
    const sha = await getHeadSha(workDir)
    const record = buildRunRecord(ctx, result, bp, sha)
    await enrichScopeFingerprints(record, workDir)
    const store = new FileRunHistoryStore(workDir)
    await store.record(record)
  }

  const { handler } = await createAgenticHandler(config, workDir, profile)
  const blueprint = createCurateTestsBlueprint(workDir, config)
  const task = "curate tests"

  header("curate run")
  log(`${DIM}Work dir:${RESET}  ${workDir}`)
  log(`${DIM}Blueprint:${RESET} ${blueprint.name} (${countBlueprintSteps(blueprint.nodes)} steps)`)
  log(`${DIM}Trust:${RESET}     ${config.takeover?.tests?.trust ?? "review"}`)
  log("")

  const result = await runBlueprint(
    blueprint,
    task,
    config,
    handler,
    humanGateHandler,
    undefined,
    profile,
    persistRunHistory,
  )

  return result
}

function parseCurateSubcommand(rest: string[]): string | undefined {
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === undefined) continue
    if (a === "--work-dir") {
      i++
      continue
    }
    if (!a.startsWith("--")) {
      return a
    }
  }
  return undefined
}

export async function runCurateCommand(rest: string[], workDir: string): Promise<void> {
  const sub = parseCurateSubcommand(rest)

  if (sub === "list-quality") {
    await runListQuality(workDir)
    return
  }

  if (sub === "run") {
    const result = await runCuratePipeline(workDir)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    const status = (result as { status?: string }).status
    process.exit(status === "success" ? 0 : 1)
    return
  }

  printHelp()
  process.exit(1)
}
