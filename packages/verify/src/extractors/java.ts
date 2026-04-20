import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { promisify } from "node:util"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import type {
  ExtractedSignature,
  ExtractedTypeDefinition,
  ExtractionResult,
  SignatureExtractor,
} from "../type-extractor.js"

const execFileAsync = promisify(execFile)

const HELPER = "bollard-extract-java"

function filterUnderWorkDir(
  files: string[],
  workDir: string | undefined,
  warn?: (m: string) => void,
): string[] {
  if (!workDir) return files
  const root = resolve(workDir)
  const out: string[] = []
  for (const f of files) {
    const abs = resolve(f)
    const rel = relative(root, abs)
    if (rel.startsWith("..")) {
      warn?.(`JavaParserExtractor: skipping path outside workDir: ${f}`)
      continue
    }
    out.push(abs)
  }
  return out
}

function parseHelperOutput(stdout: string, warn?: (msg: string) => void): ExtractionResult {
  try {
    const parsed = JSON.parse(stdout) as {
      signatures?: ExtractedSignature[]
      types?: ExtractedTypeDefinition[]
      warnings?: string[]
    }
    if (parsed.warnings) {
      for (const w of parsed.warnings) warn?.(`JavaParserExtractor: ${w}`)
    }
    return {
      signatures: parsed.signatures ?? [],
      types: parsed.types ?? [],
    }
  } catch {
    warn?.("JavaParserExtractor: failed to parse JSON from helper")
    return { signatures: [], types: [] }
  }
}

function isExecNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  )
}

async function runHelper(
  files: string[],
  cwd: string,
  extraArgs: string[],
  warn?: (msg: string) => void,
): Promise<ExtractionResult> {
  const jarPath = process.env["BOLLARD_EXTRACT_JAVA_JAR"]
  try {
    if (jarPath && existsSync(jarPath)) {
      const { stdout } = await execFileAsync("java", ["-jar", jarPath, ...extraArgs, ...files], {
        cwd,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 60_000,
      })
      return parseHelperOutput(stdout, warn)
    }
    const { stdout } = await execFileAsync(HELPER, [...extraArgs, ...files], {
      cwd,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60_000,
    })
    return parseHelperOutput(stdout, warn)
  } catch (err) {
    if (isExecNotFound(err)) {
      warn?.(
        "JavaParserExtractor: bollard-extract-java not found on PATH (and no BOLLARD_EXTRACT_JAVA_JAR)",
      )
    } else {
      warn?.(`JavaParserExtractor: ${err instanceof Error ? err.message : String(err)}`)
    }
    return { signatures: [], types: [] }
  }
}

export class JavaParserExtractor implements SignatureExtractor {
  constructor(private readonly warn?: (msg: string) => void) {}

  async extract(
    files: string[],
    _profile?: ToolchainProfile,
    workDir?: string,
  ): Promise<ExtractionResult> {
    const safe = filterUnderWorkDir(files, workDir, this.warn)
    if (safe.length === 0) return { signatures: [], types: [] }

    const javaFiles = safe.filter((f) => f.endsWith(".java"))
    const ktFiles = safe.filter((f) => f.endsWith(".kt"))
    const classFiles = safe.filter((f) => f.endsWith(".class"))

    const first = safe[0]
    const cwd = workDir ? resolve(workDir) : dirname(first ?? ".")

    const merged: ExtractionResult = { signatures: [], types: [] }

    if (javaFiles.length > 0) {
      const r = await runHelper(javaFiles, cwd, [], this.warn)
      merged.signatures.push(...r.signatures)
      merged.types.push(...r.types)
    }
    if (ktFiles.length > 0) {
      const r = await runHelper(ktFiles, cwd, ["--kotlin"], this.warn)
      merged.signatures.push(...r.signatures)
      merged.types.push(...r.types)
    }
    if (classFiles.length > 0) {
      const r = await runHelper(classFiles, cwd, ["--bytecode"], this.warn)
      merged.signatures.push(...r.signatures)
      merged.types.push(...r.types)
    }

    return merged
  }
}
