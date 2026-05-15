import Database from "better-sqlite3"
import type {
  HistoryFilter,
  HistoryRecord,
  RunRecord,
  RunSummary,
  SummaryFilter,
  VerifyRecord,
} from "./run-history.js"
import { computeCostTrend, parseHistoryLine } from "./run-history.js"

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'run',
  blueprint_id TEXT,
  task TEXT,
  timestamp INTEGER NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  total_duration_ms INTEGER NOT NULL,
  test_passed INTEGER,
  test_skipped INTEGER,
  test_failed INTEGER,
  mutation_score REAL,
  language TEXT,
  package_manager TEXT,
  git_branch TEXT,
  git_sha TEXT,
  probe_count INTEGER,
  work_dir TEXT,
  source TEXT,
  all_passed INTEGER,
  raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  node_id TEXT NOT NULL,
  node_name TEXT NOT NULL,
  node_type TEXT NOT NULL,
  status TEXT NOT NULL,
  cost_usd REAL,
  duration_ms INTEGER,
  error_code TEXT,
  PRIMARY KEY (run_id, node_id)
);

CREATE TABLE IF NOT EXISTS scopes (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  scope TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  claims_proposed INTEGER,
  claims_grounded INTEGER,
  claims_dropped INTEGER,
  tests_passed INTEGER,
  tests_failed INTEGER,
  PRIMARY KEY (run_id, scope)
);

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_timestamp ON runs(timestamp);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_type ON runs(type);
CREATE INDEX IF NOT EXISTS idx_runs_blueprint ON runs(blueprint_id);
CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);
`

export interface SqliteIndex {
  insert(record: HistoryRecord): void
  query(filter?: HistoryFilter): HistoryRecord[]
  findByRunId(runId: string): HistoryRecord | undefined
  summary(filter?: SummaryFilter): RunSummary
  rebuild(records: HistoryRecord[]): { runCount: number; durationMs: number }
  recordCount(): number
  purge(before: number): { purged: number }
  close(): void
}

function setMetadata(db: Database.Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value)
}

function getMetadata(db: Database.Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as
    | { value: string }
    | undefined
  return row?.value
}

function insertRunRow(db: Database.Database, record: RunRecord, rawJson: string): void {
  const err = record.error
  const tp = record.toolchainProfile
  db.prepare(
    `INSERT INTO runs (
      run_id, type, blueprint_id, task, timestamp, status, error_code, error_message,
      total_cost_usd, total_duration_ms, test_passed, test_skipped, test_failed,
      mutation_score, language, package_manager, git_branch, git_sha, probe_count,
      work_dir, source, all_passed, raw_json
    ) VALUES (
      @run_id, 'run', @blueprint_id, @task, @timestamp, @status, @error_code, @error_message,
      @total_cost_usd, @total_duration_ms, @test_passed, @test_skipped, @test_failed,
      @mutation_score, @language, @package_manager, @git_branch, @git_sha, @probe_count,
      NULL, NULL, NULL, @raw_json
    )`,
  ).run({
    run_id: record.runId,
    blueprint_id: record.blueprintId,
    task: record.task,
    timestamp: record.timestamp,
    status: record.status,
    error_code: err?.code ?? null,
    error_message: err?.message ?? null,
    total_cost_usd: record.totalCostUsd,
    total_duration_ms: record.totalDurationMs,
    test_passed: record.testCount.passed,
    test_skipped: record.testCount.skipped,
    test_failed: record.testCount.failed,
    mutation_score: record.mutationScore ?? null,
    language: tp?.language ?? null,
    package_manager: tp?.packageManager ?? null,
    git_branch: record.gitBranch ?? null,
    git_sha: record.gitSha ?? null,
    probe_count: record.probeCount ?? null,
    raw_json: rawJson,
  })
}

function insertVerifyRow(db: Database.Database, record: VerifyRecord, rawJson: string): void {
  const status = record.allPassed ? "success" : "failure"
  db.prepare(
    `INSERT INTO runs (
      run_id, type, blueprint_id, task, timestamp, status, error_code, error_message,
      total_cost_usd, total_duration_ms, test_passed, test_skipped, test_failed,
      mutation_score, language, package_manager, git_branch, git_sha, probe_count,
      work_dir, source, all_passed, raw_json
    ) VALUES (
      @run_id, 'verify', NULL, '', @timestamp, @status, NULL, NULL,
      0, @total_duration_ms, NULL, NULL, NULL,
      NULL, @language, NULL, NULL, @git_sha, NULL,
      @work_dir, @source, @all_passed, @raw_json
    )`,
  ).run({
    run_id: record.runId,
    timestamp: record.timestamp,
    status,
    total_duration_ms: record.totalDurationMs,
    language: record.language ?? null,
    git_sha: record.gitSha ?? null,
    work_dir: record.workDir,
    source: record.source,
    all_passed: record.allPassed ? 1 : 0,
    raw_json: rawJson,
  })
}

function bumpRecordCount(db: Database.Database): void {
  const cur = Number.parseInt(getMetadata(db, "record_count") ?? "0", 10)
  setMetadata(db, "record_count", String(cur + 1))
}

export function createSqliteIndex(dbPath: string): SqliteIndex {
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  db.pragma("synchronous = NORMAL")
  db.exec(SCHEMA_SQL)

  const insertRecord = (record: HistoryRecord): void => {
    const rawJson = JSON.stringify(record)
    const tx = db.transaction(() => {
      if (record.type === "run") {
        insertRunRow(db, record, rawJson)
        const insNode = db.prepare(
          `INSERT INTO nodes (run_id, node_id, node_name, node_type, status, cost_usd, duration_ms, error_code)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        for (const n of record.nodes) {
          insNode.run(
            record.runId,
            n.id,
            n.name,
            n.type,
            n.status,
            n.costUsd ?? null,
            n.durationMs ?? null,
            n.error?.code ?? null,
          )
        }
        const insScope = db.prepare(
          `INSERT INTO scopes (run_id, scope, enabled, claims_proposed, claims_grounded, claims_dropped, tests_passed, tests_failed)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        for (const s of record.scopes) {
          insScope.run(
            record.runId,
            s.scope,
            s.enabled ? 1 : 0,
            s.claimsProposed ?? null,
            s.claimsGrounded ?? null,
            s.claimsDropped ?? null,
            s.testsPassed ?? null,
            s.testsFailed ?? null,
          )
        }
      } else {
        insertVerifyRow(db, record, rawJson)
      }
      bumpRecordCount(db)
    })
    tx()
  }

  const query = (filter?: HistoryFilter): HistoryRecord[] => {
    const clauses: string[] = []
    const params: unknown[] = []

    if (filter?.since !== undefined) {
      clauses.push("timestamp >= ?")
      params.push(filter.since)
    }
    if (filter?.until !== undefined) {
      clauses.push("timestamp <= ?")
      params.push(filter.until)
    }
    if (filter?.status !== undefined) {
      const st = filter.status
      if (st === "handed_to_human") {
        clauses.push(`type = 'run' AND status = 'handed_to_human'`)
      } else if (st === "success") {
        clauses.push(
          `((type = 'run' AND status = 'success') OR (type = 'verify' AND all_passed = 1))`,
        )
      } else {
        clauses.push(
          `((type = 'run' AND status = 'failure') OR (type = 'verify' AND all_passed = 0))`,
        )
      }
    }
    if (filter?.blueprintId !== undefined) {
      clauses.push("type = 'run' AND blueprint_id = ?")
      params.push(filter.blueprintId)
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
    const limit = filter?.limit ?? 50
    const offset = filter?.offset ?? 0
    if (limit <= 0) return []

    const sql = `SELECT raw_json FROM runs ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
    const rows = db.prepare(sql).all(...params, limit, offset) as { raw_json: string }[]
    const out: HistoryRecord[] = []
    for (const row of rows) {
      const rec = parseHistoryLine(row.raw_json)
      if (rec) out.push(rec)
    }
    return out
  }

  const findByRunId = (runId: string): HistoryRecord | undefined => {
    const row = db.prepare("SELECT raw_json FROM runs WHERE run_id = ?").get(runId) as
      | { raw_json: string }
      | undefined
    if (!row) return undefined
    return parseHistoryLine(row.raw_json) ?? undefined
  }

  const summary = (filter?: SummaryFilter): RunSummary => {
    const sinceParam = filter?.since ?? null
    const untilParam = filter?.until ?? null
    const row = db
      .prepare(
        `SELECT
          COUNT(*) as total_runs,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successes,
          AVG(total_cost_usd) as avg_cost,
          AVG(total_duration_ms) as avg_duration,
          AVG(COALESCE(test_passed, 0) + COALESCE(test_skipped, 0) + COALESCE(test_failed, 0)) as avg_tests,
          AVG(mutation_score) as avg_mutation
        FROM runs
        WHERE type = 'run'
          AND (@since IS NULL OR timestamp >= @since)
          AND (@until IS NULL OR timestamp <= @until)`,
      )
      .get({ since: sinceParam, until: untilParam }) as {
      total_runs: number
      successes: number | null
      avg_cost: number | null
      avg_duration: number | null
      avg_tests: number | null
      avg_mutation: number | null
    }

    const totalRuns = row.total_runs ?? 0
    if (totalRuns === 0) {
      return {
        totalRuns: 0,
        successRate: 0,
        avgCostUsd: 0,
        avgDurationMs: 0,
        avgTestCount: 0,
        costTrend: "stable",
        byBlueprint: {},
      }
    }

    const successes = row.successes ?? 0
    const avgCost = row.avg_cost ?? 0
    const avgDuration = row.avg_duration ?? 0
    const avgTests = row.avg_tests ?? 0
    const avgMutationRaw = row.avg_mutation
    const avgMutationScore =
      avgMutationRaw !== null && !Number.isNaN(avgMutationRaw) ? avgMutationRaw : undefined

    const costRows = db
      .prepare(
        `SELECT total_cost_usd FROM runs
         WHERE type = 'run'
           AND (@since IS NULL OR timestamp >= @since)
           AND (@until IS NULL OR timestamp <= @until)
         ORDER BY timestamp DESC
         LIMIT 5`,
      )
      .all({ since: sinceParam, until: untilParam }) as { total_cost_usd: number }[]
    const costsChrono = [...costRows].reverse().map((r) => r.total_cost_usd)
    const costTrend = computeCostTrend(costsChrono)

    const bpRows = db
      .prepare(
        `SELECT blueprint_id,
          COUNT(*) as runs,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successes,
          SUM(total_cost_usd) as sum_cost
        FROM runs
        WHERE type = 'run' AND blueprint_id IS NOT NULL
          AND (@since IS NULL OR timestamp >= @since)
          AND (@until IS NULL OR timestamp <= @until)
        GROUP BY blueprint_id`,
      )
      .all({ since: sinceParam, until: untilParam }) as Array<{
      blueprint_id: string
      runs: number
      successes: number | null
      sum_cost: number | null
    }>

    const byBlueprint: RunSummary["byBlueprint"] = {}
    for (const b of bpRows) {
      const n = b.runs
      const succ = b.successes ?? 0
      const sumCost = b.sum_cost ?? 0
      byBlueprint[b.blueprint_id] = {
        runs: n,
        successRate: n > 0 ? succ / n : 0,
        avgCostUsd: n > 0 ? sumCost / n : 0,
      }
    }

    const base: RunSummary = {
      totalRuns,
      successRate: successes / totalRuns,
      avgCostUsd: avgCost,
      avgDurationMs: avgDuration,
      avgTestCount: avgTests,
      costTrend,
      byBlueprint,
    }
    return avgMutationScore !== undefined && !Number.isNaN(avgMutationScore)
      ? { ...base, avgMutationScore }
      : base
  }

  const rebuild = (records: HistoryRecord[]): { runCount: number; durationMs: number } => {
    const start = Date.now()
    const tx = db.transaction(() => {
      db.exec(`
        DROP TABLE IF EXISTS nodes;
        DROP TABLE IF EXISTS scopes;
        DROP TABLE IF EXISTS runs;
        DROP TABLE IF EXISTS metadata;
      `)
      db.exec(SCHEMA_SQL)

      const insRun = db.prepare(
        `INSERT INTO runs (
          run_id, type, blueprint_id, task, timestamp, status, error_code, error_message,
          total_cost_usd, total_duration_ms, test_passed, test_skipped, test_failed,
          mutation_score, language, package_manager, git_branch, git_sha, probe_count,
          work_dir, source, all_passed, raw_json
        ) VALUES (
          @run_id, @type, @blueprint_id, @task, @timestamp, @status, @error_code, @error_message,
          @total_cost_usd, @total_duration_ms, @test_passed, @test_skipped, @test_failed,
          @mutation_score, @language, @package_manager, @git_branch, @git_sha, @probe_count,
          @work_dir, @source, @all_passed, @raw_json
        )`,
      )
      const insNode = db.prepare(
        `INSERT INTO nodes (run_id, node_id, node_name, node_type, status, cost_usd, duration_ms, error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      const insScope = db.prepare(
        `INSERT INTO scopes (run_id, scope, enabled, claims_proposed, claims_grounded, claims_dropped, tests_passed, tests_failed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )

      for (const record of records) {
        const rawJson = JSON.stringify(record)
        if (record.type === "run") {
          const err = record.error
          const tp = record.toolchainProfile
          insRun.run({
            run_id: record.runId,
            type: "run",
            blueprint_id: record.blueprintId,
            task: record.task,
            timestamp: record.timestamp,
            status: record.status,
            error_code: err?.code ?? null,
            error_message: err?.message ?? null,
            total_cost_usd: record.totalCostUsd,
            total_duration_ms: record.totalDurationMs,
            test_passed: record.testCount.passed,
            test_skipped: record.testCount.skipped,
            test_failed: record.testCount.failed,
            mutation_score: record.mutationScore ?? null,
            language: tp?.language ?? null,
            package_manager: tp?.packageManager ?? null,
            git_branch: record.gitBranch ?? null,
            git_sha: record.gitSha ?? null,
            probe_count: record.probeCount ?? null,
            work_dir: null,
            source: null,
            all_passed: null,
            raw_json: rawJson,
          })
          for (const n of record.nodes) {
            insNode.run(
              record.runId,
              n.id,
              n.name,
              n.type,
              n.status,
              n.costUsd ?? null,
              n.durationMs ?? null,
              n.error?.code ?? null,
            )
          }
          for (const s of record.scopes) {
            insScope.run(
              record.runId,
              s.scope,
              s.enabled ? 1 : 0,
              s.claimsProposed ?? null,
              s.claimsGrounded ?? null,
              s.claimsDropped ?? null,
              s.testsPassed ?? null,
              s.testsFailed ?? null,
            )
          }
        } else {
          const status = record.allPassed ? "success" : "failure"
          insRun.run({
            run_id: record.runId,
            type: "verify",
            blueprint_id: null,
            task: "",
            timestamp: record.timestamp,
            status,
            error_code: null,
            error_message: null,
            total_cost_usd: 0,
            total_duration_ms: record.totalDurationMs,
            test_passed: null,
            test_skipped: null,
            test_failed: null,
            mutation_score: null,
            language: record.language ?? null,
            package_manager: null,
            git_branch: null,
            git_sha: record.gitSha ?? null,
            probe_count: null,
            work_dir: record.workDir,
            source: record.source,
            all_passed: record.allPassed ? 1 : 0,
            raw_json: rawJson,
          })
        }
      }

      setMetadata(db, "record_count", String(records.length))
      setMetadata(db, "last_rebuild", new Date().toISOString())
    })
    tx()
    return { runCount: records.length, durationMs: Date.now() - start }
  }

  const recordCount = (): number => {
    const v = getMetadata(db, "record_count")
    if (v === undefined) return 0
    const n = Number.parseInt(v, 10)
    return Number.isFinite(n) ? n : 0
  }

  const close = (): void => {
    db.close()
  }

  const purge = (before: number): { purged: number } => {
    const tx = db.transaction(() => {
      // First, find all run_ids that will be deleted
      const runIdsToDelete = db
        .prepare("SELECT run_id FROM runs WHERE timestamp < ?")
        .all(before) as { run_id: string }[]

      if (runIdsToDelete.length === 0) {
        return 0
      }

      const runIds = runIdsToDelete.map((row) => row.run_id)
      const placeholders = runIds.map(() => "?").join(",")

      // Delete from child tables first (explicit cascade since SQLite foreign keys are off by default)
      db.prepare(`DELETE FROM nodes WHERE run_id IN (${placeholders})`).run(...runIds)
      db.prepare(`DELETE FROM scopes WHERE run_id IN (${placeholders})`).run(...runIds)

      // Delete from runs table
      const deleteResult = db.prepare("DELETE FROM runs WHERE timestamp < ?").run(before)
      const deletedCount = deleteResult.changes

      // Update record_count metadata
      const currentCount = Number.parseInt(getMetadata(db, "record_count") ?? "0", 10)
      const newCount = Math.max(0, currentCount - deletedCount)
      setMetadata(db, "record_count", String(newCount))

      return deletedCount
    })

    const purgedCount = tx()
    return { purged: purgedCount }
  }

  return {
    insert: insertRecord,
    query,
    findByRunId,
    summary,
    rebuild,
    recordCount,
    purge,
    close,
  }
}
