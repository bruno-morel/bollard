import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import { promisify } from "node:util"
import type { LanguageId, ToolchainProfile } from "@bollard/detect/src/types.js"
import type { Blueprint, NodeResult } from "@bollard/engine/src/blueprint.js"
import type { PipelineContext } from "@bollard/engine/src/context.js"
import { BollardError } from "@bollard/engine/src/errors.js"
import type { LLMProvider } from "@bollard/llm/src/types.js"
import { extractProbes } from "@bollard/observe/src/probe-extractor.js"
import type { BehavioralContext } from "@bollard/verify/src/behavioral-extractor.js"
import { buildBehavioralContext } from "@bollard/verify/src/behavioral-extractor.js"
import { behavioralContextToCorpus } from "@bollard/verify/src/behavioral-grounding.js"
import {
  generateBehavioralCompose,
  generateVerifyCompose,
} from "@bollard/verify/src/compose-generator.js"
import type { ContractContext } from "@bollard/verify/src/contract-extractor.js"
import { buildContractContext } from "@bollard/verify/src/contract-extractor.js"
import {
  contractContextToCorpus,
  parseClaimDocument,
  verifyClaimGrounding,
} from "@bollard/verify/src/contract-grounding.js"
import type { ClaimRecord, EnabledConcerns } from "@bollard/verify/src/contract-grounding.js"
import { runTests } from "@bollard/verify/src/dynamic.js"
import { runMutationTesting } from "@bollard/verify/src/mutation.js"
import {
  buildReviewCorpus,
  parseReviewDocument,
  verifyReviewGrounding,
} from "@bollard/verify/src/review-grounding.js"
import type { ReviewDocument, ReviewFinding } from "@bollard/verify/src/review-grounding.js"
import { runStaticChecks } from "@bollard/verify/src/static.js"
import {
  resolveBehavioralTestOutputRel,
  resolveContractTestOutputRel,
} from "@bollard/verify/src/test-lifecycle.js"
import { extractPrivateIdentifiers, getExtractor } from "@bollard/verify/src/type-extractor.js"
import {
  deriveAdversarialTestPath,
  inferJvmPackageFromMainSource,
  jvmContractCoerceVitestItToJUnit5,
  normalizeJvmWrittenTestClassName,
  resolveContractTestModulePrefix,
  sanitizeJavaPrimitiveInstanceofMisuse,
  stripMarkdownFences,
} from "./write-tests-helpers.js"

const execFileAsync = promisify(execFile)

async function formatGeneratedAdversarialTestFile(
  ctx: PipelineContext,
  workDir: string,
  fullPath: string,
): Promise<void> {
  if (fullPath.endsWith(".java") || fullPath.endsWith(".kt")) {
    return
  }
  try {
    await execFileAsync("biome", ["check", "--write", "--unsafe", fullPath], {
      cwd: workDir,
      timeout: 15_000,
    })
    ctx.log.debug?.(`Formatted ${fullPath}`)
  } catch {
    ctx.log.debug?.(`Biome format skipped for ${fullPath}`)
  }
}

function getAffectedSourceFiles(ctx: PipelineContext): string[] {
  const plan = ctx.plan
  if (!plan || typeof plan !== "object") return []
  const af = (plan as Record<string, unknown>)["affected_files"] as
    | Record<string, string[]>
    | undefined
  if (!af) return []

  const allFiles = [...(af["modify"] ?? []), ...(af["create"] ?? [])]
  const profile = ctx.toolchainProfile

  if (profile) {
    const srcExts = profile.sourcePatterns
      .filter((p) => p.startsWith("**/*."))
      .map((p) => p.replace("**/*", ""))
    const testExts = profile.testPatterns
      .filter((p) => p.startsWith("**/*."))
      .map((p) => p.replace("**/*", ""))

    return allFiles.filter((f) => {
      if (testExts.some((ext) => f.endsWith(ext))) return false
      if (f.includes(".test.") || f.includes(".spec.") || f.includes("test_")) return false
      return srcExts.length === 0 || srcExts.some((ext) => f.endsWith(ext))
    })
  }

  return allFiles.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
}

export function scanDiffForExportChanges(diffText: string, language?: LanguageId): boolean {
  const lines = diffText.split("\n")
  return lines.some((line) => isExportChangeLine(line, language))
}

function isExportChangeLine(line: string, language?: LanguageId): boolean {
  if (!line.startsWith("+") && !line.startsWith("-")) return false
  const content = line.slice(1)

  switch (language) {
    case "python":
      return isPythonExportChange(content)
    case "go":
      return isGoExportChange(content)
    case "rust":
      return isRustExportChange(content)
    case "java":
      return isJavaExportChange(content)
    case "kotlin":
      return isKotlinExportChange(content)
    default:
      return /^export\s/.test(content)
  }
}

function isPythonExportChange(content: string): boolean {
  const trimmed = content.trimStart()
  if (content === trimmed) {
    if (/^(def|class|async\s+def)\s/.test(trimmed)) return true
  }
  if (trimmed.includes("__all__")) return true
  if (/^from\s+\./.test(trimmed)) return true
  return false
}

function isGoExportChange(content: string): boolean {
  const trimmed = content.trimStart()
  if (/^(func|type|var|const)\s+[A-Z]/.test(trimmed)) return true
  if (/^func\s*\([^)]+\)\s*[A-Z]/.test(trimmed)) return true
  return false
}

function isRustExportChange(content: string): boolean {
  const trimmed = content.trimStart()
  if (/^pub\s+(fn|struct|enum|trait|type|mod|use)\s/.test(trimmed)) return true
  if (/^pub\s*\(/.test(trimmed)) return true
  return false
}

function isJavaExportChange(content: string): boolean {
  const trimmed = content.trimStart()
  if (/^public\s+(class|interface|enum|record|@interface)\s/.test(trimmed)) return true
  if (/^public\s+[\w<>,\s\[\]]+\s+\w+\s*\(/.test(trimmed)) return true
  if (/^public\s+static\s+final\s+/.test(trimmed)) return true
  return false
}

function isKotlinExportChange(content: string): boolean {
  const trimmed = content.trimStart()
  if (/^(private|internal)\s+/.test(trimmed)) return false
  if (/^\s*fun\s+\w+\s*[:(]/.test(trimmed)) return true
  if (/^\s*(data\s+)?class\s+\w+/.test(trimmed)) return true
  if (/^\s*interface\s+\w+/.test(trimmed)) return true
  if (/^\s*object\s+\w+/.test(trimmed)) return true
  if (/^\s*(val|var)\s+\w+\s*:/.test(trimmed)) return true
  return false
}

async function hasExportedSymbolChanges(
  workDir: string,
  profile: ToolchainProfile,
  warn: (message: string, data?: Record<string, unknown>) => void,
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "main", "--", ...profile.sourcePatterns],
      { cwd: workDir },
    )
    return scanDiffForExportChanges(stdout, profile.language)
  } catch (err: unknown) {
    warn("hasExportedSymbolChanges: git diff failed, assuming exports changed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return true
  }
}

export interface BlueprintLlmConfig {
  provider?: LLMProvider
  model?: string
}

export function createImplementFeatureBlueprint(
  workDir: string,
  llmConfig?: BlueprintLlmConfig,
): Blueprint {
  return {
    id: "implement-feature",
    name: "Implement Feature",
    nodes: [
      {
        id: "create-branch",
        name: "Create Git Branch",
        type: "deterministic",
        execute: async (ctx: PipelineContext): Promise<NodeResult> => {
          const branchName = `bollard/${ctx.runId}`
          try {
            await execFileAsync("git", ["checkout", "-b", branchName], { cwd: workDir })
            ctx.gitBranch = branchName
            try {
              const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workDir })
              ctx.rollbackSha = (
                Buffer.isBuffer(stdout) ? stdout.toString("utf8") : String(stdout)
              ).trim()
            } catch {
              /* best-effort — rollback unavailable if rev-parse fails */
            }
            return { status: "ok", data: { branch: branchName } }
          } catch (err: unknown) {
            return {
              status: "fail",
              error: {
                code: "NODE_EXECUTION_FAILED",
                message: err instanceof Error ? err.message : String(err),
              },
            }
          }
        },
      },

      {
        id: "generate-plan",
        name: "Generate Plan",
        type: "agentic",
        agent: "planner",
      },

      {
        id: "approve-plan",
        name: "Approve Plan",
        type: "human_gate",
      },

      {
        id: "implement",
        name: "Implement Code",
        type: "agentic",
        agent: "coder",
        maxRetries: 1,
        onFailure: "stop",
      },

      {
        id: "static-checks",
        name: "Static Verification",
        type: "deterministic",
        onFailure: "skip",
        execute: async (ctx: PipelineContext): Promise<NodeResult> => {
          const { results, allPassed } = await runStaticChecks(workDir, ctx.toolchainProfile)
          if (!allPassed) {
            const failures = results.filter((r) => !r.passed).map((r) => r.check)
            return {
              status: "fail",
              data: results,
              error: {
                code: "STATIC_CHECK_FAILED",
                message: `Static checks failed: ${failures.join(", ")}`,
              },
            }
          }
          return { status: "ok", data: results }
        },
      },

      {
        id: "extract-signatures",
        name: "Extract Type Signatures",
        type: "deterministic",
        execute: async (ctx: PipelineContext): Promise<NodeResult> => {
          const profile = ctx.toolchainProfile
          const lang = profile?.language ?? "typescript"

          const files = getAffectedSourceFiles(ctx)
          if (files.length === 0) {
            return { status: "ok", data: { filesExtracted: 0, signatures: [], types: [] } }
          }

          const fullPaths = files.map((f) => resolve(workDir, f))
          const extractor = getExtractor(lang, llmConfig?.provider, llmConfig?.model, ctx.log.warn)
          const result = await extractor.extract(fullPaths, profile, workDir)

          return {
            status: "ok",
            data: {
              filesExtracted: files.length,
              signatures: result.signatures,
              types: result.types,
            },
          }
        },
      },

      {
        id: "generate-tests",
        name: "Generate Adversarial Tests",
        type: "agentic",
        agent: "boundary-tester",
      },

      {
        id: "write-tests",
        name: "Write Adversarial Test Files",
        type: "deterministic",
        execute: async (ctx: PipelineContext): Promise<NodeResult> => {
          const testerResult = ctx.results["generate-tests"]
          const testerOutput = typeof testerResult?.data === "string" ? testerResult.data : ""

          if (!testerOutput) {
            return {
              status: "fail",
              error: {
                code: "NODE_EXECUTION_FAILED",
                message: "No test output from boundary-tester agent",
              },
            }
          }

          const files = getAffectedSourceFiles(ctx)
          const leakedTokens: string[] = []

          for (const filePath of files) {
            try {
              const source = await readFile(resolve(workDir, filePath), "utf-8")
              const privateIds = extractPrivateIdentifiers(filePath, source)
              for (const id of privateIds) {
                if (testerOutput.includes(id)) {
                  leakedTokens.push(id)
                }
              }
            } catch {
              // File might not exist yet (newly created) — skip
            }
          }

          if (leakedTokens.length > 0) {
            const unique = [...new Set(leakedTokens)]
            throw new BollardError({
              code: "POSTCONDITION_FAILED",
              message: `Information leak detected in adversarial tests: [${unique.join(", ")}]`,
              context: { leakedTokens: unique, sourceFiles: files },
            })
          }

          const firstFile = files[0]
          if (!firstFile) {
            return {
              status: "fail",
              error: {
                code: "NODE_EXECUTION_FAILED",
                message: "No affected files to generate tests for",
              },
            }
          }

          const testPath = deriveAdversarialTestPath(firstFile, ctx.toolchainProfile, "boundary")
          const cleanOutput = stripMarkdownFences(testerOutput)
          const lang = ctx.toolchainProfile?.language
          let toWrite = cleanOutput
          if (lang === "java" || lang === "kotlin") {
            const ext = lang === "java" ? ".java" : ".kt"
            const expectedClass = basename(testPath, ext)
            toWrite = normalizeJvmWrittenTestClassName(cleanOutput, expectedClass, lang)
            if (lang === "java") {
              toWrite = sanitizeJavaPrimitiveInstanceofMisuse(toWrite)
            }
          }
          const fullPath = resolve(workDir, testPath)
          await mkdir(dirname(fullPath), { recursive: true })
          await writeFile(fullPath, toWrite, "utf-8")
          await formatGeneratedAdversarialTestFile(ctx, workDir, fullPath)

          return {
            status: "ok",
            data: { testFile: testPath, bytesWritten: toWrite.length },
          }
        },
      },

      {
        id: "run-tests",
        name: "Run Tests",
        type: "deterministic",
        onFailure: "skip",
        execute: async (ctx: PipelineContext): Promise<NodeResult> => {
          const result = await runTests(workDir, undefined, ctx.toolchainProfile)
          if (result.failed > 0) {
            return {
              status: "fail",
              data: result,
              error: {
                code: "TEST_FAILED",
                message: `${result.failed}/${result.total} tests failed: ${result.failedTests.join(", ")}`,
              },
            }
          }
          return { status: "ok", data: result }
        },
      },

      {
        id: "assess-contract-risk",
        name: "Assess Contract Risk",
        type: "deterministic",
        execute: async (ctx: PipelineContext): Promise<NodeResult> => {
          const profile = ctx.toolchainProfile

          if (profile?.adversarial.contract.enabled !== true) {
            ctx.log.info("contract_scope_decision", {
              event: "contract_scope_decision",
              runId: ctx.runId,
              decision: "skipped-by-profile",
              riskLevel: "n/a",
              touchesExportedSymbols: false,
              skipContract: true,
            })
            return {
              status: "ok",
              data: { skipContract: true, reason: "contract scope disabled in profile" },
            }
          }

          const plan = ctx.plan as { risk_assessment?: { level?: unknown } } | undefined
          const riskLevel =
            typeof plan?.risk_assessment?.level === "string"
              ? plan.risk_assessment.level.toLowerCase()
              : "unknown"
          const touchesExportedSymbols = await hasExportedSymbolChanges(
            workDir,
            profile,
            ctx.log.warn,
          )
          const skipContract = riskLevel === "low" && !touchesExportedSymbols

          const decision = skipContract ? "skipped-by-risk-gate" : "run"
          ctx.log.info("contract_scope_decision", {
            event: "contract_scope_decision",
            runId: ctx.runId,
            decision,
            riskLevel,
            touchesExportedSymbols,
            skipContract,
          })

          return {
            status: "ok",
            data: { skipContract, riskLevel, touchesExportedSymbols },
          }
        },
      },

      {
        id: "extract-contracts",
        name: "Extract Contract Graph",
        type: "deterministic",
        execute: async (ctx: PipelineContext): Promise<NodeResult> => {
          const profile = ctx.toolchainProfile
          if (!profile?.adversarial.contract.enabled) {
            return { status: "ok", data: { skipped: true, reason: "contract scope disabled" } }
          }
          const riskGate = ctx.results["assess-contract-risk"]?.data as
            | { skipContract?: boolean }
            | undefined
          if (riskGate?.skipContract) {
            return { status: "ok", data: { skipped: true, reason: "risk-gate" } }
          }
          const affected = getAffectedSourceFiles(ctx)
          const contract = await buildContractContext(affected, profile, workDir, ctx.log.warn)
          return { status: "ok", data: { contract } }
        },
      },

      {
        id: "generate-contract-tests",
        name: "Generate Contract Tests",
        type: "agentic",
        agent: "contract-tester",
      },

      {
        id: "verify-claim-grounding",
        name: "Verify Claim Grounding",
        type: "deterministic",
        execute: async (ctx: PipelineContext): Promise<NodeResult> => {
          const profile = ctx.toolchainProfile
          if (!profile?.adversarial.contract.enabled) {
            ctx.log.info("contract_grounding_result", {
              event: "contract_grounding_result",
              runId: ctx.runId,
              language: ctx.toolchainProfile?.language ?? "unknown",
              proposed: 0,
              grounded: 0,
              dropped: 0,
              dropRate: 0,
              droppedSymbols: [],
            })
            return { status: "ok", data: { skipped: true, reason: "contract scope disabled" } }
          }
          const riskGate = ctx.results["assess-contract-risk"]?.data as
            | { skipContract?: boolean }
            | undefined
          if (riskGate?.skipContract) {
            ctx.log.info("contract_grounding_result", {
              event: "contract_grounding_result",
              runId: ctx.runId,
              language: ctx.toolchainProfile?.language ?? "unknown",
              proposed: 0,
              grounded: 0,
              dropped: 0,
              dropRate: 0,
              droppedSymbols: [],
            })
            return { status: "ok", data: { skipped: true, reason: "risk-gate" } }
          }

          const gen = ctx.results["generate-contract-tests"]
          const raw = typeof gen?.data === "string" ? gen.data : ""
          if (!raw.trim()) {
            ctx.log.info("contract_grounding_result", {
              event: "contract_grounding_result",
              runId: ctx.runId,
              language: ctx.toolchainProfile?.language ?? "unknown",
              proposed: 0,
              grounded: 0,
              dropped: 0,
              dropRate: 0,
              droppedSymbols: [],
            })
            return { status: "ok", data: { skipped: true, reason: "no contract test output" } }
          }

          // Contract context is stashed on the extract-contracts node result — no new PipelineContext fields needed
          const extractRes = ctx.results["extract-contracts"]?.data as
            | { contract?: ContractContext }
            | undefined
          const contract = extractRes?.contract ?? {
            modules: [],
            edges: [],
            affectedEdges: [],
          }

          const plan = ctx.plan as Record<string, unknown> | undefined
          const planSummary =
            typeof plan?.["summary"] === "string" ? (plan["summary"] as string) : undefined
          const corpus = contractContextToCorpus(contract, planSummary)

          const concerns = profile.adversarial.contract.concerns
          const enabled: EnabledConcerns = {
            correctness: concerns.correctness !== "off",
            security: concerns.security !== "off",
            performance: concerns.performance !== "off",
            resilience: concerns.resilience !== "off",
          }

          try {
            const doc = parseClaimDocument(raw)
            const result = verifyClaimGrounding(doc, corpus, enabled)

            const proposed = doc.claims.length
            const grounded = result.kept.length
            const droppedCount = result.dropped.length
            const dropRate =
              proposed === 0 ? 0 : Math.round((droppedCount / proposed) * 1000) / 1000
            const droppedSymbols = [...new Set(result.dropped.map((d) => d.id))].sort()

            ctx.log.info("contract_grounding_result", {
              event: "contract_grounding_result",
              runId: ctx.runId,
              language: ctx.toolchainProfile?.language ?? "unknown",
              proposed,
              grounded,
              dropped: droppedCount,
              dropRate,
              droppedSymbols,
            })

            return {
              status: "ok",
              data: { claims: result.kept, dropped: result.dropped },
            }
          } catch (err: unknown) {
            if (BollardError.is(err)) {
              return {
                status: "fail",
                error: { code: err.code, message: err.message },
              }
            }
            return {
              status: "fail",
              error: {
                code: "NODE_EXECUTION_FAILED",
                message: err instanceof Error ? err.message : String(err),
              },
            }
          }
        },
      },

      {
        id: "write-contract-tests",
        name: "Write Contract Test Files",
        type: "deterministic",
        execute: async (ctx: PipelineContext): Promise<NodeResult> => {
          const profile = ctx.toolchainProfile
          if (!profile?.adversarial.contract.enabled) {
            return { status: "ok", data: { skipped: true, reason: "contract scope disabled" } }
          }
          const riskGate = ctx.results["assess-contract-risk"]?.data as
            | { skipContract?: boolean }
            | undefined
          if (riskGate?.skipContract) {
            return { status: "ok", data: { skipped: true, reason: "risk-gate" } }
          }

          const verifyRes = ctx.results["verify-claim-grounding"]?.data as
            | { skipped?: boolean; claims?: ClaimRecord[] }
            | undefined
          if (verifyRes?.skipped || !verifyRes?.claims || verifyRes.claims.length === 0) {
            return {
              status: "ok",
              data: { skipped: true, reason: "no grounded claims" },
            }
          }

          const claims = verifyRes.claims
          const lang = profile.language ?? "typescript"

          const files = getAffectedSourceFiles(ctx)
          const firstFile = files[0]
          if (!firstFile) {
            return {
              status: "fail",
              error: {
                code: "NODE_EXECUTION_FAILED",
                message: "No affected files for contract tests",
              },
            }
          }

          // For JVM multi-module contract tests, the test must be placed in the consumer
          // module (the one that imports the provider) so it can compile against the edge's
          // imported symbols. Non-JVM / single-module cases fall through unchanged.
          const contractExtract = ctx.results["extract-contracts"]?.data as
            | { contract?: ContractContext }
            | undefined
          const contractSourceFile = resolveContractTestModulePrefix(
            firstFile,
            contractExtract?.contract,
            lang,
          )

          // Hoist import lines from claim test bodies into the preamble
          const hoistedImports = new Set<string>()
          const strippedBodies: string[] = []
          for (const c of claims) {
            const lines = c.test.split("\n")
            const bodyLines: string[] = []
            for (const line of lines) {
              if (line.trimStart().startsWith("import ")) {
                hoistedImports.add(line.trim())
              } else {
                bodyLines.push(line)
              }
            }
            const body = bodyLines.join("\n").trim()
            if (body.length > 0) strippedBodies.push(body)
          }

          let preamble: string
          let wrapStart: string
          let wrapEnd: string
          if (lang === "python") {
            preamble = "import pytest\n"
            wrapStart = ""
            wrapEnd = ""
          } else if (lang === "java" || lang === "kotlin") {
            const ext = lang === "java" ? "java" : "kt"
            const derivedRel = deriveAdversarialTestPath(contractSourceFile, profile, "contract")
            const simpleName = basename(derivedRel, `.${ext}`)
            const pkg = inferJvmPackageFromMainSource(contractSourceFile)
            const importLines = [...hoistedImports].sort().join("\n")
            if (lang === "java") {
              const jUnitImports =
                "import org.junit.jupiter.api.Test;\nimport static org.junit.jupiter.api.Assertions.*;"
              preamble = pkg
                ? `package ${pkg};\n\n${jUnitImports}\n${importLines}\n`
                : `${jUnitImports}\n${importLines}\n`
            } else {
              preamble = pkg ? `package ${pkg};\n\n${importLines}\n` : `${importLines}\n`
            }
            wrapStart =
              lang === "java" ? `\npublic class ${simpleName} {\n` : `\nclass ${simpleName} {\n`
            wrapEnd = "\n}\n"
          } else {
            const vitestImport = 'import { describe, it, expect, vi } from "vitest"'
            const allImports = [vitestImport, ...hoistedImports].join("\n")
            preamble = `${allImports}\n`
            wrapStart = '\ndescribe("contract tests", () => {\n'
            wrapEnd = "\n})\n"
          }

          let testBodies = strippedBodies.join("\n\n")
          if (lang === "java" && testBodies.includes("it(")) {
            testBodies = jvmContractCoerceVitestItToJUnit5(testBodies)
          }
          const fileContent = `${preamble}${wrapStart}${testBodies}${wrapEnd}`

          const leakedTokens: string[] = []
          for (const filePath of files) {
            try {
              const source = await readFile(resolve(workDir, filePath), "utf-8")
              if (!filePath.endsWith(".ts") && !filePath.endsWith(".tsx")) continue
              const privateIds = extractPrivateIdentifiers(filePath, source)
              for (const id of privateIds) {
                if (fileContent.includes(id)) leakedTokens.push(id)
              }
            } catch {
              /* skip */
            }
          }
          if (leakedTokens.length > 0) {
            const unique = [...new Set(leakedTokens)]
            throw new BollardError({
              code: "POSTCONDITION_FAILED",
              message: `Information leak in contract tests: [${unique.join(", ")}]`,
              context: { leakedTokens: unique },
            })
          }

          const derivedRel = deriveAdversarialTestPath(contractSourceFile, profile, "contract")
          const testPath = resolveContractTestOutputRel({
            runId: ctx.runId,
            task: ctx.task,
            derivedRelativePath: derivedRel,
            lifecycle: profile.adversarial.contract.lifecycle,
          })
          const fullPath = resolve(workDir, testPath)
          await mkdir(dirname(fullPath), { recursive: true })
          await writeFile(fullPath, fileContent, "utf-8")
          await formatGeneratedAdversarialTestFile(ctx, workDir, fullPath)

          return {
            status: "ok",
            data: {
              testFile: testPath,
              bytesWritten: fileContent.length,
              claimCount: claims.length,
            },
          }
        },
      },

      {
        id: "run-contract-tests",
        name: "Run Contract Tests",
        type: "deterministic",
        execute: async (ctx: PipelineContext): Promise<NodeResult> => {
          const profile = ctx.toolchainProfile
          if (!profile?.adversarial.contract.enabled) {
            return { status: "ok", data: { skipped: true, reason: "contract scope disabled" } }
          }
          const riskGate = ctx.results["assess-contract-risk"]?.data as
            | { skipContract?: boolean }
            | undefined
          if (riskGate?.skipContract) {
            return { status: "ok", data: { skipped: true, reason: "risk-gate" } }
          }

          const writeRes = ctx.results["write-contract-tests"]?.data as
            | { skipped?: boolean; testFile?: string }
            | undefined
          if (writeRes?.skipped || !writeRes?.testFile) {
            return { status: "ok", data: { skipped: true, reason: "no contract tests written" } }
          }

          const result = await runTests(workDir, [writeRes.testFile], profile)
          if (result.failed > 0) {
            return {
              status: "fail",
              data: result,
              error: {
                code: "TEST_FAILED",
                message: `Contract tests failed: ${result.failedTests.join(", ") || "see output"}`,
              },
            }
          }
          return { status: "ok", data: result }
        },
      },

      {
        id: "extract-behavioral-context",
        name: "Extract Behavioral Context",
        type: "deterministic",
        execute: async (ctx: PipelineContext): Promise<NodeResult> => {
          const profile = ctx.toolchainProfile
          if (!profile?.adversarial.behavioral.enabled) {
            return { status: "ok", data: { skipped: true, reason: "behavioral scope disabled" } }
          }
          const behavioral = await buildBehavioralContext(profile, workDir, (m) =>
            ctx.log.warn(m, { nodeId: "extract-behavioral-context" }),
          )
          const empty = behavioral.endpoints.length === 0 && behavioral.dependencies.length === 0
          ctx.log.info("behavioral_context_result", {
            event: "behavioral_context_result",
            runId: ctx.runId,
            endpointCount: behavioral.endpoints.length,
            dependencyCount: behavioral.dependencies.length,
            empty,
          })
          if (empty) {
            return {
              status: "ok",
              data: {
                context: behavioral,
                skipBehavioral: true,
                reason: "BEHAVIORAL_CONTEXT_EMPTY",
              },
            }
          }
          return { status: "ok", data: { context: behavioral, skipBehavioral: false } }
        },
      },

      {
        id: "generate-behavioral-tests",
        name: "Generate Behavioral Tests",
        type: "agentic",
        agent: "behavioral-tester",
      },

      {
        id: "verify-behavioral-grounding",
        name: "Verify Behavioral Grounding",
        type: "deterministic",
        execute: async (ctx: PipelineContext): Promise<NodeResult> => {
          const profile = ctx.toolchainProfile
          if (!profile?.adversarial.behavioral.enabled) {
            return { status: "ok", data: { skipped: true, reason: "behavioral scope disabled" } }
          }
          const behRes = ctx.results["extract-behavioral-context"]?.data as
            | {
                skipped?: boolean
                skipBehavioral?: boolean
                context?: BehavioralContext
                reason?: string
              }
            | undefined
          if (behRes?.skipped || behRes?.skipBehavioral) {
            return {
              status: "ok",
              data: { skipped: true, reason: behRes?.reason ?? "behavioral skip" },
            }
          }

          const gen = ctx.results["generate-behavioral-tests"]
          const raw = typeof gen?.data === "string" ? gen.data : ""
          if (!raw.trim()) {
            return { status: "ok", data: { skipped: true, reason: "no behavioral test output" } }
          }

          const behavioralCtx = behRes?.context ?? {
            endpoints: [],
            config: [],
            dependencies: [],
            failureModes: [],
          }
          const corpus = behavioralContextToCorpus(behavioralCtx)
          const concerns = profile.adversarial.behavioral.concerns
          const enabled: EnabledConcerns = {
            correctness: concerns.correctness !== "off",
            security: concerns.security !== "off",
            performance: concerns.performance !== "off",
            resilience: concerns.resilience !== "off",
          }

          try {
            const doc = parseClaimDocument(raw, { invalidCode: "BEHAVIORAL_TESTER_OUTPUT_INVALID" })
            const result = verifyClaimGrounding(doc, corpus, enabled, {
              noGroundedClaimsCode: "BEHAVIORAL_NO_GROUNDED_CLAIMS",
            })
            return {
              status: "ok",
              data: { claims: result.kept, dropped: result.dropped },
            }
          } catch (err: unknown) {
            if (BollardError.is(err)) {
              return {
                status: "fail",
                error: { code: err.code, message: err.message },
              }
            }
            return {
              status: "fail",
              error: {
                code: "NODE_EXECUTION_FAILED",
                message: err instanceof Error ? err.message : String(err),
              },
            }
          }
        },
      },

      {
        id: "write-behavioral-tests",
        name: "Write Behavioral Test Files",
        type: "deterministic",
        execute: async (ctx: PipelineContext): Promise<NodeResult> => {
          const profile = ctx.toolchainProfile
          if (!profile?.adversarial.behavioral.enabled) {
            return { status: "ok", data: { skipped: true, reason: "behavioral scope disabled" } }
          }
          const behRes = ctx.results["extract-behavioral-context"]?.data as
            | { skipBehavioral?: boolean; skipped?: boolean }
            | undefined
          if (behRes?.skipped || behRes?.skipBehavioral) {
            return { status: "ok", data: { skipped: true, reason: "behavioral skip" } }
          }

          const verifyRes = ctx.results["verify-behavioral-grounding"]?.data as
            | { skipped?: boolean; claims?: ClaimRecord[] }
            | undefined
          if (verifyRes?.skipped || !verifyRes?.claims || verifyRes.claims.length === 0) {
            return {
              status: "ok",
              data: { skipped: true, reason: "no grounded behavioral claims" },
            }
          }

          const claims = verifyRes.claims
          const lang = profile.language ?? "typescript"

          const hoistedImports = new Set<string>()
          const strippedBodies: string[] = []
          for (const c of claims) {
            const lines = c.test.split("\n")
            const bodyLines: string[] = []
            for (const line of lines) {
              if (line.trimStart().startsWith("import ")) {
                hoistedImports.add(line.trim())
              } else {
                bodyLines.push(line)
              }
            }
            const body = bodyLines.join("\n").trim()
            if (body.length > 0) strippedBodies.push(body)
          }

          let preamble: string
          let wrapStart: string
          let wrapEnd: string
          if (lang === "python") {
            preamble = "import pytest\n"
            wrapStart = ""
            wrapEnd = ""
          } else {
            const vitestImport = 'import { describe, it, expect, vi } from "vitest"'
            const allImports = [vitestImport, ...hoistedImports].join("\n")
            preamble = `${allImports}\n`
            wrapStart = '\ndescribe("behavioral tests", () => {\n'
            wrapEnd = "\n})\n"
          }

          const testBodies = strippedBodies.join("\n\n")
          const fileContent = `${preamble}${wrapStart}${testBodies}${wrapEnd}`

          const files = getAffectedSourceFiles(ctx)
          const leakedTokens: string[] = []
          for (const filePath of files) {
            try {
              const source = await readFile(resolve(workDir, filePath), "utf-8")
              if (!filePath.endsWith(".ts") && !filePath.endsWith(".tsx")) continue
              const privateIds = extractPrivateIdentifiers(filePath, source)
              for (const id of privateIds) {
                if (fileContent.includes(id)) leakedTokens.push(id)
              }
            } catch {
              /* skip */
            }
          }
          if (leakedTokens.length > 0) {
            const unique = [...new Set(leakedTokens)]
            throw new BollardError({
              code: "POSTCONDITION_FAILED",
              message: `Information leak in behavioral tests: [${unique.join(", ")}]`,
              context: { leakedTokens: unique },
            })
          }

          const firstFile = files[0]
          if (!firstFile) {
            return {
              status: "fail",
              error: {
                code: "NODE_EXECUTION_FAILED",
                message: "No affected files for behavioral tests",
              },
            }
          }

          const derivedRel = deriveAdversarialTestPath(firstFile, profile, "behavioral")
          const testPath = resolveBehavioralTestOutputRel({
            runId: ctx.runId,
            task: ctx.task,
            derivedRelativePath: derivedRel,
            lifecycle: profile.adversarial.behavioral.lifecycle,
          })
          const fullPath = resolve(workDir, testPath)
          await mkdir(dirname(fullPath), { recursive: true })
          await writeFile(fullPath, fileContent, "utf-8")
          await formatGeneratedAdversarialTestFile(ctx, workDir, fullPath)

          return {
            status: "ok",
            data: {
              testFile: testPath,
              bytesWritten: fileContent.length,
              claimCount: claims.length,
            },
          }
        },
      },

      {
        id: "run-behavioral-tests",
        name: "Run Behavioral Tests",
        type: "deterministic",
        execute: async (ctx: PipelineContext): Promise<NodeResult> => {
          const profile = ctx.toolchainProfile
          if (!profile?.adversarial.behavioral.enabled) {
            return { status: "ok", data: { skipped: true, reason: "behavioral scope disabled" } }
          }
          const behRes = ctx.results["extract-behavioral-context"]?.data as
            | { skipBehavioral?: boolean; skipped?: boolean; context?: BehavioralContext }
            | undefined
          if (behRes?.skipped || behRes?.skipBehavioral) {
            return { status: "ok", data: { skipped: true, reason: "behavioral skip" } }
          }

          const writeRes = ctx.results["write-behavioral-tests"]?.data as
            | { skipped?: boolean; testFile?: string }
            | undefined
          if (writeRes?.skipped || !writeRes?.testFile) {
            return { status: "ok", data: { skipped: true, reason: "no behavioral tests written" } }
          }

          const composePath = resolve(workDir, ".bollard", "compose.behavioral.yml")
          try {
            const behavioralCtx = behRes?.context ?? {
              endpoints: [],
              config: [],
              dependencies: [],
              failureModes: [],
            }
            const compose = await generateBehavioralCompose({
              workDir,
              profile,
              behavioralContext: behavioralCtx,
              behavioralTestRelPath: writeRes.testFile,
            })
            await mkdir(dirname(composePath), { recursive: true })
            await writeFile(composePath, compose.yaml, "utf-8")
          } catch (err: unknown) {
            ctx.log.warn("behavioral_compose_write_failed", {
              message: err instanceof Error ? err.message : String(err),
            })
          }

          const result = await runTests(workDir, [writeRes.testFile], profile)
          if (result.failed > 0) {
            return {
              status: "fail",
              data: result,
              error: {
                code: "TEST_FAILED",
                message: `Behavioral tests failed: ${result.failedTests.join(", ") || "see output"}`,
              },
            }
          }
          return { status: "ok", data: result }
        },
      },

      {
        id: "extract-probes",
        name: "Extract Production Probes",
        type: "deterministic",
        execute: async (ctx: PipelineContext): Promise<NodeResult> => {
          const profile = ctx.toolchainProfile
          if (!profile?.adversarial.behavioral.enabled) {
            return { status: "ok", data: { skipped: true, reason: "behavioral scope disabled" } }
          }
          const behRes = ctx.results["extract-behavioral-context"]?.data as
            | { skipped?: boolean; skipBehavioral?: boolean; context?: BehavioralContext }
            | undefined
          if (behRes?.skipped || behRes?.skipBehavioral) {
            return { status: "ok", data: { skipped: true, reason: "behavioral skip" } }
          }

          const verifyRes = ctx.results["verify-behavioral-grounding"]?.data as
            | { skipped?: boolean; claims?: ClaimRecord[] }
            | undefined
          if (verifyRes?.skipped || !verifyRes?.claims || verifyRes.claims.length === 0) {
            return { status: "ok", data: { skipped: true, reason: "no behavioral claims" } }
          }

          const behavioralCtx = behRes?.context ?? {
            endpoints: [],
            config: [],
            dependencies: [],
            failureModes: [],
          }

          const probes = extractProbes(verifyRes.claims, behavioralCtx, ctx.runId)
          ctx.log.info("probe_extraction_result", {
            event: "probe_extraction_result",
            runId: ctx.runId,
            claimCount: verifyRes.claims.length,
            probeCount: probes.length,
          })

          if (probes.length === 0) {
            return {
              status: "ok",
              data: { skipped: true, reason: "no probe-eligible claims", eligibleCount: 0 },
            }
          }

          const probesDir = resolve(workDir, ".bollard", "probes")
          await mkdir(probesDir, { recursive: true })
          for (const p of probes) {
            const dest = resolve(probesDir, `${p.id}.json`)
            await writeFile(dest, `${JSON.stringify(p, null, 2)}\n`, "utf-8")
          }

          ctx.generatedProbes = probes

          return {
            status: "ok",
            data: { probeCount: probes.length, probeIds: probes.map((x) => x.id) },
            probes,
          }
        },
      },

      {
        id: "run-mutation-testing",
        name: "Mutation Testing",
        type: "deterministic",
        execute: async (ctx: PipelineContext): Promise<NodeResult> => {
          const profile = ctx.toolchainProfile
          if (!profile?.mutation?.enabled) {
            return {
              status: "ok",
              data: { skipped: true, reason: "mutation testing not enabled" },
            }
          }

          const affectedFiles = getAffectedSourceFiles(ctx)

          const startMs = Date.now()
          const result = await runMutationTesting(
            workDir,
            profile,
            affectedFiles.length > 0 ? affectedFiles : undefined,
          )
          ctx.mutationScore = result.score

          ctx.log.info("mutation_testing_result", {
            event: "mutation_testing_result",
            runId: ctx.runId,
            score: result.score,
            killed: result.killed,
            survived: result.survived,
            noCoverage: result.noCoverage,
            timeout: result.timeout,
            totalMutants: result.totalMutants,
            duration_ms: result.duration_ms,
            scopedToFiles: affectedFiles.length > 0,
            affectedFileCount: affectedFiles.length,
          })

          const threshold = profile.mutation.threshold
          if (result.totalMutants > 0 && result.score < threshold) {
            return {
              status: "fail",
              data: result,
              error: {
                code: "MUTATION_THRESHOLD_NOT_MET",
                message: `Mutation score ${result.score.toFixed(1)}% is below threshold ${threshold}% (${result.survived} survived, ${result.noCoverage} no coverage)`,
              },
            }
          }

          return {
            status: "ok",
            data: result,
            cost_usd: 0,
            duration_ms: Date.now() - startMs,
          }
        },
      },

      {
        id: "generate-review-diff",
        name: "Generate Review Diff",
        type: "deterministic",
        execute: async (ctx: PipelineContext): Promise<NodeResult> => {
          try {
            const { stdout } = await execFileAsync("git", ["diff", "main"], {
              cwd: workDir,
              maxBuffer: 4 * 1024 * 1024,
            })
            return {
              status: "ok",
              data: { diff: stdout, plan: ctx.plan },
            }
          } catch (err: unknown) {
            return {
              status: "fail",
              error: {
                code: "NODE_EXECUTION_FAILED",
                message: err instanceof Error ? err.message : String(err),
              },
            }
          }
        },
      },

      {
        id: "semantic-review",
        name: "Semantic Review",
        type: "agentic",
        agent: "semantic-reviewer",
      },

      {
        id: "verify-review-grounding",
        name: "Verify Review Grounding",
        type: "deterministic",
        execute: async (ctx: PipelineContext): Promise<NodeResult> => {
          const gen = ctx.results["semantic-review"]
          const raw = typeof gen?.data === "string" ? gen.data : ""
          const diffRes = ctx.results["generate-review-diff"]?.data as { diff?: string } | undefined
          const diffText = diffRes?.diff ?? ""

          if (!raw.trim()) {
            ctx.log.info("semantic_review_result", {
              event: "semantic_review_result",
              runId: ctx.runId,
              proposed: 0,
              kept: 0,
              dropped: 0,
              dropRate: 0,
              severityCounts: { info: 0, warning: 0, error: 0 },
            })
            return { status: "ok", data: { findings: [] as ReviewFinding[] } }
          }

          let doc: ReviewDocument
          try {
            doc = parseReviewDocument(raw)
          } catch (err: unknown) {
            if (BollardError.is(err)) {
              ctx.log.warn("semantic_review_parse_failed", {
                event: "semantic_review_parse_failed",
                runId: ctx.runId,
                code: err.code,
                message: err.message,
              })
            }
            return { status: "ok", data: { findings: [] as ReviewFinding[] } }
          }

          const corpus = buildReviewCorpus(diffText, ctx.plan)
          const result = verifyReviewGrounding(doc, corpus)

          const proposed = doc.findings.length
          const keptCount = result.kept.length
          const droppedCount = result.dropped.length
          const dropRate = proposed === 0 ? 0 : Math.round((droppedCount / proposed) * 1000) / 1000

          const severityCounts = { info: 0, warning: 0, error: 0 }
          for (const f of result.kept) {
            if (f.severity === "info") severityCounts.info++
            else if (f.severity === "warning") severityCounts.warning++
            else if (f.severity === "error") severityCounts.error++
          }

          ctx.log.info("semantic_review_result", {
            event: "semantic_review_result",
            runId: ctx.runId,
            proposed,
            kept: keptCount,
            dropped: droppedCount,
            dropRate,
            severityCounts,
          })

          return {
            status: "ok",
            data: { findings: result.kept },
          }
        },
      },

      {
        id: "docker-verify",
        name: "Docker-Isolated Verification",
        type: "deterministic",
        execute: async (ctx: PipelineContext): Promise<NodeResult> => {
          const profile = ctx.toolchainProfile
          if (!profile) {
            return { status: "ok", data: { skipped: true, reason: "no toolchain profile" } }
          }

          try {
            await execFileAsync("docker", ["compose", "version"], { cwd: workDir })
          } catch {
            return { status: "ok", data: { skipped: true, reason: "docker not available" } }
          }

          const compose = generateVerifyCompose({
            workDir,
            profile,
          })

          const composePath = resolve(workDir, ".bollard", "compose.verify.yml")
          await mkdir(dirname(composePath), { recursive: true })
          await writeFile(composePath, compose.yaml, "utf-8")

          try {
            const { stdout } = await execFileAsync(
              "docker",
              ["compose", "-f", composePath, "up", "--abort-on-container-exit"],
              { cwd: workDir, maxBuffer: 4 * 1024 * 1024 },
            )
            return {
              status: "ok",
              data: { services: compose.services, output: stdout },
            }
          } catch (err: unknown) {
            return {
              status: "fail",
              data: { services: compose.services },
              error: {
                code: "TEST_FAILED",
                message: `Docker verification failed: ${err instanceof Error ? err.message : String(err)}`,
              },
            }
          }
        },
      },

      {
        id: "generate-diff",
        name: "Generate Diff Summary",
        type: "deterministic",
        execute: async (): Promise<NodeResult> => {
          try {
            const { stdout } = await execFileAsync("git", ["diff", "--stat", "main"], {
              cwd: workDir,
              maxBuffer: 2 * 1024 * 1024,
            })
            return { status: "ok", data: { diff: stdout } }
          } catch (err: unknown) {
            return {
              status: "fail",
              error: {
                code: "NODE_EXECUTION_FAILED",
                message: err instanceof Error ? err.message : String(err),
              },
            }
          }
        },
      },

      {
        id: "approve-pr",
        name: "Review & Approve Changes",
        type: "human_gate",
      },
    ],
    maxCostUsd: 15,
    maxDurationMinutes: 30,
  }
}
