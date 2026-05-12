import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import type { LocalModelsConfig } from "@bollard/engine/src/context.js"
import { BollardError } from "@bollard/engine/src/errors.js"
import {
  DEFAULT_MODEL_ID,
  LocalProvider,
  checkRamFloor,
  isBinaryAvailable,
} from "@bollard/llm/src/providers/local.js"

const execFileAsync = promisify(execFile)

export type VerificationCheck = { label: string; cmd: string; args: string[] }

async function commandOnPath(cmd: string): Promise<boolean> {
  try {
    await execFileAsync("which", [cmd], { timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

async function buildFallbackVerificationChecks(): Promise<VerificationCheck[]> {
  const base: VerificationCheck[] = [
    { label: "typecheck", cmd: "pnpm", args: ["run", "typecheck"] },
    { label: "lint", cmd: "pnpm", args: ["run", "lint"] },
    { label: "test", cmd: "pnpm", args: ["run", "test"] },
  ]
  const extra: VerificationCheck[] = []
  if (await commandOnPath("pnpm")) {
    extra.push({ label: "audit", cmd: "pnpm", args: ["audit", "--audit-level=high"] })
  }
  if (await commandOnPath("gitleaks")) {
    extra.push({
      label: "secretScan",
      cmd: "gitleaks",
      args: ["detect", "--no-banner", "--source", "."],
    })
  }
  return [...base, ...extra]
}

export async function collectVerificationChecks(
  _workDir: string,
  profile?: ToolchainProfile,
): Promise<VerificationCheck[]> {
  if (profile) {
    return [
      ...(profile.checks.typecheck
        ? [
            {
              label: "typecheck",
              cmd: profile.checks.typecheck.cmd,
              args: profile.checks.typecheck.args,
            },
          ]
        : []),
      ...(profile.checks.lint
        ? [
            {
              label: "lint",
              cmd: profile.checks.lint.cmd,
              args: profile.checks.lint.args,
            },
          ]
        : []),
      ...(profile.checks.test
        ? [
            {
              label: "test",
              cmd: profile.checks.test.cmd,
              args: profile.checks.test.args,
            },
          ]
        : []),
      ...(profile.checks.audit
        ? [
            {
              label: "audit",
              cmd: profile.checks.audit.cmd,
              args: profile.checks.audit.args,
            },
          ]
        : []),
      ...(profile.checks.secretScan
        ? [
            {
              label: "secretScan",
              cmd: profile.checks.secretScan.cmd,
              args: profile.checks.secretScan.args,
            },
          ]
        : []),
    ]
  }
  return await buildFallbackVerificationChecks()
}

export async function runVerificationChecks(
  workDir: string,
  checks: VerificationCheck[],
  onlyLabels?: Set<string>,
): Promise<{ failures: string[]; failedLabels: Set<string> }> {
  const subset =
    onlyLabels !== undefined && onlyLabels.size > 0
      ? checks.filter((c) => onlyLabels.has(c.label))
      : checks

  const failures: string[] = []
  const failedLabels = new Set<string>()

  for (const check of subset) {
    process.stderr.write(`\x1b[2m  [verify] running ${check.label}...\x1b[0m\n`)
    try {
      await execFileAsync(check.cmd, check.args, {
        cwd: workDir,
        maxBuffer: 5 * 1024 * 1024,
        timeout: 180_000,
      })
    } catch (err: unknown) {
      const stdout =
        err && typeof err === "object" && "stdout" in err
          ? String((err as { stdout: string }).stdout)
          : ""
      const stderr =
        err && typeof err === "object" && "stderr" in err
          ? String((err as { stderr: string }).stderr)
          : String(err)
      failures.push(`## ${check.label} FAILED\n${`${stdout}\n${stderr}`.slice(0, 3000)}`)
      failedLabels.add(check.label)
    }
  }

  return { failures, failedLabels }
}

export function extractFailedLabelsFromFailures(failures: string[]): Set<string> {
  const labels = new Set<string>()
  for (const f of failures) {
    const m = f.match(/^## (\w+) FAILED/m)
    if (m?.[1]) labels.add(m[1])
  }
  return labels
}

export type AutofixResult = { kind: "fixed"; fixedChecks: string[] } | { kind: "noop" }

export async function runDeterministicAutofix(
  workDir: string,
  failures: string[],
  _profile?: ToolchainProfile,
): Promise<AutofixResult> {
  try {
    if (failures.length === 0) {
      return { kind: "noop" }
    }
    const labels = extractFailedLabelsFromFailures(failures)
    const fixedChecks: string[] = []

    if (labels.has("lint")) {
      try {
        await execFileAsync("biome", ["check", "--write", "--unsafe", "."], {
          cwd: workDir,
          maxBuffer: 5 * 1024 * 1024,
          timeout: 180_000,
        })
        fixedChecks.push("lint")
      } catch {
        /* best-effort */
      }
    }

    if (fixedChecks.length === 0) {
      return { kind: "noop" }
    }
    return { kind: "fixed", fixedChecks }
  } catch {
    return { kind: "noop" }
  }
}

export type PatcherResult =
  | { kind: "patched"; appliedChecks: string[] }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; error: BollardError }

function isValidUnifiedDiff(text: string): boolean {
  return text.includes("---") && text.includes("+++") && /@@/.test(text)
}

async function applyUnifiedDiff(workDir: string, diff: string): Promise<boolean> {
  return await new Promise((resolve) => {
    try {
      const child = spawn("patch", ["--strip=1", "--forward", "--batch"], {
        cwd: workDir,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      })
      child.on("error", () => {
        resolve(false)
      })
      child.on("close", (code) => {
        resolve(code === 0)
      })
      const stdin = child.stdin
      if (!stdin) {
        resolve(false)
        return
      }
      stdin.write(diff, "utf8", () => {
        stdin.end()
      })
    } catch {
      resolve(false)
    }
  })
}

export async function runLocalPatcher(
  workDir: string,
  failures: string[],
  localModelsConfig: Partial<LocalModelsConfig> | undefined,
  profile?: ToolchainProfile,
): Promise<PatcherResult> {
  try {
    if (!(await isBinaryAvailable())) {
      return { kind: "skipped", reason: "llama-cli binary not found" }
    }
    const minGb = localModelsConfig?.minFreeRamGb ?? 3
    if (!checkRamFloor(minGb)) {
      return { kind: "skipped", reason: "insufficient free RAM" }
    }
    if (localModelsConfig === undefined) {
      return { kind: "skipped", reason: "local models config missing" }
    }

    const beforeLabels = extractFailedLabelsFromFailures(failures)
    if (beforeLabels.size === 0) {
      return { kind: "skipped", reason: "no failed checks in failures payload" }
    }

    const truncated = failures.slice(0, 3).map((f) => f.slice(0, 2000))
    const userMessage = `Fix these verification failures in the codebase at ${workDir}:

${truncated.join("\n\n---\n\n")}

Output a unified diff only. If you cannot fix all failures in one diff, fix as many as you can.`

    const system =
      "You are a code repair assistant. Given failing check output, produce a minimal unified diff (--- a/path +++ b/path @@ ... @@) that fixes all reported errors. Output ONLY the diff, no explanation, no markdown fences."

    const provider = new LocalProvider(localModelsConfig)
    let text = ""
    try {
      const response = await provider.chat({
        system,
        messages: [{ role: "user", content: userMessage }],
        maxTokens: 512,
        temperature: 0.2,
        model: localModelsConfig.patcherModel ?? DEFAULT_MODEL_ID,
      })
      text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("")
        .trim()
    } catch (err: unknown) {
      return {
        kind: "failed",
        error: new BollardError({
          code: "PATCHER_PATCH_INVALID",
          message: err instanceof Error ? err.message : String(err),
        }),
      }
    }

    if (!isValidUnifiedDiff(text)) {
      return {
        kind: "failed",
        error: new BollardError({
          code: "PATCHER_PATCH_INVALID",
          message: "local patcher did not return a valid unified diff",
        }),
      }
    }

    const applied = await applyUnifiedDiff(workDir, text)
    if (!applied) {
      return {
        kind: "failed",
        error: new BollardError({
          code: "PATCHER_PATCH_INVALID",
          message: "patch command failed to apply diff",
        }),
      }
    }

    const checks = await collectVerificationChecks(workDir, profile)
    const { failedLabels: afterFailed } = await runVerificationChecks(workDir, checks, beforeLabels)

    const appliedChecks: string[] = []
    for (const label of beforeLabels) {
      if (!afterFailed.has(label)) {
        appliedChecks.push(label)
      }
    }
    if (appliedChecks.length === 0) {
      return {
        kind: "failed",
        error: new BollardError({
          code: "PATCHER_NO_PROGRESS",
          message: "patch applied but check still fails",
        }),
      }
    }
    return { kind: "patched", appliedChecks }
  } catch (err: unknown) {
    return {
      kind: "failed",
      error: new BollardError({
        code: "PATCHER_PATCH_INVALID",
        message: String(err),
      }),
    }
  }
}

function autofixNoteForChecks(fixedChecks: string[]): string {
  if (fixedChecks.length === 0) return ""
  const parts = fixedChecks.map((c) => (c === "lint" ? "Biome lint" : `${c} check`))
  if (parts.length === 1) {
    const only = parts[0]
    return only !== undefined ? `${only} was auto-fixed automatically` : ""
  }
  return `${parts.join(", ")} were auto-fixed automatically`
}

export function buildPatcherFeedback(
  remainingFailures: string[],
  autofixResult: AutofixResult,
  patcherResult: PatcherResult,
): string {
  const lines: string[] = [
    "The system ran verification checks automatically. Fix the following remaining issues and output your completion JSON again:",
    "",
    ...remainingFailures,
  ]

  if (autofixResult.kind === "fixed" && autofixResult.fixedChecks.length > 0) {
    const pronoun = autofixResult.fixedChecks.length === 1 ? "it" : "them"
    lines.push(
      "",
      `Note: ${autofixNoteForChecks(autofixResult.fixedChecks)} (you do not need to address ${pronoun}).`,
    )
  }

  if (patcherResult.kind === "patched" && patcherResult.appliedChecks.length > 0) {
    lines.push(
      "",
      `Note: The local model fixed the following checks (you do not need to re-fix them): ${patcherResult.appliedChecks.join(", ")}.`,
    )
  }

  if (patcherResult.kind === "failed") {
    lines.push("", "Note: 1 issue was partially patched by the local model but still fails.")
  }

  return lines.join("\n")
}
