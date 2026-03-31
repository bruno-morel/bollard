import { execFile } from "node:child_process"
import { readFile, readdir } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { createCoderAgent } from "@bollard/agents/src/coder.js"
import { executeAgent } from "@bollard/agents/src/executor.js"
import { createPlannerAgent } from "@bollard/agents/src/planner.js"
import { createTesterAgent } from "@bollard/agents/src/tester.js"
import type { AgentContext, ExecutorOptions } from "@bollard/agents/src/types.js"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import type { BlueprintNode, NodeResult } from "@bollard/engine/src/blueprint.js"
import type { BollardConfig, PipelineContext } from "@bollard/engine/src/context.js"
import { LLMClient } from "@bollard/llm/src/client.js"
import type { ExtractedSignature } from "@bollard/verify/src/type-extractor.js"

const execFileAsync = promisify(execFile)
const MAX_PRELOAD_CHARS_PER_FILE = 10_000
const MAX_PRELOAD_FILES = 10

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

async function preloadAffectedFiles(plan: unknown, workDir: string): Promise<string> {
  if (!plan || typeof plan !== "object") return ""

  const affectedFiles = (plan as Record<string, unknown>)["affected_files"] as
    | Record<string, string[]>
    | undefined
  if (!affectedFiles) return ""

  const filesToRead = [...(affectedFiles["modify"] ?? [])].slice(0, MAX_PRELOAD_FILES)
  const sections: string[] = []

  for (const filePath of filesToRead) {
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
    const checks = profile
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
        ]
      : [
          { label: "typecheck", cmd: "pnpm", args: ["run", "typecheck"] },
          { label: "lint", cmd: "pnpm", args: ["run", "lint"] },
          { label: "test", cmd: "pnpm", args: ["run", "test"] },
        ]

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
  const signatures = sigResult?.data as { signatures?: ExtractedSignature[] } | undefined

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

  for (const sig of signatures?.signatures ?? []) {
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

  sections.push(
    "# Instructions",
    "Write a complete test file. Output ONLY the TypeScript test code, no explanations.",
  )

  return sections.join("\n")
}

export async function createAgenticHandler(
  config: BollardConfig,
  workDir: string,
  profile?: ToolchainProfile,
): Promise<(node: BlueprintNode, ctx: PipelineContext) => Promise<NodeResult>> {
  const llmClient = new LLMClient(config)
  const agents = {
    planner: await createPlannerAgent(profile),
    coder: await createCoderAgent(profile),
    tester: await createTesterAgent(profile),
  }

  return async (node: BlueprintNode, ctx: PipelineContext): Promise<NodeResult> => {
    const agentRole = node.agent ?? "default"
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
    const agentCtx: AgentContext = {
      pipelineCtx: ctx,
      workDir,
      ...(profile?.allowedCommands ? { allowedCommands: profile.allowedCommands } : {}),
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
      const preloaded = await preloadAffectedFiles(ctx.plan, workDir)
      userMessage = `Task: ${ctx.task}\n\nApproved Plan:\n${JSON.stringify(ctx.plan, null, 2)}${preloaded}`
      executorOptions = {
        postCompletionHook: createVerificationHook(workDir, profile),
        maxVerificationRetries: 3,
      }
    }

    if (agentRole === "tester") {
      userMessage = buildTesterMessage(ctx)
    }

    const startMs = Date.now()
    const result = await executeAgent(
      agent,
      userMessage,
      provider,
      model,
      agentCtx,
      executorOptions,
    )

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
}
