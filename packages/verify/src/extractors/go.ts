import { execFile } from "node:child_process"
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

const HELPER = "bollard-extract-go"

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
      warn?.(`GoAstExtractor: skipping path outside workDir: ${f}`)
      continue
    }
    out.push(abs)
  }
  return out
}

export class GoAstExtractor implements SignatureExtractor {
  constructor(private readonly warn?: (msg: string) => void) {}

  async extract(
    files: string[],
    _profile?: ToolchainProfile,
    workDir?: string,
  ): Promise<ExtractionResult> {
    const safe = filterUnderWorkDir(files, workDir, this.warn)
    if (safe.length === 0) return { signatures: [], types: [] }
    try {
      // The Go helper resolves caller-relative paths against its own
      // os.Getwd(), so we must launch it with cwd === workDir. The
      // dirname(first) fallback only works when all files share a parent;
      // if a future caller passes Go files from sibling packages without
      // a workDir, the helper will reject everything outside that dirname.
      // TODO(stage-3b): assert workDir is always set, or compute a common
      // ancestor across `safe` instead of leaning on safe[0].
      const first = safe[0]
      const cwd = workDir ? resolve(workDir) : dirname(first ?? ".")
      const { stdout } = await execFileAsync(HELPER, safe, {
        cwd,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 60_000,
      })
      const parsed = JSON.parse(stdout) as {
        signatures?: ExtractedSignature[]
        types?: ExtractedTypeDefinition[]
        warnings?: string[]
      }
      if (parsed.warnings) {
        for (const w of parsed.warnings) this.warn?.(`GoAstExtractor: ${w}`)
      }
      return {
        signatures: parsed.signatures ?? [],
        types: parsed.types ?? [],
      }
    } catch (err) {
      this.warn?.(
        `GoAstExtractor: ${err instanceof Error ? err.message : String(err)} — is bollard-extract-go on PATH?`,
      )
      return { signatures: [], types: [] }
    }
  }
}
