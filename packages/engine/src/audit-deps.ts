import { execFile } from "node:child_process"
import { access, readFile } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export type DepsCheckId =
  | "npm-vulnerabilities"
  | "helper-manifest-vulnerabilities"
  | "osv-scanner-available"

export type DepsSeverity = "critical" | "high" | "moderate" | "low" | "unknown"

export interface DepsVulnerability {
  package: string
  version: string
  id: string
  severity: DepsSeverity
  manifest: string
  summary?: string
  fixedVersion?: string
}

export interface DepsCheckResult {
  id: DepsCheckId
  label: string
  passed: boolean
  advisory?: boolean
  vulnerabilities: DepsVulnerability[]
  /** Tool or parse failure detail (hard-fail checks only). */
  error?: string
}

export interface AuditDepsResult {
  allPassed: boolean
  checks: DepsCheckResult[]
}

export type OsvScanOutcome =
  | { ok: true; stdout: string }
  | { ok: false; unavailable: true }
  | { ok: false; unavailable: false; error: string }

export type OsvRunner = (workDir: string, targets: string[]) => Promise<OsvScanOutcome>

export interface AuditDepsOptions {
  osvRunner?: OsvRunner
}

const NPM_MANIFESTS = new Set(["pnpm-lock.yaml", "package.json"])
const GO_MOD_REL = "scripts/extract_go/go.mod"
const HELPER_MANIFESTS = new Set([
  GO_MOD_REL,
  "scripts/extract_rs/Cargo.lock",
  "scripts/extract_java/pom.xml",
])

const LOCKFILE_TARGETS = ["pnpm-lock.yaml", "scripts/extract_rs/Cargo.lock"] as const

const MANIFEST_TARGETS = [...LOCKFILE_TARGETS, GO_MOD_REL, "scripts/extract_java/pom.xml"] as const

const MAX_OSV_BUFFER = 16 * 1024 * 1024

interface OsvPackageBlock {
  package?: { name?: string; version?: string; ecosystem?: string }
  vulnerabilities?: OsvVulnBlock[]
  groups?: Array<{ ids?: string[]; max_fixed_version?: string; max_severity?: string }>
}

interface OsvVulnBlock {
  id?: string
  summary?: string
  severity?: Array<{ type?: string; score?: string }>
  database_specific?: { severity?: string; fixed_version?: string }
}

interface OsvResultBlock {
  source?: { path?: string }
  packages?: OsvPackageBlock[]
}

interface OsvJsonRoot {
  results?: OsvResultBlock[]
}

export function normalizeSeverity(raw: string | undefined): DepsSeverity {
  if (!raw) {
    return "unknown"
  }
  const lower = raw.trim().toLowerCase()
  if (lower === "critical") {
    return "critical"
  }
  if (lower === "high") {
    return "high"
  }
  if (lower === "moderate" || lower === "medium") {
    return "moderate"
  }
  if (lower === "low") {
    return "low"
  }
  return "unknown"
}

function severityFromGroup(pkg: OsvPackageBlock, vulnId: string): DepsSeverity | undefined {
  for (const group of pkg.groups ?? []) {
    if (vulnId && group.ids?.includes(vulnId) && group.max_severity) {
      const normalized = normalizeSeverity(group.max_severity)
      if (normalized !== "unknown") {
        return normalized
      }
    }
  }
  return undefined
}

function severityFromVuln(vuln: OsvVulnBlock, pkg?: OsvPackageBlock): DepsSeverity {
  const dbSev = vuln.database_specific?.severity
  if (dbSev) {
    return normalizeSeverity(dbSev)
  }
  for (const entry of vuln.severity ?? []) {
    if (entry.type?.toUpperCase() === "CVSS_V3") {
      const score = Number.parseFloat(entry.score ?? "")
      if (!Number.isNaN(score)) {
        if (score >= 9.0) {
          return "critical"
        }
        if (score >= 7.0) {
          return "high"
        }
        if (score >= 4.0) {
          return "moderate"
        }
        if (score > 0) {
          return "low"
        }
      }
    }
  }
  if (pkg && vuln.id) {
    const fromGroup = severityFromGroup(pkg, vuln.id)
    if (fromGroup) {
      return fromGroup
    }
  }
  return "unknown"
}

function fixedVersionFromPackage(
  pkg: OsvPackageBlock,
  vulnId: string | undefined,
): string | undefined {
  for (const group of pkg.groups ?? []) {
    if (vulnId && group.ids?.includes(vulnId) && group.max_fixed_version) {
      return group.max_fixed_version
    }
  }
  return undefined
}

function relativizeManifest(workDir: string, sourcePath: string): string {
  const abs = resolve(workDir, sourcePath)
  return relative(workDir, abs).split("\\").join("/")
}

export function parseOsvJson(raw: string, workDir: string): DepsVulnerability[] {
  const parsed = JSON.parse(raw) as OsvJsonRoot
  const vulns: DepsVulnerability[] = []

  for (const result of parsed.results ?? []) {
    const manifest = result.source?.path
      ? relativizeManifest(workDir, result.source.path)
      : "unknown"

    for (const pkgBlock of result.packages ?? []) {
      const pkgName = pkgBlock.package?.name ?? "unknown"
      const pkgVersion = pkgBlock.package?.version ?? "unknown"

      for (const vuln of pkgBlock.vulnerabilities ?? []) {
        const id = vuln.id ?? "unknown"
        const fixedVersion =
          vuln.database_specific?.fixed_version ?? fixedVersionFromPackage(pkgBlock, id)
        const entry: DepsVulnerability = {
          package: pkgName,
          version: pkgVersion,
          id,
          severity: severityFromVuln(vuln, pkgBlock),
          manifest,
        }
        if (vuln.summary !== undefined) {
          entry.summary = vuln.summary
        }
        if (fixedVersion !== undefined) {
          entry.fixedVersion = fixedVersion
        }
        vulns.push(entry)
      }
    }
  }

  return vulns
}

function isHardSeverity(severity: DepsSeverity): boolean {
  return severity === "critical" || severity === "high"
}

function gateVulnerabilities(
  vulns: DepsVulnerability[],
  id: DepsCheckId,
  label: string,
): DepsCheckResult {
  if (vulns.length === 0) {
    return { id, label, passed: true, vulnerabilities: [] }
  }

  const hasHard = vulns.some((v) => isHardSeverity(v.severity))
  if (hasHard) {
    return { id, label, passed: false, vulnerabilities: vulns }
  }

  return {
    id,
    label,
    passed: true,
    advisory: true,
    vulnerabilities: vulns,
  }
}

export function checkNpmVulnerabilities(vulns: DepsVulnerability[]): DepsCheckResult {
  const npmVulns = vulns.filter((v) => NPM_MANIFESTS.has(v.manifest))
  return gateVulnerabilities(
    npmVulns,
    "npm-vulnerabilities",
    "npm workspace vulnerabilities (pnpm-lock.yaml / package.json)",
  )
}

export function checkHelperManifestVulnerabilities(vulns: DepsVulnerability[]): DepsCheckResult {
  const helperVulns = vulns.filter((v) => HELPER_MANIFESTS.has(v.manifest))
  return gateVulnerabilities(
    helperVulns,
    "helper-manifest-vulnerabilities",
    "helper extractor manifest vulnerabilities (Go/Rust/Java)",
  )
}

export function checkOsvScannerUnavailable(): DepsCheckResult {
  return {
    id: "osv-scanner-available",
    label: "osv-scanner available (skipped — binary not installed)",
    passed: true,
    advisory: true,
    vulnerabilities: [],
  }
}

function computeAllPassed(checks: DepsCheckResult[]): boolean {
  return checks.filter((c) => !c.advisory).every((c) => c.passed)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export function goModHasExternalRequires(content: string): boolean {
  const lines = content.split("\n")
  let inRequireBlock = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith("//")) {
      continue
    }
    if (/^require\s+\(/u.test(trimmed)) {
      inRequireBlock = true
      continue
    }
    if (inRequireBlock) {
      if (trimmed === ")") {
        inRequireBlock = false
        continue
      }
      if (trimmed.length > 0 && !trimmed.startsWith("//")) {
        return true
      }
      continue
    }
    if (/^require\s+\S/u.test(trimmed)) {
      return true
    }
  }
  return false
}

async function shouldScanGoMod(workDir: string): Promise<boolean> {
  try {
    const content = await readFile(resolve(workDir, GO_MOD_REL), "utf-8")
    return goModHasExternalRequires(content)
  } catch {
    return false
  }
}

export async function resolveManifestTargets(workDir: string): Promise<string[]> {
  const existing: string[] = []
  for (const rel of MANIFEST_TARGETS) {
    if (rel === GO_MOD_REL) {
      if (await shouldScanGoMod(workDir)) {
        existing.push(rel)
      }
      continue
    }
    if (await fileExists(resolve(workDir, rel))) {
      existing.push(rel)
    }
  }
  return existing
}

export async function defaultOsvRunner(
  workDir: string,
  targets: string[],
): Promise<OsvScanOutcome> {
  if (targets.length === 0) {
    return { ok: true, stdout: JSON.stringify({ results: [] }) }
  }

  const lockfiles = targets.filter((t) => (LOCKFILE_TARGETS as readonly string[]).includes(t))
  const manifests = targets.filter((t) => !lockfiles.includes(t))
  const args = [
    "scan",
    "source",
    "--format",
    "json",
    ...lockfiles.flatMap((f) => ["-L", f]),
    ...manifests,
  ]

  try {
    const { stdout } = await execFileAsync("osv-scanner", args, {
      cwd: workDir,
      maxBuffer: MAX_OSV_BUFFER,
    })
    return { ok: true, stdout }
  } catch (err: unknown) {
    const execErr = err as NodeJS.ErrnoException & {
      stdout?: string
      stderr?: string
      code?: number | string
    }

    if (execErr.code === "ENOENT") {
      return { ok: false, unavailable: true }
    }

    if (execErr.stdout && execErr.stdout.trim().length > 0) {
      return { ok: true, stdout: execErr.stdout }
    }

    const detail = execErr.stderr?.trim() || execErr.message || "osv-scanner failed"
    return { ok: false, unavailable: false, error: detail }
  }
}

export async function runOsvScanner(
  workDir: string,
  targets: string[],
  runner: OsvRunner = defaultOsvRunner,
): Promise<OsvScanOutcome> {
  return runner(workDir, targets)
}

export async function auditDeps(
  workDir: string,
  options?: AuditDepsOptions,
): Promise<AuditDepsResult> {
  const runner = options?.osvRunner ?? defaultOsvRunner
  const targets = await resolveManifestTargets(workDir)

  const scanOutcome = await runOsvScanner(workDir, targets, runner)

  if (!scanOutcome.ok) {
    if (scanOutcome.unavailable) {
      const checks = [checkOsvScannerUnavailable()]
      return { allPassed: computeAllPassed(checks), checks }
    }

    const checks: DepsCheckResult[] = [
      {
        id: "npm-vulnerabilities",
        label: "npm workspace vulnerabilities (pnpm-lock.yaml / package.json)",
        passed: false,
        vulnerabilities: [],
        error: scanOutcome.error,
      },
      {
        id: "helper-manifest-vulnerabilities",
        label: "helper extractor manifest vulnerabilities (Go/Rust/Java)",
        passed: false,
        vulnerabilities: [],
        error: scanOutcome.error,
      },
    ]
    return { allPassed: false, checks }
  }

  let vulns: DepsVulnerability[]
  try {
    vulns = parseOsvJson(scanOutcome.stdout, workDir)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const checks: DepsCheckResult[] = [
      {
        id: "npm-vulnerabilities",
        label: "npm workspace vulnerabilities (pnpm-lock.yaml / package.json)",
        passed: false,
        vulnerabilities: [],
        error: `Failed to parse osv-scanner JSON: ${message}`,
      },
      {
        id: "helper-manifest-vulnerabilities",
        label: "helper extractor manifest vulnerabilities (Go/Rust/Java)",
        passed: false,
        vulnerabilities: [],
        error: `Failed to parse osv-scanner JSON: ${message}`,
      },
    ]
    return { allPassed: false, checks }
  }

  const checks: DepsCheckResult[] = [
    checkNpmVulnerabilities(vulns),
    checkHelperManifestVulnerabilities(vulns),
  ]

  return { allPassed: computeAllPassed(checks), checks }
}
