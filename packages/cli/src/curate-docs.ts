import {
  assessDocsDriftForWorkDir,
  createCurateDocsBlueprint,
} from "@bollard/blueprints/src/curate-docs.js"
import { countBlueprintSteps } from "@bollard/engine/src/blueprint.js"
import { FileRunHistoryStore } from "@bollard/engine/src/run-history.js"
import type { RunBlueprintCompleteCallback } from "@bollard/engine/src/runner.js"
import { runBlueprint } from "@bollard/engine/src/runner.js"
import { createAgenticHandler } from "./agent-handler.js"
import { formatAuditDocsResult } from "./audit-docs.js"
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

function printHelp(): void {
  log("Usage: bollard curate-docs <subcommand> [--work-dir <path>]")
  log("")
  log("Subcommands:")
  log("  list-drift   Build corpus + run audit-docs (no LLM)")
  log("  run          Run the curate-docs blueprint (requires API key)")
}

export async function runListDrift(workDir: string): Promise<void> {
  header("curate-docs list-drift")
  const { config } = await resolveConfig(undefined, workDir, { requireApiKey: false })
  const result = await assessDocsDriftForWorkDir(workDir, config.docs?.homes)

  log(formatAuditDocsResult(result.auditResult))
  log("")
  log(`${DIM}Corpus size:${RESET} ${result.corpus.length} chars`)
  log(
    `${DIM}Audit failures:${RESET} ${result.auditFailures.length > 0 ? result.auditFailures.join(", ") : "(none)"}`,
  )
  log("")
  log(`${DIM}Editable (curate tier):${RESET}`)
  if (result.editable.length === 0) {
    log("  (none)")
  } else {
    for (const path of result.editable) {
      log(`  ${path}`)
    }
  }
  log("")
  log(`${DIM}Detect-only tier (NOT auto-curated — review manually):${RESET}`)
  if (result.detectOnly.length === 0) {
    log("  (none)")
  } else {
    for (const path of result.detectOnly) {
      log(`  ${path}`)
    }
  }
  log("")
}

export async function runCurateDocsPipeline(workDir: string): Promise<unknown> {
  const { config, profile } = await resolveConfig(undefined, workDir)

  if (config.takeover?.docs?.enabled !== true) {
    log(
      `${YELLOW}Warning: takeover.docs.enabled is false — docs curation runs anyway (Phase 1).${RESET}`,
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
  const blueprint = createCurateDocsBlueprint(workDir, config)
  const task = "curate docs"

  header("curate-docs run")
  log(`${DIM}Work dir:${RESET}  ${workDir}`)
  log(`${DIM}Blueprint:${RESET} ${blueprint.name} (${countBlueprintSteps(blueprint.nodes)} steps)`)
  log(`${DIM}Trust:${RESET}     ${config.takeover?.docs?.trust ?? "review"} (human gate enforced)`)
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

function parseCurateDocsSubcommand(rest: string[]): string | undefined {
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

export async function runCurateDocsCommand(rest: string[], workDir: string): Promise<void> {
  const sub = parseCurateDocsSubcommand(rest)

  if (sub === "list-drift") {
    await runListDrift(workDir)
    return
  }

  if (sub === "run") {
    const result = await runCurateDocsPipeline(workDir)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    const status = (result as { status?: string }).status
    process.exit(status === "success" ? 0 : 1)
    return
  }

  printHelp()
  process.exit(1)
}
