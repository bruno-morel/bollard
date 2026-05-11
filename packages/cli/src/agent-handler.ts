import { execFile } from "node:child_process"
import { readFile, readdir } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { createBehavioralTesterAgent } from "@bollard/agents/src/behavioral-tester.js"
import { createBoundaryTesterAgent } from "@bollard/agents/src/boundary-tester.js"
import { createCoderAgent } from "@bollard/agents/src/coder.js"
import { createContractTesterAgent } from "@bollard/agents/src/contract-tester.js"
import { executeAgent } from "@bollard/agents/src/executor.js"
import { createPlannerAgent } from "@bollard/agents/src/planner.js"
import { createSemanticReviewerAgent } from "@bollard/agents/src/semantic-reviewer.js"
import type { AgentContext, AgentResult, ExecutorOptions } from "@bollard/agents/src/types.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import type { BlueprintNode, NodeResult } from "@bollard/engine/src/blueprint.js"
import type { BollardConfig, PipelineContext } from "@bollard/engine/src/context.js"
import { BollardError } from "@bollard/engine/src/errors.js"
import { LLMClient } from "@bollard/llm/src/client.js"
import type { BehavioralContext } from "@bollard/verify/src/behavioral-extractor.js"
import {
  MAX_PRELOAD_CHARS_PER_FILE,
  MAX_PRELOAD_FILES,
} from "@bollard/verify/src/context-expansion.js"
import type { ContractContext } from "@bollard/verify/src/contract-extractor.js"
import type {
  ExtractedSignature,
  ExtractedTypeDefinition,
} from "@bollard/verify/src/type-extractor.js"
import { createAgentSpinner } from "./spinner.js"

const execFileAsync = promisify(execFile)

type VerificationCheck = { label: string; cmd: string; args: string[] }

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

function buildFileFilter(profile?: ToolchainProfile): (entry: string) => boolean {
  if (profile) {
    const ignores = new Set(profile.ignorePatterns)
    const srcExts = profile.sourcePatterns
      .filter((p) => p.startsWith("**/*."))
      .map((p) => p.replace("**/*", ""))
    return (e: string) => {
      if (ignores.has(e)) return false
      for (const ig of ignores) {
        if (e.includes(ig)) return false
      }
      if (srcExts.length === 0) return true
      return srcExts.some((ext) => e.endsWith(ext)) || e.endsWith(".md")
    }
  }

  return (e: string) =>
    (e.endsWith(".ts") || e.endsWith(".md")) &&
    !e.includes("node_modules") &&
    !e.includes("dist") &&
    !e.includes(".tsbuildinfo")
}

export async function buildProjectTree(
  workDir: string,
  profile?: ToolchainProfile,
): Promise<string> {
  try {
    const rootEntries = await readdir(workDir)
    const rootFiles = rootEntries
      .filter((e) => !e.startsWith(".") && e !== "node_modules" && e !== "spec" && e !== "dist")
      .sort()

    const pkgEntries = await readdir(resolve(workDir, "packages"), {
      recursive: true,
    })
    const fileFilter = buildFileFilter(profile)
    const sourceFiles = (pkgEntries as string[])
      .filter(fileFilter)
      .sort()
      .map((f) => `  packages/${f}`)

    const tree = [...rootFiles.map((f) => `  ${f}`), ...sourceFiles]

    return `## Project File Tree (auto-generated)\nThis replaces list_dir exploration. Do NOT call list_dir on directories already shown here.\n\n\`\`\`\n${tree.join("\n")}\n\`\`\``
  } catch {
    return ""
  }
}

function parsePlanResponse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1])
      } catch {
        return { raw: text }
      }
    }
    return { raw: text }
  }
}

export async function preloadAffectedFiles(ctx: PipelineContext, workDir: string): Promise<string> {
  if (!ctx.plan || typeof ctx.plan !== "object") return ""

  const affectedFiles = (ctx.plan as Record<string, unknown>)["affected_files"] as
    | Record<string, string[]>
    | undefined
  if (!affectedFiles) return ""

  const expandData = ctx.results["expand-affected-files"]?.data as
    | { expanded?: { files?: string[] } }
    | undefined
  const expandedFiles = expandData?.expanded?.files
  const fromPlan = affectedFiles["modify"] ?? []
  const filesToRead = expandedFiles && expandedFiles.length > 0 ? [...expandedFiles] : [...fromPlan]
  const capped = filesToRead.slice(0, MAX_PRELOAD_FILES)
  const sections: string[] = []

  for (const filePath of capped) {
    try {
      const content = await readFile(resolve(workDir, filePath), "utf-8")
      const capped =
        content.length > MAX_PRELOAD_CHARS_PER_FILE
          ? `${content.slice(0, MAX_PRELOAD_CHARS_PER_FILE)}\n[...file truncated at 10000 chars]`
          : content
      sections.push(`### ${filePath}\n\`\`\`\n${capped}\n\`\`\``)
    } catch {
      // file might not exist yet — skip silently
    }
  }

  if (sections.length === 0) return ""
  return `\n\n## Pre-loaded File Contents\nThese files from the plan have been pre-read. Do NOT call read_file on these — the contents are already here.\n\n${sections.join("\n\n")}`
}

function createVerificationHook(
  workDir: string,
  profile?: ToolchainProfile,
): (text: string) => Promise<string | null> {
  return async (): Promise<string | null> => {
    const checks: VerificationCheck[] = profile
      ? [
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
      : await buildFallbackVerificationChecks()

    const failures: string[] = []

    for (const check of checks) {
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
      }
    }

    if (failures.length === 0) {
      process.stderr.write("\x1b[32m  [verify] all checks passed\x1b[0m\n")
      return null
    }

    return `The system ran verification checks automatically. Fix the following issues and output your completion JSON again:\n\n${failures.join("\n\n")}`
  }
}

function buildTesterMessage(ctx: PipelineContext): string {
  const sigResult = ctx.results["extract-signatures"]
  const extractionData = sigResult?.data as
    | { signatures?: ExtractedSignature[]; types?: ExtractedTypeDefinition[] }
    | undefined

  const plan = ctx.plan as
    | {
        summary?: string
        acceptance_criteria?: string[]
        steps?: { runtimeConstraints?: string[] }[]
      }
    | undefined

  const sections: string[] = [
    "# Task",
    ctx.task,
    "",
    "# Acceptance Criteria",
    ...(plan?.acceptance_criteria ?? ["(no criteria provided)"]).map((c, i) => `${i + 1}. ${c}`),
    "",
  ]

  const allConstraints = (plan?.steps ?? []).flatMap((s) => s.runtimeConstraints ?? [])
  const uniqueConstraints = [...new Set(allConstraints)]
  if (uniqueConstraints.length > 0) {
    sections.push(
      "# Runtime Constraints (not visible in type signatures)",
      "",
      ...uniqueConstraints,
      "",
    )
  }

  sections.push("# Public API Surface (signatures only — implementation bodies stripped)", "")

  for (const sig of extractionData?.signatures ?? []) {
    sections.push(`## ${sig.filePath}`, "")
    if (sig.imports) {
      sections.push("### Imports", `\`\`\`typescript\n${sig.imports}\n\`\`\``, "")
    }
    if (sig.types) {
      sections.push("### Types", `\`\`\`typescript\n${sig.types}\n\`\`\``, "")
    }
    if (sig.signatures) {
      sections.push("### Signatures", `\`\`\`typescript\n${sig.signatures}\n\`\`\``, "")
    }
  }

  const referencedTypes = extractionData?.types ?? []
  if (referencedTypes.length > 0) {
    sections.push("# Referenced Type Definitions", "")
    for (const typeDef of referencedTypes) {
      sections.push(`\`\`\`typescript\n${typeDef.definition}\n\`\`\``, "")
    }
  }

  const lang = ctx.toolchainProfile?.language ?? "typescript"
  const langLabel =
    lang === "typescript"
      ? "TypeScript"
      : lang === "python"
        ? "Python"
        : lang === "go"
          ? "Go"
          : lang === "rust"
            ? "Rust"
            : lang

  sections.push(
    "# Instructions",
    `Output exactly one JSON claims document as specified in your system prompt (markdown code fence labeled json). Each claim's test field is the ${langLabel} test case body plus wrapper (${langLabel} test framework); imports before the wrapper. No prose outside the fence.`,
  )

  return sections.join("\n")
}

function buildSemanticReviewerMessage(ctx: PipelineContext): string {
  const diffRes = ctx.results["generate-review-diff"]?.data as { diff?: string } | undefined
  const diff = diffRes?.diff ?? ""
  const plan = ctx.plan
  return `## Git Diff

<diff>
${diff}
</diff>

## Plan

<plan>
${JSON.stringify(plan ?? {}, null, 2)}
</plan>

Review the diff against the plan. Output a JSON ReviewDocument.`
}

function buildContractTesterMessage(ctx: PipelineContext): string {
  const raw = ctx.results["extract-contracts"]?.data as { contract?: ContractContext } | undefined
  const contract = raw?.contract
  const plan = ctx.plan as Record<string, unknown> | undefined
  const lines: string[] = [
    "# Task",
    ctx.task,
    "",
    "# ContractContext",
    JSON.stringify(contract ?? { modules: [], edges: [], affectedEdges: [] }, null, 2),
  ]
  if (typeof plan?.["summary"] === "string") {
    lines.push("", "# Plan summary", plan["summary"])
  }
  const ac = plan?.["acceptance_criteria"]
  if (Array.isArray(ac)) {
    lines.push("", "# Acceptance criteria", ...ac.map((c, i) => `${i + 1}. ${String(c)}`))
  }
  lines.push(
    "",
    "# Instructions",
    "Emit a JSON claims document probing cross-module contracts. Focus on affectedEdges. Output ONLY the JSON document wrapped in a ```json fence, no other prose.",
  )
  return lines.join("\n")
}

function buildBehavioralTesterMessage(ctx: PipelineContext): string {
  const raw = ctx.results["extract-behavioral-context"]?.data as
    | { context?: BehavioralContext; skipBehavioral?: boolean }
    | undefined
  const behavioral = raw?.context
  const plan = ctx.plan as Record<string, unknown> | undefined
  const lines: string[] = [
    "# Task",
    ctx.task,
    "",
    "# BehavioralContext",
    JSON.stringify(
      behavioral ?? { endpoints: [], config: [], dependencies: [], failureModes: [] },
      null,
      2,
    ),
  ]
  if (typeof plan?.["summary"] === "string") {
    lines.push("", "# Plan summary", plan["summary"])
  }
  const ac = plan?.["acceptance_criteria"]
  if (Array.isArray(ac)) {
    lines.push("", "# Acceptance criteria", ...ac.map((c, i) => `${i + 1}. ${String(c)}`))
  }
  lines.push(
    "",
    "# Instructions",
    "Emit a JSON claims document for behavioral/system-level adversarial tests. Output ONLY the JSON document wrapped in a ```json fence, no other prose.",
  )
  return lines.join("\n")
}

export interface AgenticHandlerResult {
  handler: (node: BlueprintNode, ctx: PipelineContext) => Promise<NodeResult>
  llmConfig: { provider: import("@bollard/llm/src/types.js").LLMProvider; model: string }
}

export async function createAgenticHandler(
  config: BollardConfig,
  workDir: string,
  profile?: ToolchainProfile,
): Promise<AgenticHandlerResult> {
  const llmClient = new LLMClient(config)
  const agents = {
    planner: await createPlannerAgent(profile),
    coder: await createCoderAgent(profile),
    "boundary-tester": await createBoundaryTesterAgent(profile),
    "contract-tester": await createContractTesterAgent(profile),
    "behavioral-tester": await createBehavioralTesterAgent(profile),
    "semantic-reviewer": await createSemanticReviewerAgent(profile),
  }

  const extractionLlm = llmClient.forAgent("boundary-tester")

  const handler = async (node: BlueprintNode, ctx: PipelineContext): Promise<NodeResult> => {
    const agentRole = node.agent ?? "default"

    if (agentRole === "contract-tester") {
      if (!profile?.adversarial.contract.enabled) {
        return { status: "ok", data: "", cost_usd: 0, duration_ms: 0 }
      }
      const riskGate = ctx.results["assess-contract-risk"]?.data as
        | { skipContract?: boolean }
        | undefined
      if (riskGate?.skipContract) {
        return { status: "ok", data: "", cost_usd: 0, duration_ms: 0 }
      }
    }

    if (agentRole === "behavioral-tester") {
      if (!profile?.adversarial.behavioral.enabled) {
        return { status: "ok", data: "", cost_usd: 0, duration_ms: 0 }
      }
      const beh = ctx.results["extract-behavioral-context"]?.data as
        | { skipBehavioral?: boolean; skipped?: boolean }
        | undefined
      if (beh?.skipped || beh?.skipBehavioral) {
        return { status: "ok", data: "", cost_usd: 0, duration_ms: 0 }
      }
    }

    const agent = agents[agentRole as keyof typeof agents]

    if (!agent) {
      const { provider, model } = llmClient.forAgent(agentRole)
      const startMs = Date.now()
      const response = await provider.chat({
        system: `You are the "${agentRole}" agent in a Bollard pipeline run.`,
        messages: [
          {
            role: "user",
            content: `Task: ${ctx.task}\nNode: ${node.name}\nBlueprint: ${ctx.blueprintId}`,
          },
        ],
        maxTokens: 1024,
        temperature: 0.3,
        model,
      })
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("")
      return {
        status: "ok",
        data: text,
        cost_usd: response.costUsd,
        duration_ms: Date.now() - startMs,
      }
    }

    const { provider, model } = llmClient.forAgent(agentRole)
    const spinner = createAgentSpinner()
    const agentCtx: AgentContext = {
      pipelineCtx: ctx,
      workDir,
      ...(profile?.allowedCommands ? { allowedCommands: profile.allowedCommands } : {}),
      progress: (ev) => spinner.handleEvent(ev),
    }

    let userMessage = `Task: ${ctx.task}`
    let executorOptions: ExecutorOptions | undefined

    if (agentRole === "planner") {
      const projectTree = await buildProjectTree(workDir, profile)
      if (projectTree) {
        userMessage = `Task: ${ctx.task}\n\n${projectTree}`
      }
    }

    if (agentRole === "coder" && ctx.plan) {
      const preloaded = await preloadAffectedFiles(ctx, workDir)
      userMessage = `Task: ${ctx.task}\n\nApproved Plan:\n${JSON.stringify(ctx.plan, null, 2)}${preloaded}`
      executorOptions = {
        postCompletionHook: createVerificationHook(workDir, profile),
        maxVerificationRetries: 3,
        deferPostCompletionVerifyFromTurn: Math.floor(agents.coder.maxTurns * 0.8),
      }
    }

    if (agentRole === "boundary-tester") {
      userMessage = buildTesterMessage(ctx)
    }

    if (agentRole === "contract-tester") {
      userMessage = buildContractTesterMessage(ctx)
    }

    if (agentRole === "behavioral-tester") {
      userMessage = buildBehavioralTesterMessage(ctx)
    }

    if (agentRole === "semantic-reviewer") {
      userMessage = buildSemanticReviewerMessage(ctx)
    }

    const rollbackSha = agentRole === "coder" ? ctx.rollbackSha : undefined
    const onBollardBranch = ctx.gitBranch !== undefined

    const startMs = Date.now()
    let result: AgentResult
    try {
      result = await executeAgent(agent, userMessage, provider, model, agentCtx, executorOptions)
    } catch (err: unknown) {
      if (rollbackSha && onBollardBranch) {
        try {
          await execFileAsync("git", ["checkout", "--", "."], { cwd: workDir })
          await execFileAsync("git", ["clean", "-fd"], { cwd: workDir })
          await execFileAsync("git", ["reset", "--hard", rollbackSha], { cwd: workDir })
          process.stderr.write(
            `\x1b[33m  [rollback] Reset to ${rollbackSha.slice(0, 8)} after coder failure\x1b[0m\n`,
          )
        } catch (rollbackErr: unknown) {
          const msg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
          process.stderr.write(`\x1b[31m  [rollback] Failed: ${msg}\x1b[0m\n`)
        }
      }
      const partialCost =
        BollardError.is(err) && typeof err.context?.["totalCostUsd"] === "number"
          ? err.context["totalCostUsd"]
          : 0
      const errorCode = BollardError.is(err) ? err.code : "NODE_EXECUTION_FAILED"
      const errorMsg = err instanceof Error ? err.message : String(err)
      return {
        status: "fail",
        data: "",
        cost_usd: partialCost,
        duration_ms: Date.now() - startMs,
        error: { code: errorCode, message: errorMsg },
      }
    } finally {
      spinner.finalize()
    }

    if (agentRole === "planner") {
      ctx.plan = parsePlanResponse(result.response)
    }

    return {
      status: "ok",
      data: result.response,
      cost_usd: result.totalCostUsd,
      duration_ms: Date.now() - startMs,
    }
  }

  return { handler, llmConfig: extractionLlm }
}
