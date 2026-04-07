import { execFile } from "node:child_process"
import { relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import type { ToolchainProfile } from "@bollard/detect/src/types.js"
import type {
  ExtractedSignature,
  ExtractedTypeDefinition,
  ExtractionResult,
  SignatureExtractor,
} from "../type-extractor.js"

const execFileAsync = promisify(execFile)

const SCRIPT = fileURLToPath(new URL("../../scripts/extract_python.py", import.meta.url))

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
      warn?.(`PythonAstExtractor: skipping path outside workDir: ${f}`)
      continue
    }
    out.push(abs)
  }
  return out
}

export class PythonAstExtractor implements SignatureExtractor {
  constructor(private readonly warn?: (msg: string) => void) {}

  async extract(
    files: string[],
    _profile?: ToolchainProfile,
    workDir?: string,
  ): Promise<ExtractionResult> {
    const safe = filterUnderWorkDir(files, workDir, this.warn)
    if (safe.length === 0) {
      return { signatures: [], types: [] }
    }
    try {
      const { stdout } = await execFileAsync("python3", [SCRIPT, ...safe], {
        maxBuffer: 8 * 1024 * 1024,
        timeout: 60_000,
      })
      const parsed = JSON.parse(stdout) as {
        signatures?: ExtractedSignature[]
        types?: ExtractedTypeDefinition[]
      }
      return {
        signatures: parsed.signatures ?? [],
        types: parsed.types ?? [],
      }
    } catch (err) {
      this.warn?.(
        `PythonAstExtractor: ${err instanceof Error ? err.message : String(err)} — is python3 installed?`,
      )
      return { signatures: [], types: [] }
    }
  }
}
