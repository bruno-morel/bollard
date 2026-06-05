import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { promisify } from "node:util"
import * as lockfile from "proper-lockfile"
import { BollardError } from "./errors.js"

export const OWNERSHIP_SCHEMA_VERSION = 1 as const

/** A single file managed by Bollard under a takeover domain. */
export interface ManagedFileEntry {
  /** Path relative to workDir (the project root). */
  path: string
  /** Which curate-* domain last claimed this file. */
  domain: "tests" | "ci" | "deps" | "docs" | "monitoring"
  /** Run ID of the last Bollard curation pass that touched this file. */
  lastCuratedRunId: string
  /**
   * The git commit SHA at the time Bollard last wrote this file.
   * Used by detectManagedFileConflicts to identify human edits since
   * Bollard's last commit.
   */
  lastCommitSha: string
  /** Most recent Stryker/mutmut mutation score for this file, if known. */
  mutationScore?: number
}

/**
 * Ownership ledger — stored at `.bollard/ownership.json`.
 * Records which files Bollard manages, which files the user owns, and
 * per-file metadata for conflict detection and curation decisions.
 */
export interface TestOwnershipManifest {
  schemaVersion: typeof OWNERSHIP_SCHEMA_VERSION
  /** Files Bollard currently owns. */
  bollardManaged: ManagedFileEntry[]
  /** Paths explicitly released to human ownership. Bollard will not touch these. */
  userOwned: string[]
  /** Unix timestamp (ms) of the last manifest write. */
  lastUpdated: number
}

/** A conflict detected when a human has edited a Bollard-managed file. */
export interface ConflictReport {
  /** Relative path from workDir. */
  filePath: string
  /** `low` = test file only; `medium` = source file; `high` = config/infra file. */
  severity: "low" | "medium" | "high"
  /** SHA Bollard last wrote at. */
  lastBollardSha: string
  /** Current HEAD SHA for the file (from git log). */
  currentSha: string
  detail: string
}

const MANIFEST_FILENAME = "ownership.json"
const BOLLARD_DIR = ".bollard"

const DEFAULT_MANIFEST: TestOwnershipManifest = {
  schemaVersion: OWNERSHIP_SCHEMA_VERSION,
  bollardManaged: [],
  userOwned: [],
  lastUpdated: 0,
}

export class FileOwnershipStore {
  readonly manifestPath: string

  constructor(private readonly workDir: string) {
    this.manifestPath = join(resolve(workDir), BOLLARD_DIR, MANIFEST_FILENAME)
  }

  async read(): Promise<TestOwnershipManifest> {
    try {
      const raw = await readFile(this.manifestPath, "utf-8")
      const parsed: unknown = JSON.parse(raw)
      return this.validate(parsed)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          schemaVersion: OWNERSHIP_SCHEMA_VERSION,
          bollardManaged: [],
          userOwned: [],
          lastUpdated: 0,
        }
      }
      if (err instanceof BollardError) throw err
      throw new BollardError({
        code: "OWNERSHIP_MANIFEST_INVALID",
        message: `Failed to parse ownership manifest: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  async write(manifest: TestOwnershipManifest): Promise<void> {
    await mkdir(join(resolve(this.workDir), BOLLARD_DIR), { recursive: true })
    try {
      await readFile(this.manifestPath, "utf-8")
    } catch {
      await writeFile(this.manifestPath, JSON.stringify({ ...DEFAULT_MANIFEST }), "utf-8")
    }
    const release = await lockfile.lock(this.manifestPath, { retries: 3 })
    try {
      await writeFile(
        this.manifestPath,
        JSON.stringify({ ...manifest, lastUpdated: Date.now() }, null, 2),
        "utf-8",
      )
    } finally {
      await release()
    }
  }

  async claim(
    filePath: string,
    domain: ManagedFileEntry["domain"],
    runId: string,
    commitSha: string,
    mutationScore?: number,
  ): Promise<void> {
    const manifest = await this.read()
    const rel = relative(resolve(this.workDir), resolve(this.workDir, filePath))
    manifest.userOwned = manifest.userOwned.filter((p) => p !== rel)
    const existing = manifest.bollardManaged.findIndex((e) => e.path === rel)
    const entry: ManagedFileEntry = {
      path: rel,
      domain,
      lastCuratedRunId: runId,
      lastCommitSha: commitSha,
      ...(mutationScore !== undefined && { mutationScore }),
    }
    if (existing !== -1) {
      manifest.bollardManaged[existing] = entry
    } else {
      manifest.bollardManaged.push(entry)
    }
    await this.write(manifest)
  }

  async release(filePath: string): Promise<void> {
    const manifest = await this.read()
    const rel = relative(resolve(this.workDir), resolve(this.workDir, filePath))
    manifest.bollardManaged = manifest.bollardManaged.filter((e) => e.path !== rel)
    if (!manifest.userOwned.includes(rel)) {
      manifest.userOwned.push(rel)
    }
    await this.write(manifest)
  }

  private validate(raw: unknown): TestOwnershipManifest {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new BollardError({
        code: "OWNERSHIP_MANIFEST_INVALID",
        message: "ownership.json must be a JSON object",
      })
    }
    const obj = raw as Record<string, unknown>
    if (obj["schemaVersion"] !== OWNERSHIP_SCHEMA_VERSION) {
      throw new BollardError({
        code: "OWNERSHIP_MANIFEST_INVALID",
        message: `Unsupported ownership manifest schema version: ${String(obj["schemaVersion"])}`,
      })
    }
    if (!Array.isArray(obj["bollardManaged"]) || !Array.isArray(obj["userOwned"])) {
      throw new BollardError({
        code: "OWNERSHIP_MANIFEST_INVALID",
        message: "ownership.json must have bollardManaged[] and userOwned[] arrays",
      })
    }
    return raw as TestOwnershipManifest
  }
}

const execFileAsync = promisify(execFile)

/**
 * For each Bollard-managed file, compare the stored lastCommitSha against
 * the most recent git commit that touched the file. A mismatch means a human
 * (or another tool) has committed changes since Bollard last wrote the file.
 *
 * Returns an empty array when no managed files exist or git is unavailable.
 * Never throws — git errors are silently skipped per file (defensive).
 */
export async function detectManagedFileConflicts(
  manifest: TestOwnershipManifest,
  workDir: string,
): Promise<ConflictReport[]> {
  const reports: ConflictReport[] = []
  for (const entry of manifest.bollardManaged) {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["log", "--follow", "--format=%H", "-n", "1", "--", entry.path],
        { cwd: workDir, timeout: 10_000 },
      )
      const currentSha = stdout.trim()
      if (currentSha.length === 0) continue
      if (currentSha === entry.lastCommitSha) continue

      const severity = conflictSeverity(entry.path)
      reports.push({
        filePath: entry.path,
        severity,
        lastBollardSha: entry.lastCommitSha,
        currentSha,
        detail: `Human commit ${currentSha.slice(0, 8)} detected after Bollard commit ${entry.lastCommitSha.slice(0, 8)}`,
      })
    } catch {
      // git unavailable or file not in repo — skip silently
    }
  }
  return reports
}

function conflictSeverity(filePath: string): ConflictReport["severity"] {
  if (filePath.includes("test") || filePath.includes("spec")) return "low"
  if (
    filePath.endsWith(".yml") ||
    filePath.endsWith(".yaml") ||
    filePath.endsWith(".json") ||
    filePath.includes("config")
  ) {
    return "high"
  }
  return "medium"
}
